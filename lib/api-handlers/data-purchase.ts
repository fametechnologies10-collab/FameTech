// lib/api-handlers/data-purchase.ts
// Handler for POST /api/v2/data/purchase.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Mirrors app/api/orders/purchase/route.ts's flow:
//   validate phone → resolve package by network+volume → OOS/blacklist/whitelist
//   gates → role-based pricing → atomic wallet deduction → insert order →
//   background fulfillment via the SHARED lib/fulfillment-trigger.ts
//
// Money-path ordering is unchanged by the port: every gate that can reject an
// order still runs BEFORE the wallet is touched, and the compensating
// credit_wallet_balance still runs on any insert failure.
import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
} from '@/lib/api-auth'
import { waitUntil } from '@vercel/functions'
import { getAdminOOSNetworks, isNetworkOOS } from '@/lib/network-stock'
import { resolveOrderQueueing } from '@/lib/number-registration'
import { checkMtnWhitelistGate } from '@/lib/mtn-whitelist-gate'
import { triggerFulfillment } from '@/lib/fulfillment-trigger'
import { versionMeta } from '@/lib/api-version'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'

// Valid network names (exact, case-sensitive)
const VALID_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']

export async function handleDataPurchase(request: NextRequest) {
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

    try {
        const { userId, apiKeyId, effectiveRole, supabase } = auth

        // Sub-agent eligibility (spec §11 lift, 2026-09-17): the developer API used to
        // block any sub-agent outright, since this path priced by the key owner's OWN
        // role tier, bypassing the upline's sub_price entirely. Now wired the same way
        // as every other purchase surface (app/api/orders/purchase) — evaluated LIVE, a
        // pending/suspended sub or one whose recruiter is currently ineligible still
        // cannot transact.
        const subCtx = await resolveSubAgentContext(supabase, userId)
        if (subCtx.isSub && !subCtx.effectiveActive) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 403, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Sub-agent inactive' })
            return apiError(403, subCtx.inactiveReason || 'Your account is not currently active')
        }

        // ── Parse body ────────────────────────────────────────────────────
        let body: any
        try {
            body = await request.json()
        } catch {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid JSON' })
            return apiError(400, 'Invalid request body')
        }

        const { network, volume_gb, recipient, reference } = body

        // ── Validate network ──────────────────────────────────────────────
        if (!network || !VALID_NETWORKS.includes(network)) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid network' })
            return apiError(400, `Invalid network. Must be one of: ${VALID_NETWORKS.join(', ')}`)
        }

        // ── Validate volume_gb ────────────────────────────────────────────
        if (!volume_gb || typeof volume_gb !== 'number' || volume_gb <= 0) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid volume_gb' })
            return apiError(400, 'volume_gb must be a positive number (e.g. 1, 5, 10)')
        }

        // ── Validate recipient phone ──────────────────────────────────────
        if (!recipient || typeof recipient !== 'string') {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Missing recipient' })
            return apiError(400, 'recipient phone number is required')
        }

        const cleanPhone = recipient.replace(/\s+/g, '')
        const ghanaPhoneRegex = /^0\d{9}$/

        if (!ghanaPhoneRegex.test(cleanPhone)) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid phone format' })
            return apiError(400, 'Invalid phone number. Use format: 0XXXXXXXXX (10 digits, must start with 0)')
        }

        // ── Validate reference (idempotency key) ──────────────────────────
        if (!reference || typeof reference !== 'string' || reference.length < 3 || reference.length > 100) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid reference' })
            return apiError(400, 'reference is required (3-100 characters). This is your unique transaction ID for idempotency.')
        }

        // Prefix API references to avoid collision with web references
        const referenceCode = `API-${reference}`

        // ── Idempotency check ─────────────────────────────────────────────
        // Scope to the authenticated key owner. References are developer-chosen
        // plaintext (e.g. "order-1"), so without this scope two tenants reusing
        // the same value would expose each other's order details (recipient,
        // price, status) and silently suppress each other's orders.
        const { data: existingOrder } = await (supabase.from('orders') as any)
            .select('id, reference_code, status, network, size, phone_number, price')
            .eq('reference_code', referenceCode)
            .eq('user_id', userId)
            .maybeSingle()

        if (existingOrder) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            return apiSuccess({
                order_id: existingOrder.id,
                reference: reference,
                status: existingOrder.status,
                network: existingOrder.network,
                size: existingOrder.size,
                recipient: existingOrder.phone_number,
                price: parseFloat(String(existingOrder.price)),
                is_duplicate: true,
            }, { ...meta, message: 'Order already exists with this reference' })
        }

        // ── Resolve package by network + volume_gb ────────────────────────
        // Build size string: volume_gb → "5GB"
        const sizeString = `${volume_gb}GB`

        const { data: pkg, error: pkgError } = await (supabase
            .from('data_packages') as any)
            .select('*')
            .eq('network', network)
            .eq('size', sizeString)
            .eq('is_available', true)
            .neq('category', 'mtn_mashup')
            .single()

        if (pkgError || !pkg) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Package not found' })
            return apiError(404, `No available package found for ${network} ${sizeString}. Check network name and volume.`)
        }

        // ── Per-network out-of-stock guard (admin/global) ─────────────────
        // Main-site surface → admin set only (mirrors app/api/orders/purchase).
        // Must run BEFORE any wallet debit / order insert / fulfillment.
        const adminOOS = await getAdminOOSNetworks(supabase)
        if (isNetworkOOS(adminOOS, (pkg as any).network)) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Network out of stock' })
            return apiError(409, `${(pkg as any).network} is out of stock at the moment`)
        }

        // ── Check phone blacklist ─────────────────────────────────────────
        const { data: blacklisted } = await supabase
            .from('phone_blacklist')
            .select('id')
            .eq('phone_number', cleanPhone)
            .single()

        if (blacklisted) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Phone blacklisted' })
            // Generic message — do not confirm the number is on a blacklist
            // (prevents enumeration of the blacklist via probe responses).
            return apiError(400, 'Order cannot be processed for this recipient')
        }

        // MTN AgentPortal whitelist gate — pre-deduction, alongside the existing
        // blacklist/OOS checks. Unlike the blacklist message above, this one is
        // deliberately specific: it's an operational status the developer needs
        // to act on (retry shortly), not a security-sensitive rejection to obscure.
        const whitelistGate = await checkMtnWhitelistGate(cleanPhone, (pkg as any).network, (pkg as any).category)
        if (whitelistGate.blocked) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Not whitelisted' })
            return apiError(409, whitelistGate.reason!)
        }

        // ── Role-based pricing ────────────────────────────────────────────
        // Uses auth.effectiveRole. This route previously ran its OWN inline expiry
        // check (isActiveDealerV1/isActiveAgentV1) deriving expired as
        // `expiry < now` — the ONE site left outside the expiry unification in
        // 44a4059f, and the one the Phase 2A review flagged as creating a NEW
        // inconsistency once every other surface moved to strict `>`. Folding it
        // in here closes that: all pricing on every surface now reads one value
        // from lib/effective-role.ts, and the per-request `users` round-trip this
        // route made purely for the expiry columns is gone (validateApiKey
        // already selected them).
        const isActiveDealer = effectiveRole === 'dealer'
        const isActiveAgent = effectiveRole === 'agent'
        let priceToCharge = isActiveDealer && (pkg as any).dealer_price > 0
            ? (pkg as any).dealer_price
            : isActiveAgent && (pkg as any).agent_price > 0
                ? (pkg as any).agent_price
                : (pkg as any).price

        // Sub-agent pricing overrides the role price entirely (spec C2) — the sub's cost
        // is recruiter-derived, never role-derived. Fails closed before any charge (spec
        // C7). Mashup is excluded from this route already (`.neq('category', 'mtn_mashup')`
        // above), so no separate mashup carve-out is needed here unlike the dashboard route.
        let recruiterMargin: { recruiterId: string; amount: number } | null = null
        if (subCtx.isSub) {
            if (
                subCtx.recruiterId
                && !(await hasSubAgentPricingConfigured(supabase, subCtx.recruiterId, userId, 'data', (pkg as any).id))
            ) {
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Sub-agent pricing unavailable' })
                return apiError(409, 'Pricing is not available for this package right now')
            }

            const resolved = await resolveSubAgentDataCost(supabase, userId, (pkg as any).id, pkg, (pkg as any).category)
            if (!resolved.ok) {
                console.error(`[API Data Purchase] sub cost unresolvable for pkg ${(pkg as any).id} (user ${userId}): ${resolved.reason}`)
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Sub-agent cost unresolvable' })
                return apiError(409, 'Pricing is not available for this package right now')
            }
            priceToCharge = resolved.subCost
            if (resolved.recruiterEarns > 0 && resolved.recruiterId) {
                recruiterMargin = { recruiterId: resolved.recruiterId, amount: resolved.recruiterEarns }
            }
        }

        // Price floor — never charge a zero/invalid amount (broken package row or resolver
        // edge would otherwise ship free data). Not currently reachable (computeSubAgentCost
        // already rejects non-finite/<=0 inputs before resolved.ok can be true, and the plain
        // role-based branch above always resolves to a positive pkg price/tier), but this is
        // the same explicit floor app/api/orders/purchase carries (spec §7.5) — added here for
        // parity rather than relying on that being true forever (payments-security-reviewer
        // finding, 2026-09-17).
        if (!Number.isFinite(priceToCharge) || priceToCharge <= 0) {
            console.error(`[API Data Purchase] 🚨 Invalid priceToCharge ${priceToCharge} for pkg ${(pkg as any).id} (user ${userId}) — blocked`)
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid priceToCharge' })
            return apiError(409, 'This package is temporarily unavailable')
        }

        // ── Atomic wallet deduction ───────────────────────────────────────
        const { data: deductResult, error: deductError } = await (supabase as any)
            .rpc('deduct_wallet_balance', {
                p_user_id: userId,
                p_amount: priceToCharge,
            })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Insufficient balance' })
                return apiError(400, 'Insufficient wallet balance')
            }
            console.error('[API Data Purchase] Wallet deduction error:', deductError)
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Wallet deduction failed' })
            return apiError(500, 'Failed to process payment')
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Wallet not found' })
            return apiError(404, 'Wallet not found')
        }

        // MTN number-registration gate: hold unregistered MTN recipients as 'queued'.
        const queueDecision = await resolveOrderQueueing(cleanPhone, (pkg as any).network)

        // ── Create order ──────────────────────────────────────────────────
        const { data: order, error: orderError } = await (supabase
            .from('orders') as any)
            .insert({
                user_id: userId,
                phone_number: cleanPhone,
                network: (pkg as any).network,
                size: (pkg as any).size,
                price: priceToCharge,
                cost_price_at_time: (pkg as any).cost_price || 0,
                // Records the tier the customer was actually CHARGED at, which is
                // why it uses effectiveRole rather than the raw users.role: a
                // lapsed dealer billed at customer rates should not leave a row
                // claiming role_at_time='dealer'. Matches how airtime_orders.user_role
                // is stamped on the v2 airtime route.
                role_at_time: effectiveRole,
                status: queueDecision.queue ? 'queued' : 'pending',
                payment_status: 'paid',
                reference_code: referenceCode,
                fulfillment_method: 'auto',
                source: 'api',
                api_key_id: apiKeyId,
            })
            .select()
            .single()

        if (orderError) {
            console.error('[API Data Purchase] Order insert error:', orderError)
            // Refund the debited amount atomically so a transient insert failure
            // (or a duplicate-reference collision) never costs the developer money.
            const { error: refundError } = await (supabase as any)
                .rpc('credit_wallet_balance', { p_user_id: userId, p_amount: priceToCharge })
            if (refundError) {
                console.error(`[API Data Purchase] CRITICAL: refund failed for ${referenceCode}, manual reconciliation required:`, refundError)
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order insert failed; refund failed' })
                return apiError(500, 'Order processing failed. Your wallet has been debited. Please contact support with your reference code for assistance.')
            }
            // orders_reference_code_key is a GLOBAL unique constraint (verified on
            // the live DB), not per-user, and references are developer-chosen
            // plaintext. So the overwhelmingly likely cause here is a reference
            // another tenant already used — the user-scoped lookup above found
            // nothing, and this insert then collided. Telling that caller to
            // "please try again" is advice that will fail identically forever;
            // they need to change the reference. Same fix already applied to the
            // v2 airtime/results-checker/AFA endpoints (review finding m1/I5).
            if (orderError.code === '23505' || orderError.message?.includes('duplicate key')) {
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Reference already in use' })
                return apiError(409, 'This reference is already in use. Your wallet was not charged. Choose a different reference.')
            }
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order insert failed; refunded' })
            return apiError(500, 'Order could not be placed. Your wallet was not charged. Please try again.')
        }

        // Sub-agent purchase: credit the ONE direct recruiter (spec C3, C4 — a pending row
        // now, credited by the trigger only once the order actually completes). Never
        // blocks the purchase — the sub already paid, the data must still ship.
        if (recruiterMargin) {
            await recordPendingSubAgentEarning(supabase, {
                orderReference: referenceCode,
                orderTable: 'orders',
                recruiterId: recruiterMargin.recruiterId,
                subUserId: userId,
                amount: recruiterMargin.amount,
            }).catch((e) => console.error('[API Data Purchase] recordPendingSubAgentEarning threw:', e))
        }

        // ── Wallet transaction ────────────────────────────────────────────
        // waitUntil, not a bare floating promise: the wallet has ALREADY been
        // debited by this point, so a lambda freeze immediately after the response
        // would leave the debit with no matching wallet_transactions row — an
        // audit gap on a money path. Same fix already applied to the v2 airtime
        // route (review finding m2).
        waitUntil((supabase.from('wallet_transactions') as any).insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: priceToCharge,
            description: `API data purchase: ${(pkg as any).size} for ${cleanPhone}`,
            reference: referenceCode,
            source: 'purchase',
            status: 'completed',
        }).then(() => {}).catch((e: any) => console.error('[API Data Purchase] Tx insert error:', e)))

        // ── Background: Fulfillment ───────────────────────────────────────
        waitUntil((async () => {
            try {
                const { data: userData } = await supabase
                    .from('users')
                    .select('email, first_name, last_name')
                    .eq('id', userId)
                    .single()

                if (queueDecision.queue) {
                    console.log(`[API Data Purchase] Order ${(order as any).id} QUEUED for MTN number registration — fulfillment held`)
                    return
                }
                const firstName = (userData as any)?.first_name || 'Customer'
                await triggerFulfillment((order as any).id, (pkg as any).network, {
                    email: (userData as any)?.email || 'Unknown',
                    name: `${firstName} ${(userData as any)?.last_name || ''}`.trim() || 'Customer',
                })
            } catch (postPurchaseError) {
                console.error('[API Data Purchase] Post-purchase error:', postPurchaseError)
            }
        })())

        // ── Return immediately ────────────────────────────────────────────
        logApiRequest({
            apiKeyId, userId,
            endpoint, method: 'POST',
            statusCode: 200, responseTimeMs: Date.now() - startTime, ip,
        })

        return apiSuccess({
            order_id: (order as any).id,
            reference: reference,
            status: queueDecision.queue ? 'queued' : 'pending',
            network: (pkg as any).network,
            size: (pkg as any).size,
            recipient: cleanPhone,
            price: priceToCharge,
            new_balance: newBalance,
        }, meta)

    } catch (error: any) {
        console.error('[API Data Purchase] Exception:', error.message)
        logApiRequest({
            apiKeyId: auth.apiKeyId, userId: auth.userId,
            endpoint, method: 'POST',
            statusCode: 500, responseTimeMs: Date.now() - startTime,
            ip, errorMessage: error.message,
        })
        return apiError(500, 'Internal server error')
    }
}
