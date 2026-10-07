/**
 * KFT SMS v2 — confirmation-sender resolvers.
 *
 * A KFT SMS user (or shop, added by Task F3) with an approved sender ID may
 * opt in to having THEIR OWN sender used on order-confirmation/completion SMS
 * for THEIR OWN orders (data/RC/airtime/mashup), instead of the platform
 * sender. This file is the single seam every confirmation call site resolves
 * through — Task E3 wires `resolveOwnConfirmationSender` into the 4
 * confirmation call sites; Task F3 adds `sendShopConfirmationSMS` here
 * alongside it (one clear responsibility per function, shared file per plan).
 *
 * FAIL-SAFE: resolution NEVER throws. Any DB error, missing account, or
 * incomplete data resolves to `null` — callers fall back to the platform
 * sender. Order-confirmation delivery must never be blocked by this lookup.
 *
 * Shop confirmations (Task F3) are additionally suppress-until-sender AND
 * credit-metered: unlike KFT users (who always send on the free platform
 * sender when they haven't opted into their own), a shop with NO approved
 * sender sends NOTHING — no free platform-sender fallback — and a shop WITH
 * an approved sender pays 1 SMS credit per confirmation via the same
 * `debit_sms_credits`/`refund_sms_credits` RPCs the shop bulk-send route
 * uses (`app/api/shop/sms/send/route.ts`). This makes shop order
 * confirmations MONEY code: every debit is followed by a send attempt, and
 * every send failure is followed by a refund attempt whose own failure is
 * recorded in `shop_sms_refund_failures` so credits are never silently lost.
 */

import type { SmsAccountMode } from '@/lib/sms-platform-types'
import { sendOrderSuccessSMS, buildOrderSuccessMessage, sendSMS } from '@/lib/sms-service'
import { calculateSegments } from '@/lib/sms-segments'

interface ConfirmationAccountRow {
    id: string
    mode: SmsAccountMode
    status: 'active' | 'suspended'
    business_on_hold: boolean
    use_own_sender_for_confirmations: boolean
}

interface ConfirmationSenderRow {
    sender_text: string
    status: string
    is_default: boolean
}

/**
 * Resolves the sender text a KFT SMS user should see on THEIR OWN
 * order-confirmation/completion SMS, or `null` to fall back to the platform
 * sender.
 *
 * Qualifies IFF: the user has an active `sms_accounts` row with
 * `use_own_sender_for_confirmations = true`, the account is NOT a held
 * business account (`mode = 'business' && business_on_hold`), and an
 * APPROVED sender exists for it (the account's default approved sender, else
 * the first approved sender). Mode itself never gates confirmations — only
 * the hold does; the toggle is only settable once a sender is approved.
 *
 * `db` must be a SERVICE-ROLE client (callers are server-side order
 * processors, not user-scoped route handlers). At most 2 queries.
 */
export async function resolveOwnConfirmationSender(db: any, userId: string): Promise<string | null> {
    try {
        const { data: account } = await db
            .from('sms_accounts')
            .select('id, mode, status, business_on_hold, use_own_sender_for_confirmations')
            .eq('user_id', userId)
            .maybeSingle() as { data: ConfirmationAccountRow | null }

        if (!account) return null
        if (account.status !== 'active') return null
        if (!account.use_own_sender_for_confirmations) return null
        // A held business account is enforced as platform-sender-only
        // everywhere else in the policy engine (lib/sms-policy.ts) — mirror
        // that here so confirmations never leak the on-hold account's sender.
        if (account.mode === 'business' && account.business_on_hold) return null

        const { data: senderRows } = await db
            .from('sms_sender_ids')
            .select('sender_text, status, is_default')
            .eq('account_id', account.id) as { data: ConfirmationSenderRow[] | null }

        const approved = ((senderRows as ConfirmationSenderRow[]) || []).filter(s => s.status === 'approved')
        if (approved.length === 0) return null

        const chosen = approved.find(s => s.is_default) || approved[0]
        return chosen.sender_text.trim().substring(0, 11)
    } catch (err) {
        console.error('[resolveOwnConfirmationSender] resolution failed, falling back to platform sender:', err)
        return null
    }
}

// ─── Shop confirmations (Task F3) ────────────────────────────────────────────

interface ShopSenderRow {
    sms_sender_id?: string | null
    sms_sender_status?: string | null
}

/**
 * Pure projection: `shop_profiles` sender columns → usable sender text, or
 * `null`. Exported so callers that already SELECTed these columns (e.g.
 * `lib/shop-order-processor.ts`, which extends its existing `shop_profiles`
 * select rather than re-querying) can compute the same answer as
 * `resolveShopConfirmationSender` without a second round-trip.
 */
export function resolveShopSenderFromRow(row: ShopSenderRow | null | undefined): string | null {
    if (!row) return null
    if (row.sms_sender_status !== 'approved') return null
    const text = (row.sms_sender_id || '').trim()
    if (!text) return null
    return text.substring(0, 11)
}

/**
 * Resolves the sender text a shop should use on its order-confirmation SMS,
 * or `null` to SUPPRESS the send entirely (shops have no free platform-sender
 * fallback — see file header). Qualifies IFF `shop_profiles.sms_sender_status
 * === 'approved'` and `sms_sender_id` is present.
 *
 * `db` must be a SERVICE-ROLE client. NEVER throws (log → null).
 */
export async function resolveShopConfirmationSender(db: any, shopId: string): Promise<string | null> {
    try {
        const { data: shop } = await db
            .from('shop_profiles')
            .select('sms_sender_id, sms_sender_status')
            .eq('id', shopId)
            .maybeSingle() as { data: ShopSenderRow | null }

        return resolveShopSenderFromRow(shop)
    } catch (err) {
        console.error('[resolveShopConfirmationSender] resolution failed, suppressing send:', err)
        return null
    }
}

/**
 * Best-effort `shop_sms_logs` insert for an automatic order-confirmation
 * send. NEVER throws — a bookkeeping write must not be able to break order
 * processing (mirrors the `shop_sms_refund_failures` insert pattern above:
 * failures are caught and logged to console only).
 *
 * `segments` is always the computed credit cost (1 recipient, so
 * segments === credits) regardless of outcome — only `creditsUsed` differs
 * (0 on failure, since a failed send's debit is refunded and logging it as
 * consumed would contradict the wallet).
 */
async function logShopConfirmationSmsSend(
    db: any,
    shopId: string,
    message: string,
    credits: number,
    creditsUsed: number,
    status: 'sent' | 'failed',
    provider?: string
): Promise<void> {
    try {
        const row: Record<string, unknown> = {
            shop_id: shopId,
            message: message.slice(0, 1000),
            recipients_count: 1,
            segments: credits,
            credits_used: creditsUsed,
            status,
            source: 'auto_confirmation',
        }
        if (provider) row.provider = provider
        const { error } = await db.from('shop_sms_logs').insert(row)
        if (error) {
            console.error('[sendShopConfirmationSMS] shop_sms_logs insert error (non-fatal, usage bookkeeping only):', error)
        }
    } catch (err) {
        console.error('[sendShopConfirmationSMS] shop_sms_logs insert threw (non-fatal, usage bookkeeping only):', err)
    }
}

export interface SendShopConfirmationOptions {
    /**
     * Caller already resolved the sender (e.g. shop-order-processor's
     * extended `shop_profiles` select via `resolveShopSenderFromRow`). Pass
     * this (including `null`, meaning "no approved sender") to skip the
     * internal `resolveShopConfirmationSender` DB lookup. Omit it (leave
     * `undefined`) to have this function resolve the sender itself.
     */
    sender?: string | null
    /**
     * TEST SEAM ONLY. Production callers never pass this — it exists so
     * `scripts/test-sms-confirmation-sender.ts` can fake the network-calling
     * `sendOrderSuccessSMS` dependency without a mocking framework (this repo
     * has none; tests run via plain `npx tsx`). Defaults to the real
     * `sendOrderSuccessSMS` from `lib/sms-service.ts`.
     */
    sendFn?: typeof sendOrderSuccessSMS
}

/**
 * Suppress-until-sender + credit-metered shop order-confirmation SMS.
 *
 * STRICT flow:
 *  1. Resolve the shop's approved sender (or use `options.sender` if the
 *     caller already has it). No approved sender ⇒ RETURN silently — no
 *     send, no debit.
 *  2. Build the identical message `sendOrderSuccessSMS` sends — single-
 *     sourced via `buildOrderSuccessMessage` (`lib/sms-service.ts`) — and
 *     compute credits = `calculateSegments(message).segments` for 1
 *     recipient.
 *  3. `debit_sms_credits` — INSUFFICIENT_CREDITS / NOT_ACTIVATED / SUSPENDED
 *     ⇒ RETURN silently (suppress, info-level log). Any other debit error
 *     ⇒ log error + RETURN (never throw).
 *  4. Send via `sendOrderSuccessSMS(phone, { ...details, sender })`. On
 *     failure (result.success === false, or the call itself throws) ⇒
 *     `refund_sms_credits`; if THAT errors ⇒ insert into
 *     `shop_sms_refund_failures` (mirrors `app/api/shop/sms/send/route.ts`
 *     ~244-257) so credits are never silently lost.
 *  5. NEVER throws — callers (order processing) must be unaffected. The
 *     processor calls this fire-and-forget with `.catch` anyway; this is a
 *     second, independent guarantee.
 *
 * `db` must be a SERVICE-ROLE client (has RPC + `shop_sms_refund_failures`
 * insert access).
 */
export async function sendShopConfirmationSMS(
    db: any,
    shopId: string,
    phone: string,
    details: { network: string; size: string; price: number },
    options: SendShopConfirmationOptions = {}
): Promise<void> {
    try {
        const sender = options.sender !== undefined
            ? options.sender
            : await resolveShopConfirmationSender(db, shopId)

        if (!sender) return // suppress-until-sender: no free platform fallback for shops

        // Credits are sized on the EXACT template sendOrderSuccessSMS sends —
        // single-sourced via buildOrderSuccessMessage (lib/sms-service.ts),
        // computed here because the debit must happen before the send.
        const message = buildOrderSuccessMessage(details.size)
        const credits = calculateSegments(message).segments

        const { error: debitErr } = await db.rpc('debit_sms_credits', {
            p_shop_id: shopId,
            p_credits: credits,
        })
        if (debitErr) {
            const debitMsg = debitErr.message || ''
            if (debitMsg.includes('INSUFFICIENT_CREDITS') || debitMsg.includes('NOT_ACTIVATED') || debitMsg.includes('SUSPENDED')) {
                console.log(`[sendShopConfirmationSMS] suppressed for shop ${shopId}: ${debitMsg}`)
                return
            }
            console.error('[sendShopConfirmationSMS] debit error:', debitErr)
            return
        }

        const send = options.sendFn ?? sendOrderSuccessSMS
        let result: { success: boolean; error?: string; provider?: string } | undefined
        try {
            result = await send(phone, {
                network: details.network,
                size: details.size,
                price: details.price,
                recipientNumber: phone,
                currentBalance: 0,
                sender,
            })
        } catch (sendErr) {
            result = { success: false, error: sendErr instanceof Error ? sendErr.message : String(sendErr) }
        }

        if (!result || !result.success) {
            const { error: refundErr } = await db.rpc('refund_sms_credits', {
                p_shop_id: shopId,
                p_credits: credits,
            })
            if (refundErr) {
                // Record the orphaned refund so an admin/cron can replay it —
                // credits must never be silently lost. Mirrors the bulk
                // send route's fallback (app/api/shop/sms/send/route.ts).
                await db.from('shop_sms_refund_failures').insert({
                    shop_id: shopId,
                    credits,
                    reason: refundErr.message || 'unknown',
                })
                console.error('[sendShopConfirmationSMS] refund error (recorded for reconciliation):', refundErr)
            }
            // Logged AFTER the refund attempt. credits_used must reflect what
            // the wallet actually retained, NOT just "the send failed":
            //  - refund succeeded  -> wallet made whole -> credits_used: 0
            //  - refund FAILED (refundErr set) -> the debit still stands, the
            //    shop's wallet still counts these credits as used (it's only
            //    recorded in shop_sms_refund_failures for reconciliation, not
            //    reversed) -> credits_used: credits, so shop_sms_logs agrees
            //    with shop_sms_wallets.total_used instead of under-reporting
            //    by `credits` in the same direction as the original bug.
            // status stays 'failed' either way — the send itself did fail;
            // only the credits accounting differs. Do NOT "simplify" this
            // back to a flat 0.
            await logShopConfirmationSmsSend(db, shopId, message, credits, refundErr ? credits : 0, 'failed')
        } else {
            await logShopConfirmationSmsSend(db, shopId, message, credits, credits, 'sent', result.provider)
        }
    } catch (err) {
        // Rule 5: NEVER throw out of this function.
        console.error('[sendShopConfirmationSMS] unexpected error (suppressed):', err)
    }
}

// ─── Shop utility-bill confirmations ─────────────────────────────────────────

interface ShopUtilitySmsRow {
    sms_sender_id?: string | null
    sms_sender_status?: string | null
    utility_sms_confirmation_enabled?: boolean | null
}

export interface SendShopUtilityConfirmationOptions {
    /** TEST SEAM ONLY — see SendShopConfirmationOptions.sendFn above. */
    sendFn?: typeof sendSMS
}

/**
 * Suppress-until-sender + credit-metered shop UTILITY-BILL completion SMS.
 * Same money-code contract as `sendShopConfirmationSMS` above (Task F3), reused
 * verbatim for the debit/send/refund/log sequence — the only difference is the
 * message is a caller-supplied string (utility bills have no network/size/price
 * shape) and gating additionally checks `utility_sms_confirmation_enabled`, a
 * DEDICATED toggle separate from `sms_order_confirmation_enabled` (a shop owner
 * may want data/airtime confirmations on but utility-bill confirmations off, or
 * vice versa — product decision, not an oversight).
 *
 * STRICT flow (mirrors sendShopConfirmationSMS):
 *  1. Look up shop_profiles (sender + status + the utility toggle). Toggle
 *     explicitly false, or no approved sender ⇒ RETURN silently — no send, no
 *     debit. (Unlike the general confirmation, there is no `options.sender`
 *     pre-resolution seam here — callers always trigger one lookup, since this
 *     path fires from a webhook with no shop_profiles row already in hand.)
 *  2. credits = calculateSegments(message).segments for 1 recipient.
 *  3. `debit_sms_credits` — INSUFFICIENT_CREDITS / NOT_ACTIVATED / SUSPENDED
 *     ⇒ RETURN silently (suppress, info-level log). Any other debit error ⇒
 *     log error + RETURN (never throw).
 *  4. Send via `sendSMS({ recipient: phone, message, sender })`. On failure ⇒
 *     `refund_sms_credits`; if THAT errors ⇒ insert into
 *     `shop_sms_refund_failures` so credits are never silently lost.
 *  5. NEVER throws — the caller (the Hubtel webhook) must always get its
 *     always-200 response regardless of SMS outcome.
 *
 * `db` must be a SERVICE-ROLE client.
 */
export async function sendShopUtilityConfirmationSMS(
    db: any,
    shopId: string,
    phone: string,
    message: string,
    options: SendShopUtilityConfirmationOptions = {}
): Promise<void> {
    try {
        const { data: shop } = await db
            .from('shop_profiles')
            .select('sms_sender_id, sms_sender_status, utility_sms_confirmation_enabled')
            .eq('id', shopId)
            .maybeSingle() as { data: ShopUtilitySmsRow | null }

        if (!shop || shop.utility_sms_confirmation_enabled === false) return

        const sender = resolveShopSenderFromRow(shop)
        if (!sender) return // suppress-until-sender: no free platform fallback for shops

        const credits = calculateSegments(message).segments

        const { error: debitErr } = await db.rpc('debit_sms_credits', {
            p_shop_id: shopId,
            p_credits: credits,
        })
        if (debitErr) {
            const debitMsg = debitErr.message || ''
            if (debitMsg.includes('INSUFFICIENT_CREDITS') || debitMsg.includes('NOT_ACTIVATED') || debitMsg.includes('SUSPENDED')) {
                console.log(`[sendShopUtilityConfirmationSMS] suppressed for shop ${shopId}: ${debitMsg}`)
                return
            }
            console.error('[sendShopUtilityConfirmationSMS] debit error:', debitErr)
            return
        }

        const send = options.sendFn ?? sendSMS
        let result: { success: boolean; error?: string; provider?: string } | undefined
        try {
            result = await send({ recipient: phone, message, sender })
        } catch (sendErr) {
            result = { success: false, error: sendErr instanceof Error ? sendErr.message : String(sendErr) }
        }

        if (!result || !result.success) {
            const { error: refundErr } = await db.rpc('refund_sms_credits', {
                p_shop_id: shopId,
                p_credits: credits,
            })
            if (refundErr) {
                await db.from('shop_sms_refund_failures').insert({
                    shop_id: shopId,
                    credits,
                    reason: refundErr.message || 'unknown',
                })
                console.error('[sendShopUtilityConfirmationSMS] refund error (recorded for reconciliation):', refundErr)
            }
            // See logShopConfirmationSmsSend's own comment for why credits_used
            // differs by whether the refund itself succeeded.
            await logShopConfirmationSmsSend(db, shopId, message, credits, refundErr ? credits : 0, 'failed')
        } else {
            await logShopConfirmationSmsSend(db, shopId, message, credits, credits, 'sent', result.provider)
        }
    } catch (err) {
        // Rule 5: NEVER throw out of this function.
        console.error('[sendShopUtilityConfirmationSMS] unexpected error (suppressed):', err)
    }
}
