import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'
import { classifyAfaVerifyResponse } from '@/lib/afa-purge-classify'

// Retention for shop_afa_pending_orders, which holds applicant KYC (legal name,
// Ghana Card number, DOB) between checkout and payment confirmation.
//
//  1. Abandoned attempts (>48h, still awaiting payment) are expired and their
//     payload stripped — UNLESS the payment actually verifies as successful at
//     Paystack (a guest who paid but whose browser never made it back to the
//     callback, and whose webhook somehow also missed). Those are left intact
//     and flagged via a security_events row for manual reconciliation, capped
//     at MAX_VERIFY_PER_RUN Paystack calls per run, oldest first.
//  2. Fulfilled attempts (>48h) keep the row for reconciliation but drop the
//     payload; the real record already lives in afa_orders.
//  3. Anything older than 30 days is removed entirely.

// Cap on how many candidate rows get a live Paystack verify call per run — bounds
// the cron's runtime and Paystack call volume even if abandonment spikes.
const MAX_VERIFY_PER_RUN = 50

// Per-call timeout for each Paystack verify request. The route has up to 50
// sequential calls ahead of phases 2/3, under this endpoint's 60s function
// cap — an unbounded/slow Paystack call could otherwise starve phases 2 and 3
// entirely. A timed-out call is tolerated (row left untouched), never expired.
const VERIFY_TIMEOUT_MS = 5000

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()

    try {
        const now = Date.now()
        const cutoff48h = new Date(now - 48 * 60 * 60 * 1000).toISOString()
        const cutoff30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()

        // 1. Expire + strip abandoned checkouts — but ONLY rows whose payment did
        // NOT actually succeed at Paystack. A row can still be recoverable if the
        // guest paid and neither the browser callback nor the webhook landed
        // (see C1a). Blanking order_payload on a paid-but-unregistered row would
        // destroy the only remaining copy of the KYC and make even manual
        // reconciliation impossible.
        let expiredCount = 0
        let recoverableCount = 0
        let phase1Skipped = false
        let phase1Failed = false
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY

        if (!PAYSTACK_SECRET_KEY) {
            // Skip phase 1 entirely rather than blanking payloads blind.
            phase1Skipped = true
            console.error('[cron purge-afa-staging] PAYSTACK_SECRET_KEY unavailable — skipping phase 1 (expire) this run')
        } else {
            // Phase 1 failures are non-fatal to the whole run — a candidates-fetch
            // or expire-update error must not abort phases 2/3 (KYC stripping of
            // fulfilled rows, 30-day hard delete), which sit after this block.
            try {
                const { data: candidates, error: candidatesError } = await (supabase
                    .from('shop_afa_pending_orders') as any)
                    .select('id, paystack_reference, shop_id')
                    .eq('status', 'awaiting_payment')
                    .lt('created_at', cutoff48h)
                    .order('created_at', { ascending: true })
                    .limit(MAX_VERIFY_PER_RUN)
                if (candidatesError) throw candidatesError

                const idsToExpire: string[] = []
                for (const row of (candidates || []) as { id: string; paystack_reference: string; shop_id: string }[]) {
                    try {
                        const verifyRes = await fetch(
                            `https://api.paystack.co/transaction/verify/${encodeURIComponent(row.paystack_reference)}`,
                            {
                                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                                signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
                            }
                        )
                        const verifyData = await verifyRes.json().catch(() => null)
                        const classification = classifyAfaVerifyResponse(verifyRes.status, verifyData)

                        if (classification === 'tolerate') {
                            // Call failed, was inconclusive, or Paystack itself is
                            // struggling — leave the row for the next run.
                            recoverableCount++
                            continue
                        }

                        if (classification === 'success') {
                            // Paid but never registered — leave the row untouched (KYC
                            // intact) and record a loud, durable marker for manual
                            // reconciliation. Deduped: without this, the same row gets
                            // re-flagged into security_events on every single run
                            // indefinitely, since nothing here ever clears it.
                            recoverableCount++
                            const { data: existingAlert } = await (supabase as any)
                                .from('security_events')
                                .select('id')
                                .eq('event_type', 'afa_paid_but_unregistered')
                                .eq('reference', row.paystack_reference)
                                .limit(1)
                                .maybeSingle()
                            if (!existingAlert) {
                                const { error: auditError } = await (supabase as any).from('security_events').insert({
                                    event_type: 'afa_paid_but_unregistered',
                                    reference: row.paystack_reference,
                                    shop_id: row.shop_id,
                                    order_type: 'afa',
                                    detail: { pending_id: row.id },
                                })
                                if (auditError) {
                                    console.error('[cron purge-afa-staging] security_events insert failed:', auditError)
                                }
                            }
                            continue
                        }

                        // classification === 'expire'
                        idsToExpire.push(row.id)
                    } catch (verifyErr) {
                        // Network failure or timeout — tolerate it, leave the row for
                        // next run rather than blanking it blind.
                        console.error('[cron purge-afa-staging] Paystack verify failed for', row.paystack_reference, verifyErr)
                        recoverableCount++
                    }
                }

                if (idsToExpire.length > 0) {
                    const { error: expireError } = await (supabase
                        .from('shop_afa_pending_orders') as any)
                        .update({ status: 'expired', order_payload: {} })
                        .in('id', idsToExpire)
                    if (expireError) throw expireError
                }
                expiredCount = idsToExpire.length
            } catch (phase1Error) {
                phase1Failed = true
                console.error('[cron purge-afa-staging] Phase 1 (expire) failed — continuing to phases 2/3:', phase1Error)
            }
        }

        // 2. Strip redundant KYC from fulfilled rows (afa_orders holds the record).
        const { data: stripped, error: stripError } = await (supabase
            .from('shop_afa_pending_orders') as any)
            .update({ order_payload: {} })
            .eq('status', 'fulfilled')
            .lt('created_at', cutoff48h)
            .neq('order_payload', '{}')
            .select('id')
        if (stripError) throw stripError

        // 3. Remove anything older than the retention window.
        const { data: deleted, error: deleteError } = await (supabase
            .from('shop_afa_pending_orders') as any)
            .delete()
            .lt('created_at', cutoff30d)
            .select('id')
        if (deleteError) throw deleteError

        const summary = {
            expired: expiredCount,
            recoverable: recoverableCount,
            phase1Skipped,
            phase1Failed,
            stripped: stripped?.length || 0,
            deleted: deleted?.length || 0,
        }
        console.log('[cron purge-afa-staging]', summary)

        return NextResponse.json({ success: true, ...summary, cutoff48h, cutoff30d })
    } catch (error) {
        console.error('Cron purge-afa-staging error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
