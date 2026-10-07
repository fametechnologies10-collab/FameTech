import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp, requireKeyType } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { waitUntil } from '@vercel/functions'
import { quoteAirtimeCommission } from '@/lib/airtime-pricing'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'

// ============================================================================
// POST /api/v2/airtime/purchase
// Mirrors app/api/airtime/create/route.ts's validation/pricing/idempotency
// exactly, adapted to API-key auth. Mashup is NOT available here — it is
// dashboard-only and MTN-only. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md.
// ============================================================================

const ENDPOINT = '/api/v2/airtime/purchase'
const NETWORK_KEY_MAP: Record<string, string> = { MTN: 'mtn', Telecel: 'telecel', AT: 'at' }
const VALID_NETWORKS = ['MTN', 'Telecel', 'AT']

export async function POST(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'POST', statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Authentication failed' })
        return auth
    }

    const { userId, apiKeyId, effectiveRole, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    const keyTypeError = requireKeyType(auth, 'commission')
    if (keyTypeError) {
        done(403, 'Wrong key type')
        return keyTypeError
    }

    try {
        // Sub-agent eligibility (spec §11 lift, 2026-09-17): unlike data/AFA/results-checker,
        // airtime/mashup carry no sub-agent markup by design (platform decision: no earnings
        // split for parent on airtime/mashup) AND this route is commission-key zero-fee for
        // EVERY role already (quoteAirtimeCommission below) — so there is no pricing wiring
        // needed here, only the eligibility gate (pending/suspended sub, or one whose
        // recruiter is currently ineligible, still cannot transact).
        const subCtx = await resolveSubAgentContext(supabase, userId)
        if (subCtx.isSub && !subCtx.effectiveActive) {
            done(403, 'Sub-agent inactive')
            return apiError(403, subCtx.inactiveReason || 'Your account is not currently active')
        }

        const rl = consumeRateLimit(`v2-airtime-purchase:${apiKeyId}`, 10, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (10/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        let body: any
        try { body = await request.json() } catch {
            done(400, 'Invalid JSON')
            return apiError(400, 'Invalid request body')
        }

        const { network, beneficiary_phone, amount, reference } = body || {}

        if (!network || !VALID_NETWORKS.includes(network)) {
            done(400, 'Invalid network')
            return apiError(400, `Invalid network. Must be one of: ${VALID_NETWORKS.join(', ')}`)
        }
        const cleanPhone = String(beneficiary_phone || '').replace(/\s+/g, '')
        if (!/^0\d{9}$/.test(cleanPhone)) {
            done(400, 'Invalid phone')
            return apiError(400, 'Invalid beneficiary_phone. Use Ghana format: 0XXXXXXXXX')
        }
        const parsedAmount = parseFloat(amount)
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            done(400, 'Invalid amount')
            return apiError(400, 'amount must be a positive number')
        }
        if (!reference || typeof reference !== 'string' || reference.length < 3 || reference.length > 100) {
            done(400, 'Invalid reference')
            return apiError(400, 'reference is required (3-100 characters) — your unique transaction ID for idempotency')
        }
        const referenceCode = `API-${reference}`

        // Idempotency check, scoped to the caller.
        const { data: existingOrder } = await (supabase.from('airtime_orders') as any)
            .select('id, reference_code, status, network, beneficiary_phone, airtime_amount, total_paid')
            .eq('reference_code', referenceCode).eq('user_id', userId).maybeSingle()
        if (existingOrder) {
            done(200)
            return apiSuccess({
                order_id: existingOrder.id, reference, status: existingOrder.status,
                network: existingOrder.network, beneficiary_phone: existingOrder.beneficiary_phone,
                airtime_amount: parseFloat(String(existingOrder.airtime_amount)),
                total_paid: parseFloat(String(existingOrder.total_paid)), is_duplicate: true,
            }, { version: 'v2', message: 'Order already exists with this reference' })
        }

        const [userResult, settingsResult] = await Promise.all([
            // Still queried to confirm the account exists; the ROLE used for pricing
            // comes from auth.effectiveRole, which applies dealer/agent expiry.
            (supabase.from('users') as any).select('id').eq('id', userId).single(),
            (supabase.from('admin_settings') as any).select('key, value').in('key', [
                `airtime_enabled_${NETWORK_KEY_MAP[network]}`,
                `airtime_fee_${NETWORK_KEY_MAP[network]}_customer`, `airtime_fee_${NETWORK_KEY_MAP[network]}_agent`, `airtime_fee_${NETWORK_KEY_MAP[network]}_dealer`,
                `airtime_min_amount_customer`, `airtime_min_amount_agent`, `airtime_min_amount_dealer`,
                `airtime_max_amount_customer`, `airtime_max_amount_agent`, `airtime_max_amount_dealer`,
            ]),
        ])
        if (userResult.error || !userResult.data) {
            done(404, 'User not found')
            return apiError(404, 'User not found')
        }
        // Expiry-aware: a lapsed dealer/agent prices as a customer here, matching
        // data/purchase, the storefront and USSD. `user_role` is stamped on the order
        // below from this same value, so the row records what they were actually
        // charged as. See lib/effective-role.ts.
        const userRole = effectiveRole
        const settingsMap: Record<string, string> = {}
        for (const s of (settingsResult.data || [])) settingsMap[(s as any).key] = (s as any).value

        if (settingsMap[`airtime_enabled_${NETWORK_KEY_MAP[network]}`] === 'false') {
            done(400, 'Network disabled')
            return apiError(400, `${network} airtime is currently unavailable`)
        }

        // Limits + fee arithmetic come from lib/airtime-pricing.ts, shared with
        // the dashboard route. This block used to be a line-for-line copy of the
        // dashboard's (review finding I6) — two fee tables that had to be changed
        // in lockstep forever, with the fallback constants the dangerous half.
        const quoted = quoteAirtimeCommission({
            settings: settingsMap,
            network,
            role: userRole,
            amount: parsedAmount,
        })
        if (!quoted.ok) {
            done(400, quoted.reason)
            return apiError(400, quoted.message)
        }
        const { airtimeAmount, feeAmount, totalPaid, feeRate } = quoted.quote

        const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', { p_user_id: userId, p_amount: totalPaid })
        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                done(400, 'Insufficient balance')
                return apiError(400, 'Insufficient wallet balance')
            }
            console.error('[API v2 Airtime Purchase] Wallet deduction error:', deductError)
            done(500, 'Wallet deduction failed')
            return apiError(500, 'Failed to process payment')
        }
        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance
        if (!walletId) {
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: totalPaid })
            if (refundError) console.error('[API v2 Airtime Purchase] CRITICAL: refund failed after missing wallet_id; manual reconciliation required:', refundError)
            done(404, 'Wallet not found')
            return apiError(404, 'Wallet not found')
        }

        const { data: order, error: orderError } = await (supabase.from('airtime_orders') as any)
            .insert({
                user_id: userId, user_role: userRole, beneficiary_phone: cleanPhone, network,
                airtime_amount: airtimeAmount, fee_rate: feeRate, fee_amount: feeAmount,
                admin_fee_amount: feeAmount, shop_fee_amount: 0, total_paid: totalPaid,
                use_exact_amount: false, status: 'pending', reference_code: referenceCode,
                type: 'airtime', bundle_preference: null, source: 'api', api_key_id: apiKeyId,
            }).select().single()

        if (orderError) {
            console.error('[API v2 Airtime Purchase] Order insert error:', orderError)
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: totalPaid })
            if (refundError) {
                console.error('[API v2 Airtime Purchase] CRITICAL: refund failed for', referenceCode, refundError)
                done(500, 'Order insert failed; refund failed')
                return apiError(500, 'Order processing failed. Your wallet has been debited. Please contact support with your reference code for assistance.')
            }
            // airtime_orders_reference_code_key is GLOBAL, so this is usually a reference another
            // account already used. "Please try again" would be advice that fails identically
            // forever — tell them to change the reference instead. The refund above already ran.
            if (orderError.code === '23505' || orderError.message?.includes('duplicate key')) {
                done(409, 'Reference already in use')
                return apiError(409, 'This reference is already in use. Your wallet was not charged. Choose a different reference.')
            }
            done(500, 'Order insert failed; refunded')
            return apiError(500, 'Order could not be placed. Your wallet was not charged. Please try again.')
        }

        // waitUntil so a lambda freeze immediately after the response cannot drop the ledger row
        // — the wallet has already been debited, so losing this leaves an audit gap.
        waitUntil((supabase.from('wallet_transactions') as any).insert({
            wallet_id: walletId, user_id: userId, type: 'debit', amount: totalPaid,
            description: `API Airtime: GHS ${airtimeAmount.toFixed(2)} for ${cleanPhone} (${network})`,
            reference: referenceCode, source: 'airtime', status: 'completed',
        }).then(() => {}).catch((e: any) => console.error('[API v2 Airtime Purchase] Tx insert error:', e)))

        waitUntil((async () => {
            try {
                const { dispatchAirtimeFulfillment } = await import('@/lib/airtime-fulfillment')
                await dispatchAirtimeFulfillment((order as any).id)
            } catch (e) { console.error('[API v2 Airtime Purchase] auto-dispatch failed:', e) }
        })())

        done(200)
        return apiSuccess({
            order_id: (order as any).id, reference, status: 'pending', network,
            beneficiary_phone: cleanPhone, airtime_amount: airtimeAmount, fee_amount: feeAmount,
            total_paid: totalPaid, new_balance: newBalance,
        }, { version: 'v2' })

    } catch (error: any) {
        console.error('[API v2 Airtime Purchase] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
