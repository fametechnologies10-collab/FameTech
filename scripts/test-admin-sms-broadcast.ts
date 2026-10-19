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
} from '../lib/admin-sms-broadcast'

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
