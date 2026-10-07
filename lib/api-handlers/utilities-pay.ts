import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    requireKeyType,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
} from '@/lib/api-auth'
import { waitUntil } from '@vercel/functions'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { parseSettingNumber } from '@/lib/paystack-fees'
import { isUtilityBiller, UTILITY_BILLERS, makeUtilityReference } from '@/lib/hubtel-utility/billers'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'
import { versionMeta } from '@/lib/api-version'

// ============================================================================
// lib/api-handlers/utilities-pay.ts
// Handler for POST /api/v2/utilities/pay.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Place a utility-bill order via the developer API (commission keys only).
// Mirrors app/api/utilities/create/route.ts's validation/guard mechanics and
// lib/api-handlers/data-purchase.ts's money-route envelope/logging/refund
// conventions: replay guard -> 30s duplicate window -> atomic wallet debit ->
// insert -> refund-on-insert-failure -> fire-and-forget wallet ledger row ->
// background dispatch.
//
// Economics: the developer pays FACE VALUE from their main wallet. Their
// commission share is credited automatically to their SHOP wallet on
// completion, because credit_utility_commission (20260709b_utility_rpcs.sql)
// resolves the partner to `user_id` for source='api' orders — this route
// never touches commission crediting, it only records source/api_key_id.
//
// Exposure: never returns commission_amount (platform total), lookup_snapshot,
// or fulfillment_metadata — only the developer's own commission_share_percent
// (their eventual cut, not yet realized at response time).
// ============================================================================

const MAX_ACCOUNT_LEN = 30
const MAX_PHONE_LEN = 30
const MAX_REFERENCE_LEN = 64

export async function handleUtilitiesPay(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    const endpoint = request.nextUrl.pathname
    const meta = versionMeta(endpoint)

    // ── Authenticate ──────────────────────────────────────────────────────
    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({
            apiKeyId: null, userId: null,
            endpoint, method: 'POST',
            statusCode: auth.status, responseTimeMs: Date.now() - startTime,
            ip, errorMessage: 'Authentication failed',
        })
        return auth
    }

    const { userId, apiKeyId, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    // ── Key-type gate — commission keys only ────────────────────────────────
    const keyTypeError = requireKeyType(auth, 'commission')
    if (keyTypeError) {
        done(403, 'Wrong key type')
        return keyTypeError
    }

    try {
        // ── Rate limit (actually consumed) ────────────────────────────────
        const rl = consumeRateLimit(`util-pay:${apiKeyId}`, 6, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (6/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        // ── Parse body ────────────────────────────────────────────────────
        let body: any
        try {
            body = await request.json()
        } catch {
            done(400, 'Invalid JSON')
            return apiError(400, 'Invalid request body')
        }

        const { biller, account, phone, amount, reference } = body || {}

        // ── Structural validation (no DB access) ────────────────────────────
        if (!isUtilityBiller(biller)) {
            done(400, 'Invalid biller')
            return apiError(400, 'Invalid biller')
        }
        const def = UTILITY_BILLERS[biller]

        const trimmedAccount = typeof account === 'string' ? account.trim() : ''
        if (!trimmedAccount) {
            done(400, 'Missing account')
            return apiError(400, `${def.accountLabel} is required`)
        }
        if (trimmedAccount.length > MAX_ACCOUNT_LEN) {
            done(400, 'Account too long')
            return apiError(400, `${def.accountLabel} is too long`)
        }

        const trimmedPhone = typeof phone === 'string' ? phone.trim() : ''
        if (trimmedPhone.length > MAX_PHONE_LEN) {
            done(400, 'Phone too long')
            return apiError(400, 'Phone number is too long')
        }
        if ((biller === 'ecg' || biller === 'ghana_water') && !trimmedPhone) {
            done(400, 'Missing phone')
            return apiError(400, `${def.label} requires a customer phone number`)
        }
        const normalizedPhone = trimmedPhone ? toMsisdn233(trimmedPhone) : null

        // Optional client idempotency key — a caller that timed out waiting for a
        // response can safely retry without triggering a second debit. Empty
        // string is treated as absent; anything else must be <=64 chars of
        // [A-Za-z0-9._-].
        let clientRef: string | null = null
        if (reference !== undefined && reference !== null) {
            if (typeof reference !== 'string') {
                done(400, 'Invalid reference')
                return apiError(400, 'Invalid reference')
            }
            const trimmedRef = reference.trim()
            if (trimmedRef) {
                if (trimmedRef.length > MAX_REFERENCE_LEN || !/^[A-Za-z0-9._-]+$/.test(trimmedRef)) {
                    done(400, 'Invalid reference')
                    return apiError(400, 'reference must be <=64 characters of letters, numbers, dot, underscore or hyphen')
                }
                clientRef = trimmedRef
            }
        }

        const parsedAmount = Number(amount)
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            done(400, 'Invalid amount')
            return apiError(400, 'Invalid amount')
        }
        const roundedAmount = Math.round(parsedAmount * 100) / 100

        // ── Gates + amount-limit settings + user email (single round trip) ──
        const [userResult, settingsResult] = await Promise.all([
            (supabase.from('users') as any).select('email').eq('id', userId).maybeSingle(),
            (supabase.from('admin_settings') as any).select('key, value').in('key', [
                'utility_bills_enabled', 'hubtel_utility_billers', 'utility_min_amount', 'utility_max_amount', 'utility_commission_partner_percent',
            ]),
        ])

        const settingsMap: Record<string, any> = {}
        for (const s of (settingsResult.data || [])) settingsMap[s.key] = s.value

        if (settingsMap['utility_bills_enabled'] !== 'true') {
            done(503, 'Utility bills disabled')
            return apiError(503, 'Utility bill payments are currently unavailable')
        }
        const billersMap = settingsMap['hubtel_utility_billers']
        if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap) || billersMap[biller] !== true) {
            done(503, 'Biller disabled')
            return apiError(503, `${def.label} is currently unavailable`)
        }

        const minAmount = parseSettingNumber(settingsMap['utility_min_amount'], 1)
        const maxAmount = parseSettingNumber(settingsMap['utility_max_amount'], 1000)
        if (roundedAmount < minAmount) {
            done(400, 'Below minimum amount')
            return apiError(400, `Minimum amount is GHS ${minAmount.toFixed(2)}`)
        }
        if (roundedAmount > maxAmount) {
            done(400, 'Above maximum amount')
            return apiError(400, `Maximum amount is GHS ${maxAmount.toFixed(2)}`)
        }

        const commissionSharePercent = parseSettingNumber(settingsMap['utility_commission_partner_percent'], 40)
        const userEmail = (userResult.data as any)?.email || null

        // ── Replay guard (idempotency) — BEFORE the debit ───────────────────
        // Scoped to the caller (user_id) — never a global reference probe. On a
        // hit, return the existing order and do NOT debit again. The prod unique
        // index uq_utility_orders_user_payref (20260710_utility_hardening.sql) is
        // the concurrent-replay backstop: a same-key concurrent insert fails and
        // lands in the insert-failure refund path below, so two truly
        // simultaneous requests with the same reference still net exactly one debit.
        if (clientRef) {
            const apiRef = `API-${clientRef}`
            const { data: existingOrder } = await (supabase as any).from('utility_orders')
                .select('id, reference_code, status')
                .eq('user_id', userId)
                .eq('payment_reference', apiRef)
                .limit(1)
                .maybeSingle()

            if (existingOrder) {
                done(200)
                return apiSuccess({
                    reference: existingOrder.reference_code,
                    order_id: existingOrder.id,
                    status: existingOrder.status,
                    already_processed: true,
                }, meta)
            }
        }

        // ── 30-second duplicate-order guard — BEFORE the debit ───────────────
        // Mirrors app/api/utilities/create/route.ts's identity tuple: user + biller
        // + account + amount. .limit(1).maybeSingle() keeps the guard closed even
        // if 2+ recent duplicates exist.
        const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString()
        const { data: recentOrder } = await (supabase as any).from('utility_orders')
            .select('id')
            .eq('user_id', userId)
            .eq('biller', biller)
            .eq('account_number', trimmedAccount)
            .eq('amount', roundedAmount)
            .gte('created_at', thirtySecondsAgo)
            .limit(1)
            .maybeSingle()

        if (recentOrder) {
            done(409, 'Duplicate order')
            return apiError(409, 'Duplicate order — retry after 30 seconds or pass a unique reference')
        }

        // ── Atomic wallet deduction ───────────────────────────────────────────
        const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
            p_user_id: userId,
            p_amount: roundedAmount,
        })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                done(400, 'Insufficient balance')
                return apiError(400, 'Insufficient wallet balance')
            }
            console.error('[API Utilities Pay] Wallet deduction error:', deductError)
            done(500, 'Wallet deduction failed')
            return apiError(500, 'Failed to process payment')
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            // deduct_wallet_balance RAISES INSUFFICIENT_BALANCE whenever no wallet row
            // was updated, so reaching here with a non-error result means the debit
            // COMMITTED but the returned row didn't parse: a debit with no order.
            // Compensating refund before returning, or the caller silently loses money.
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId, p_amount: roundedAmount,
            })
            if (refundError) {
                console.error('[API Utilities Pay] CRITICAL: refund failed after walletless deduction; manual reconciliation required:', refundError)
            }
            done(404, 'Wallet not found')
            return apiError(404, 'Wallet not found')
        }

        const referenceCode = makeUtilityReference(biller)

        // ── Create utility order ─────────────────────────────────────────────
        const { data: order, error: orderError } = await (supabase as any).from('utility_orders')
            .insert({
                user_id: userId,
                source: 'api',
                api_key_id: apiKeyId,
                biller,
                account_number: trimmedAccount,
                destination_phone: normalizedPhone,
                customer_email: userEmail,
                amount: roundedAmount,
                payment_method: 'wallet',
                payment_status: 'paid',
                status: 'pending',
                reference_code: referenceCode,
                payment_reference: clientRef ? `API-${clientRef}` : null,
            })
            .select()
            .single()

        if (orderError) {
            console.error('[API Utilities Pay] Order insert error:', orderError)
            // Atomic compensating refund — never a raw absolute write. Also the
            // landing spot for a concurrent-replay race: the second of two
            // simultaneous same-reference inserts fails uq_utility_orders_user_payref
            // and is refunded here, so exactly one debit survives.
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId, p_amount: roundedAmount,
            })
            if (refundError) {
                console.error(`[API Utilities Pay] CRITICAL: refund failed for ${referenceCode}, manual reconciliation required:`, refundError)
                done(500, 'Order insert failed; refund failed')
                return apiError(500, 'Order processing failed. Your wallet has been debited. Please contact support for assistance.')
            }
            done(500, 'Order insert failed; refunded')
            return apiError(500, 'Order could not be placed. Your wallet was not charged. Please try again.')
        }

        const orderId = (order as any).id

        // ── Wallet transaction (fire-and-forget) ─────────────────────────────
        // source: 'utility' — 20260710_utility_hardening.sql widened
        // wallet_transactions_source_check to allow it.
        ;(supabase.from('wallet_transactions') as any).insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: roundedAmount,
            description: `${def.label}: GHS ${roundedAmount.toFixed(2)} for ${trimmedAccount}`,
            reference: referenceCode,
            source: 'utility',
            status: 'completed',
        }).then(() => {}).catch((e: any) => console.error('[API Utilities Pay] Tx insert error:', e))

        // ── Background: auto-fulfill via Hubtel Commission Services ──────────
        waitUntil((async () => {
            try {
                await dispatchUtilityFulfillment(orderId)
            } catch (e) {
                console.error('[API Utilities Pay] auto-dispatch failed:', e)
            }
        })())

        // ── Return immediately ────────────────────────────────────────────
        done(200)
        return apiSuccess({
            reference: referenceCode,
            order_id: orderId,
            status: 'pending',
            biller,
            account: trimmedAccount,
            amount: roundedAmount,
            commission_share_percent: commissionSharePercent,
            new_balance: newBalance,
        }, meta)

    } catch (error: any) {
        console.error('[API Utilities Pay] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
