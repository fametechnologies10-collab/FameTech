/**
 * Tests for lib/admin-sms-broadcast.ts — the create/dispatch/status library
 * driving the admin_sms_broadcasts / admin_sms_broadcast_recipients tables
 * and their claim/increment RPCs (see supabase/migrations/20261019_admin_sms_broadcast_queue.sql).
 *
 * Runs against the real (live) Supabase project — no local Supabase stack in
 * this repo. `sendFn` is always a fake/stub here; the real sendSMS is never
 * called, so no real SMS is ever sent by this script.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
 * TEST_ADMIN_USER_ID (a real users.id row, for the admin_sms_broadcasts
 * created_by FK) in the environment — load via .env.local, e.g.:
 *
 *   npx tsx --env-file=.env.local scripts/test-admin-sms-broadcast.ts
 */
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
    createAdminSmsBroadcast,
    getAdminSmsBroadcastStatus,
    dispatchAdminSmsBroadcastChunk,
    verifyAdminSmsBroadcast,
    retryFailedAdminSmsBroadcast,
    listRecentAdminSmsBroadcasts,
} from '../lib/admin-sms-broadcast'
import { listKingFlexyFailedCampaignIds } from '../lib/kingflexy-campaigns'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

const testAdminId = process.env.TEST_ADMIN_USER_ID
if (!testAdminId) {
    console.error('TEST_ADMIN_USER_ID env var is required (a real users.id row).')
    process.exit(1)
}

function assertOk(condition: boolean, label: string) {
    if (condition) {
        console.log(`PASS  ${label}`)
    } else {
        console.error(`FAIL  ${label}`)
        process.exitCode = 1
    }
}

async function assertRejects(fn: () => Promise<unknown>, label: string) {
    try {
        await fn()
        console.error(`FAIL  ${label} (did not throw)`)
        process.exitCode = 1
    } catch {
        console.log(`PASS  ${label}`)
    }
}

const createdBroadcastIds: string[] = []

async function trackedCreate(params: Parameters<typeof createAdminSmsBroadcast>[1]) {
    const result = await createAdminSmsBroadcast(supabase, params)
    createdBroadcastIds.push(result.broadcastId)
    return result
}

async function main() {
    // 1. createAdminSmsBroadcast rejects empty recipients
    await assertRejects(
        () => createAdminSmsBroadcast(supabase, { createdBy: testAdminId!, message: 'hi', audienceType: 'users', recipients: [] }),
        'createAdminSmsBroadcast throws on empty recipients',
    )

    // 2. create + full dispatch loop with a fake sender marks everything 'sent'
    const fakeSendAllOk = async () => ({ success: true, messageId: 'fake-1' })
    const { broadcastId, total } = await trackedCreate({
        createdBy: testAdminId!, message: 'hi [FirstName]', audienceType: 'users',
        recipients: [{ phone: '233244000001', resolvedMessage: 'hi Kwame' }, { phone: '233244000002', resolvedMessage: 'hi Efua' }],
    })
    assertOk(total === 2, 'createAdminSmsBroadcast returns total=2')
    let status = await dispatchAdminSmsBroadcastChunk(supabase, broadcastId, fakeSendAllOk)
    assertOk(status?.status === 'done' && status.sentCount === 2 && status.failedCount === 0, 'full chunk dispatch marks broadcast done with 2 sent')

    // 3. a failing sendFn marks the row failed with its error persisted, not just counted
    const fakeSendFail = async () => ({ success: false, error: 'provider exploded' })
    const b2 = await trackedCreate({ createdBy: testAdminId!, message: 'x', audienceType: 'users', recipients: [{ phone: '233244000003', resolvedMessage: 'x' }] })
    const status2 = await dispatchAdminSmsBroadcastChunk(supabase, b2.broadcastId, fakeSendFail)
    assertOk(status2?.failedCount === 1, 'failed send increments failedCount')
    const final2 = await getAdminSmsBroadcastStatus(supabase, b2.broadcastId)
    assertOk(final2?.failedSamples?.[0]?.error === 'provider exploded', 'failed recipient error message persisted and surfaced in failedSamples')

    // 4. dispatch on an already-done broadcast is a safe no-op
    const status3 = await dispatchAdminSmsBroadcastChunk(supabase, broadcastId, fakeSendAllOk)
    assertOk(status3?.status === 'done' && status3.sentCount === 2, 're-dispatching a done broadcast is a no-op, counts unchanged')

    // 5. unknown broadcastId returns null, not a throw
    const missing = await dispatchAdminSmsBroadcastChunk(supabase, randomUUID(), fakeSendAllOk)
    assertOk(missing === null, 'dispatch on unknown broadcastId returns null')
    const missingStatus = await getAdminSmsBroadcastStatus(supabase, randomUUID())
    assertOk(missingStatus === null, 'getStatus on unknown broadcastId returns null')

    // 6. concurrency: two simultaneous dispatch calls on the same broadcast never double-send the same recipient
    const b3 = await trackedCreate({
        createdBy: testAdminId!, message: 'x', audienceType: 'users',
        recipients: Array.from({ length: 6 }, (_, i) => ({ phone: `23324400001${i}`, resolvedMessage: 'x' })),
    })
    let callCount = 0
    const countingSend = async () => { callCount++; return { success: true, messageId: 'fake' } }
    const [c1, c2] = await Promise.all([
        dispatchAdminSmsBroadcastChunk(supabase, b3.broadcastId, countingSend),
        dispatchAdminSmsBroadcastChunk(supabase, b3.broadcastId, countingSend),
    ])
    void c1; void c2
    assertOk(callCount === 6, 'exactly 6 sends happened across both concurrent calls, no duplicates')

    // 7. abandoned 'sending' row (simulating a crashed dispatch) is reclaimed and sent
    const b4 = await trackedCreate({ createdBy: testAdminId!, message: 'x', audienceType: 'users', recipients: [{ phone: '233244000099', resolvedMessage: 'x' }] })
    await supabase.from('admin_sms_broadcast_recipients')
        .update({ status: 'sending', updated_at: new Date(Date.now() - 3 * 60_000).toISOString() })
        .eq('broadcast_id', b4.broadcastId)
    const status4 = await dispatchAdminSmsBroadcastChunk(supabase, b4.broadcastId, fakeSendAllOk)
    assertOk(status4?.status === 'done' && status4.sentCount === 1, 'a stale sending row older than 2 minutes is reclaimed and sent')

    // ── Verification RPCs (mark_admin_sms_broadcast_rejected / retry_failed_...) ──
    const REJECTED_ERR = 'Rejected by SMS provider after acceptance'
    const campaignFor: Record<string, string> = { '233244100001': 'camp-A', '233244100002': 'camp-B', '233244100003': 'camp-C' }
    const idSend = async (o: { recipient: string }) => ({ success: true, messageId: `${campaignFor[o.recipient]}-${o.recipient}` })
    const mk = async () => {
        const b = await trackedCreate({
            createdBy: testAdminId!, message: 'x', audienceType: 'users',
            recipients: Object.keys(campaignFor).map((phone) => ({ phone, resolvedMessage: 'x' })),
        })
        await dispatchAdminSmsBroadcastChunk(supabase, b.broadcastId, idSend)
        return b.broadcastId
    }
    const rowOf = async (id: string) => (await supabase.from('admin_sms_broadcasts').select('*').eq('id', id).single()).data as any
    const recOf = async (id: string, phone: string) =>
        (await supabase.from('admin_sms_broadcast_recipients').select('*').eq('broadcast_id', id).eq('phone', phone).single()).data as any

    // 8. mark_rejected flips only matching sent rows and recomputes counts
    const v1 = await mk()
    const m1 = await supabase.rpc('mark_admin_sms_broadcast_rejected', { p_broadcast_id: v1, p_campaign_ids: ['camp-B-233244100002'] })
    const m1row = Array.isArray(m1.data) ? m1.data[0] : m1.data
    assertOk(!m1.error && m1row?.sent_count === 2 && m1row?.failed_count === 1 && !!m1row?.verified_at, 'mark_rejected: sent 2 / failed 1 / verified_at set')
    const rej = await recOf(v1, '233244100002')
    assertOk(rej.status === 'failed' && rej.error === REJECTED_ERR, 'mark_rejected: rejected recipient is failed with the standard error text')
    assertOk((await recOf(v1, '233244100001')).status === 'sent', 'mark_rejected: non-matching recipient stays sent')

    // 9. empty id list still stamps verified_at and changes nothing
    const v2 = await mk()
    const m2 = await supabase.rpc('mark_admin_sms_broadcast_rejected', { p_broadcast_id: v2, p_campaign_ids: [] })
    const m2row = Array.isArray(m2.data) ? m2.data[0] : m2.data
    assertOk(!m2.error && m2row?.sent_count === 3 && m2row?.failed_count === 0 && !!m2row?.verified_at, 'mark_rejected with empty list: no changes, verified_at set')

    // 10. a recipient already failed (own error) is not overwritten
    const v3 = await mk()
    await supabase.from('admin_sms_broadcast_recipients').update({ status: 'failed', error: 'original error' }).eq('broadcast_id', v3).eq('phone', '233244100003')
    await supabase.rpc('mark_admin_sms_broadcast_rejected', { p_broadcast_id: v3, p_campaign_ids: ['camp-C-233244100003'] })
    assertOk((await recOf(v3, '233244100003')).error === 'original error', 'mark_rejected: only sent rows are flipped, existing failures keep their error')

    // 11. retry requeues failed rows, reopens the broadcast, clears verified_at
    const r1 = await supabase.rpc('retry_failed_admin_sms_broadcast_recipients', { p_broadcast_id: v1 })
    const r1row = Array.isArray(r1.data) ? r1.data[0] : r1.data
    assertOk(!r1.error && r1row?.requeued === 1, 'retry: requeued 1')
    const afterRetry = await rowOf(v1)
    assertOk(afterRetry.status === 'sending' && afterRetry.verified_at === null && afterRetry.completed_at === null, 'retry: broadcast reopened (sending, verified_at/completed_at null)')
    const requeued = await recOf(v1, '233244100002')
    assertOk(requeued.status === 'queued' && requeued.provider_message_id === null && requeued.error === null, 'retry: recipient queued with provider id and error cleared')

    // 12. second retry immediately requeues 0
    const r2 = await supabase.rpc('retry_failed_admin_sms_broadcast_recipients', { p_broadcast_id: v1 })
    const r2row = Array.isArray(r2.data) ? r2.data[0] : r2.data
    assertOk(!r2.error && r2row?.requeued === 0, 'retry twice: second call requeues 0')

    // 13. dispatch after retry resends only the requeued recipient and finishes the broadcast
    let resent = 0
    const countResend = async (o: { recipient: string }) => { resent++; return { success: true, messageId: `new-${o.recipient}` } }
    const afterResend = await dispatchAdminSmsBroadcastChunk(supabase, v1, countResend)
    assertOk(resent === 1 && afterResend?.status === 'done' && afterResend.sentCount === 3 && afterResend.failedCount === 0, 'dispatch after retry sends only the 1 requeued recipient; broadcast done 3/3')

    // 14. retry also covers send-time failures (no campaign id)
    const v4 = await trackedCreate({ createdBy: testAdminId!, message: 'x', audienceType: 'users', recipients: [{ phone: '233244100009', resolvedMessage: 'x' }] })
    await dispatchAdminSmsBroadcastChunk(supabase, v4.broadcastId, fakeSendFail)
    const r4 = await supabase.rpc('retry_failed_admin_sms_broadcast_recipients', { p_broadcast_id: v4.broadcastId })
    const r4row = Array.isArray(r4.data) ? r4.data[0] : r4.data
    assertOk(!r4.error && r4row?.requeued === 1, 'retry: send-time failures are requeued too')

    // ── lib: listKingFlexyFailedCampaignIds ──
    process.env.KINGFLEXY_API_KEY = process.env.KINGFLEXY_API_KEY || 'test-key'
    const camps = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: `c${offset + i}`, status: 'failed' }))
    const okPage = (campaigns: unknown[]) => ({ status: 200, json: async () => ({ success: true, data: { campaigns, page: 0 } }) })
    let calls = 0
    const pagedFetch = (async (url: string) => {
        calls++
        const page = Number(new URL(url).searchParams.get('page') ?? '0')
        return okPage(page === 0 ? camps(30) : camps(5, 30))
    }) as unknown as typeof fetch
    const ids = await listKingFlexyFailedCampaignIds({ from: new Date(), to: new Date(), fetchFn: pagedFetch })
    assertOk(ids.size === 35 && calls === 2, 'listKingFlexyFailedCampaignIds paginates (30 then 5 -> 35 ids, 2 calls)')
    await assertRejects(
        () => listKingFlexyFailedCampaignIds({ from: new Date(), to: new Date(), fetchFn: (async () => ({ status: 429, json: async () => ({ success: false }) })) as unknown as typeof fetch }),
        'listKingFlexyFailedCampaignIds throws on HTTP 429',
    )
    await assertRejects(
        () => listKingFlexyFailedCampaignIds({ from: new Date(), to: new Date(), fetchFn: (async () => ({ status: 200, json: async () => ({ success: false }) })) as unknown as typeof fetch }),
        'listKingFlexyFailedCampaignIds throws on success:false',
    )
    await assertRejects(
        () => listKingFlexyFailedCampaignIds({ from: new Date(), to: new Date(), fetchFn: (async () => ({ status: 200, json: async () => { throw new Error('bad json') } })) as unknown as typeof fetch }),
        'listKingFlexyFailedCampaignIds throws on non-JSON body',
    )

    // ── lib: verifyAdminSmsBroadcast ──
    const w1 = await mk()
    const vs = await verifyAdminSmsBroadcast(supabase, w1, async () => new Set(['camp-B-233244100002', 'unrelated-id']))
    assertOk(vs?.sentCount === 2 && vs.failedCount === 1 && vs.verified === true, 'verify marks only intersecting sent recipients, status.verified true')

    const w2 = await mk()
    await assertRejects(() => verifyAdminSmsBroadcast(supabase, w2, async () => { throw new Error('supplier down') }), 'verify propagates a lister failure')
    assertOk((await rowOf(w2)).verified_at === null, 'verify leaves verified_at null when the lister fails')

    let listerCalls = 0
    const spyList = async () => { listerCalls++; return new Set<string>() }
    await verifyAdminSmsBroadcast(supabase, w1, spyList)
    assertOk(listerCalls === 0, 'verify on an already-verified broadcast is a no-op (lister not called)')
    const notDone = await trackedCreate({ createdBy: testAdminId!, message: 'x', audienceType: 'users', recipients: [{ phone: '233244100008', resolvedMessage: 'x' }] })
    const nd = await verifyAdminSmsBroadcast(supabase, notDone.broadcastId, spyList)
    assertOk(listerCalls === 0 && nd?.status === 'queued' && nd.verified === false, 'verify on a not-done broadcast is a no-op (lister not called)')
    assertOk((await verifyAdminSmsBroadcast(supabase, randomUUID(), spyList)) === null, 'verify on unknown broadcast returns null')

    // recipients with null provider_message_id are ignored
    const w3 = await trackedCreate({ createdBy: testAdminId!, message: 'x', audienceType: 'users', recipients: [{ phone: '233244100007', resolvedMessage: 'x' }] })
    await dispatchAdminSmsBroadcastChunk(supabase, w3.broadcastId, async () => ({ success: true }))
    const vn = await verifyAdminSmsBroadcast(supabase, w3.broadcastId, async () => new Set(['null', 'undefined', '']))
    assertOk(vn?.sentCount === 1 && vn.failedCount === 0 && vn.verified === true, 'verify ignores recipients with null provider_message_id')

    // ── lib: retryFailedAdminSmsBroadcast / listRecent ──
    const rr = await retryFailedAdminSmsBroadcast(supabase, v3)
    assertOk(rr?.requeued === 1 && rr.status.status === 'sending' && rr.status.verified === false, 'retryFailedAdminSmsBroadcast returns requeued count and reopened status')
    assertOk((await retryFailedAdminSmsBroadcast(supabase, randomUUID())) === null, 'retryFailedAdminSmsBroadcast on unknown broadcast returns null')
    const recent = await listRecentAdminSmsBroadcasts(supabase, 10)
    const times = recent.map((r) => r.createdAt)
    assertOk(recent.length <= 10 && recent.length > 0 && times.every((t, i) => i === 0 || t <= times[i - 1]), 'listRecentAdminSmsBroadcasts returns <=10 rows newest first')
    assertOk(recent.every((r) => r.messagePreview.length <= 60), 'listRecentAdminSmsBroadcasts truncates preview to 60 chars')
}

main()
    .catch((e) => {
        console.error(e)
        process.exitCode = 1
    })
    .finally(async () => {
        if (createdBroadcastIds.length > 0) {
            const { error } = await supabase.from('admin_sms_broadcasts').delete().in('id', createdBroadcastIds)
            if (error) {
                console.error('Cleanup failed:', error.message)
                process.exitCode = 1
            }
        }
        if (process.exitCode && process.exitCode !== 0) {
            console.error('Some tests FAILED.')
        } else {
            console.log('All tests passed.')
        }
    })
