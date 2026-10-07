import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { normalizeGhanaPhone, sendHubtelShopBatchSMS } from '@/lib/sms-service'
import { calculateSegments } from '@/lib/sms-segments'
import { filterSmsContent } from '@/lib/sms-content-filter'
import { prepareSmsMessage } from '@/lib/sms-message'
import { resolveShopSenderFromRow } from '@/lib/sms-confirmation-sender'

// A double-submitted send (double-click, client-side retry after a timeout,
// browser back-button resubmit) must never debit credits or dispatch the SMS
// batch twice. The key is derived server-side from exactly what would be
// charged/sent — NO time bucket: an earlier version bucketed this into a 30s
// window, but a client retry after a timeout routinely lands outside a 30s
// window from the original request and would have sailed past the dedup
// check entirely, defeating the fix in exactly the case it targets (caught in
// review — see docs/security-audits/2026-08-11-race-condition-fraud-audit.md,
// finding #5 correction). The claim row is deliberately long-lived instead —
// cleaned up daily by the sms-purge cron (app/api/cron/sms-purge/route.ts) —
// so an identical resend is blocked until the next day's purge, which is an
// acceptable (and arguably desirable — it catches accidental re-blasts)
// tradeoff for a bulk customer-facing send, and no legitimate distinct
// message/recipient-list combination is ever affected.
function computeSendIdempotencyKey(shopId: string, message: string, recipients: string[]): string {
    const material = JSON.stringify({ shopId, message, recipients: [...recipients].sort() })
    return createHash('sha256').update(material).digest('hex')
}

const sendSchema = z.object({
    message: z.string().trim().min(3, 'Message is too short').max(1000, 'Message is too long'),
    recipients: z.array(
        z.string().trim().regex(/^(\+?233\d{9}|0\d{9})$/, 'Invalid Ghana phone number')
    ).min(1, 'Add at least one recipient').max(500),
})

// POST — send single/bulk SMS to customers.
//
// Enforcement chain (every step server-side; UI state is never trusted):
//   auth → feature flag → activation → input validation → recipient caps
//   → idempotency claim → content filter → rate limits → atomic credit debit
//   → provider send → partial-failure refund → audit log
export async function POST(req: NextRequest) {
    const adminDb = createServerClient()
    let shopId: string | null = null

    try {
        // 1. Auth
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        // 2. Shop + activation (service role — RLS-independent ground truth)
        const { data: shop } = await adminDb
            .from('shop_profiles')
            .select('id, shop_name, shop_slug, owner_phone, whatsapp_number, approval_status, sms_sender_id, sms_sender_status')
            .eq('owner_id', user.id)
            .maybeSingle()
        if (!shop) return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
        // C-1 fix: suspended/pending/rejected shops cannot send SMS
        if ((shop as any).approval_status !== 'approved') {
            return NextResponse.json({ success: false, error: 'Your shop must be approved to send SMS' }, { status: 403 })
        }
        const sid: string = (shop as any).id
        shopId = sid
        // Owner requirement: bulk sends use the shop's own APPROVED sender
        // when it has one; falls through to `undefined` (today's platform
        // default sender) otherwise — no behavior change for shops without
        // an approved sender.
        const approvedSender = resolveShopSenderFromRow(shop as any) || undefined

        // 3. Admin settings (feature flag, caps, blocklist)
        const { data: settingRows } = await adminDb
            .from('shop_global_settings')
            .select('key, value')
            .in('key', [
                'sms_feature_enabled', 'sms_max_recipients_per_send',
                'sms_sends_per_hour', 'sms_recipients_per_day', 'sms_blocked_keywords',
                'sms_allowed_link_domains',
            ])
        const settings: Record<string, string> = {}
        for (const row of ((settingRows as any[]) || [])) settings[row.key] = String(row.value)

        if (settings['sms_feature_enabled'] === 'false') {
            return NextResponse.json({ success: false, error: 'SMS feature is currently unavailable' }, { status: 503 })
        }

        // UX-only early hint — the authoritative activation gate lives inside
        // the debit_sms_credits RPC (atomic with the debit; no TOCTOU window).
        // The suspend flag is admin-controlled (owners have SELECT-only RLS) and
        // is enforced here server-side, before any credit debit.
        const { data: activation } = await adminDb
            .from('shop_sms_activations')
            .select('id, sms_suspended')
            .eq('shop_id', sid)
            .maybeSingle()
        if (!activation) {
            return NextResponse.json({ success: false, error: 'Activate the SMS feature before sending' }, { status: 403 })
        }
        if ((activation as any).sms_suspended === true) {
            return NextResponse.json(
                { success: false, error: 'SMS sending is disabled for your shop. Contact support.' },
                { status: 403 }
            )
        }

        // 4. Input validation
        const body = await req.json()
        const parsed = sendSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid request' },
                { status: 400 }
            )
        }

        // Build the EXACT text that will be delivered: branding tokens replaced
        // with authoritative shop values, and characters SMS can't carry (color
        // emoji) stripped. Everything below — content filter, segment/credit
        // count, provider send and audit log — runs on this prepared text, so
        // what the dashboard preview shows is what the customer receives.
        const message = prepareSmsMessage(parsed.data.message, {
            shopName:     (shop as any).shop_name,
            shopSlug:     (shop as any).shop_slug,
            shopPhone:    (shop as any).owner_phone,
            shopWhatsapp: (shop as any).whatsapp_number,
        }).slice(0, 1000)

        if (message.trim().length < 3) {
            return NextResponse.json(
                { success: false, error: 'Your message has no sendable text after removing unsupported characters (e.g. emoji). Add some words and try again.' },
                { status: 400 }
            )
        }

        // 5. Normalize + dedup recipients (Ghana numbers only)
        const seen = new Set<string>()
        const recipients: string[] = []
        for (const raw of parsed.data.recipients) {
            const normalized = normalizeGhanaPhone(raw)
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized)
                recipients.push(normalized)
            }
        }
        if (recipients.length === 0) {
            return NextResponse.json({ success: false, error: 'No valid Ghanaian phone numbers found' }, { status: 400 })
        }

        const maxPerSend = Math.max(1, parseInt(settings['sms_max_recipients_per_send'] || '100', 10))
        if (recipients.length > maxPerSend) {
            return NextResponse.json(
                { success: false, error: `Maximum ${maxPerSend} recipients per send. You provided ${recipients.length}.` },
                { status: 400 }
            )
        }

        // 5b. Idempotency claim — atomic INSERT against a UNIQUE(shop_id, idempotency_key)
        // constraint. Must happen BEFORE the content filter/rate-limit checks and,
        // critically, before the credit debit below: a duplicate request is rejected
        // here and never reaches the debit or the SMS provider, so it can neither
        // double-charge nor double-send. A genuine INSERT failure (not a duplicate)
        // fails closed — the request is rejected rather than risking an unprotected send.
        const idempotencyKey = computeSendIdempotencyKey(sid, message, recipients)
        const { error: claimErr } = await (adminDb as any)
            .from('shop_sms_send_claims')
            .insert({ shop_id: sid, idempotency_key: idempotencyKey })
        if (claimErr) {
            if (claimErr.code === '23505') {
                return NextResponse.json(
                    { success: false, error: 'This exact message was just sent to these recipients — duplicate request ignored.' },
                    { status: 409 }
                )
            }
            console.error('[ShopSMS] Idempotency claim failed:', claimErr)
            return NextResponse.json({ success: false, error: 'Could not process send request' }, { status: 500 })
        }

        // 6. Content filter — block fraud, flag borderline
        const blockedKeywords = (settings['sms_blocked_keywords'] || '').split(',').filter(Boolean)
        const allowedDomains = (settings['sms_allowed_link_domains'] || '').split(',').map(d => d.trim()).filter(Boolean)
        const filter = filterSmsContent(message, { blockedKeywords, allowedDomains })
        if (filter.blocked) {
            // Log the blocked attempt for admin review — costs no credits
            await (adminDb as any).from('shop_sms_logs').insert({
                shop_id: sid,
                message: message.slice(0, 1000),
                recipients_count: recipients.length,
                segments: calculateSegments(message).segments,
                credits_used: 0,
                status: 'blocked',
                flagged: true,
                flag_reason: filter.reason,
            })
            return NextResponse.json(
                { success: false, error: 'This message was blocked by our content policy. Contact support if you believe this is a mistake.' },
                { status: 400 }
            )
        }

        // 7. Rate limits — fail CLOSED when caps are not configured, and use
        //    DB-backed counters (shop_sms_logs) so serverless cold starts
        //    cannot reset the window. The in-memory limiter stays as a cheap
        //    first-pass shield against burst loops on a warm instance.
        const sendsPerHour = parseInt(settings['sms_sends_per_hour'] || '0', 10)
        const recipientsPerDay = parseInt(settings['sms_recipients_per_day'] || '0', 10)
        if (!sendsPerHour || !recipientsPerDay) {
            return NextResponse.json(
                { success: false, error: 'SMS sending limits are not configured. Contact support.' },
                { status: 503 }
            )
        }

        const rl = consumeRateLimit(`sms-send:${sid}`, sendsPerHour, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: `Send limit reached (${sendsPerHour}/hour). Try again later.` },
                { status: 429 }
            )
        }

        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const { data: dayLogs } = await adminDb
            .from('shop_sms_logs')
            .select('recipients_count, created_at')
            .eq('shop_id', sid)
            .neq('status', 'blocked')
            .gte('created_at', dayAgo)
        const logsToday = (dayLogs as any[]) || []
        const sendsLastHour = logsToday.filter(r => r.created_at >= hourAgo).length
        if (sendsLastHour >= sendsPerHour) {
            return NextResponse.json(
                { success: false, error: `Send limit reached (${sendsPerHour}/hour). Try again later.` },
                { status: 429 }
            )
        }
        const usedToday = logsToday.reduce((s, r) => s + (r.recipients_count || 0), 0)
        if (usedToday + recipients.length > recipientsPerDay) {
            return NextResponse.json(
                { success: false, error: `Daily recipient limit reached (${recipientsPerDay}/day). Used: ${usedToday}.` },
                { status: 429 }
            )
        }

        // 8. Atomic credit debit — segments × recipients
        const segInfo = calculateSegments(message)
        const creditsNeeded = segInfo.segments * recipients.length

        const { error: debitErr } = await (adminDb as any).rpc('debit_sms_credits', {
            p_shop_id: sid,
            p_credits: creditsNeeded,
        })
        if (debitErr) {
            const debitMsg = debitErr.message || ''
            if (debitMsg.includes('INSUFFICIENT_CREDITS')) {
                return NextResponse.json(
                    { success: false, error: `Not enough SMS credits. This send needs ${creditsNeeded} credits (${segInfo.segments} SMS × ${recipients.length} recipients).` },
                    { status: 402 }
                )
            }
            if (debitMsg.includes('NOT_ACTIVATED')) {
                return NextResponse.json({ success: false, error: 'Activate the SMS feature before sending' }, { status: 403 })
            }
            if (debitMsg.includes('SUSPENDED')) {
                return NextResponse.json({ success: false, error: 'SMS sending is disabled for your shop. Contact support.' }, { status: 403 })
            }
            console.error('[ShopSMS] Debit error:', debitErr)
            return NextResponse.json({ success: false, error: 'Failed to reserve credits' }, { status: 500 })
        }

        // 9. Send via Hubtel's batch endpoint with RegisteredDelivery — shop
        // SMS is Hubtel-pinned (no Moolre/mNotify fallback) in exchange for
        // real delivery tracking. See docs/superpowers/specs/
        // 2026-08-22-shop-sms-delivery-tracking-design.md §5, §8.
        const batchSender = approvedSender || (process.env.HUBTEL_SENDER_ID || 'KINGFLEXY').substring(0, 11)
        const batch = await sendHubtelShopBatchSMS(recipients, message, batchSender)

        const sent = batch.ok ? batch.results.length : 0
        const failed = recipients.length - sent
        const provider = batch.ok ? 'hubtel' : undefined

        // 10. Refund credits for recipients Hubtel didn't confirm
        if (failed > 0) {
            const refund = segInfo.segments * failed
            const { error: refundErr } = await (adminDb as any).rpc('refund_sms_credits', {
                p_shop_id: sid,
                p_credits: refund,
            })
            if (refundErr) {
                // Record the orphaned refund so an admin/cron can replay it —
                // credits must never be silently lost.
                await (adminDb as any).from('shop_sms_refund_failures').insert({
                    shop_id: sid,
                    credits: refund,
                    reason: refundErr.message || 'unknown',
                })
                console.error('[ShopSMS] Refund error (recorded for reconciliation):', refundErr)
            }
        }

        // 11. Audit log — capture the inserted row's id so delivery receipts
        // (and their pending_count rollup) can reference it.
        const status = sent === 0 ? 'failed' : failed > 0 ? 'partial' : 'sent'
        const { data: insertedLog, error: logInsertErr } = await (adminDb as any)
            .from('shop_sms_logs')
            .insert({
                shop_id: sid,
                message: message.slice(0, 1000),
                recipients_count: recipients.length,
                segments: segInfo.segments,
                credits_used: segInfo.segments * sent,
                status,
                flagged: filter.flagged,
                flag_reason: filter.reason,
                provider,
                pending_count: sent,
            })
            .select('id')
            .single()

        // 11b. Delivery receipts — one row per recipient Hubtel confirmed.
        // Best-effort: a failure here must not fail the send response (the
        // customer's SMS already went out) — it only means this specific
        // send's delivery status can't be tracked, same fail-open posture as
        // logShopConfirmationSmsSend in lib/sms-confirmation-sender.ts.
        if (!logInsertErr && insertedLog?.id && batch.ok && batch.results.length > 0) {
            const receipts = batch.results
                .filter(r => r.messageId)
                .map(r => ({
                    log_id: (insertedLog as any).id,
                    phone: r.to,
                    provider_message_id: r.messageId,
                    status: 'sent',
                }))
            if (receipts.length > 0) {
                const { error: receiptsErr } = await (adminDb as any)
                    .from('shop_sms_delivery_receipts')
                    .insert(receipts)
                if (receiptsErr) {
                    console.error('[ShopSMS] Delivery receipts insert failed (non-fatal, tracking only):', receiptsErr)
                }
            }
        } else if (logInsertErr) {
            console.error('[ShopSMS] shop_sms_logs insert failed:', logInsertErr)
        }

        if (sent === 0) {
            return NextResponse.json(
                { success: false, error: 'All messages failed to send. Your credits were not charged.' },
                { status: 502 }
            )
        }

        return NextResponse.json({
            success: true,
            data: {
                sent,
                failed,
                segments: segInfo.segments,
                creditsUsed: segInfo.segments * sent,
            },
        })
    } catch (err) {
        console.error('[ShopSMS] Send error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
