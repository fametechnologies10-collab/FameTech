import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
} from '@/lib/api-auth'
import { createServerClient } from '@/lib/supabase'
import { generateReferenceCode } from '@/lib/utils'
import { waitUntil } from '@vercel/functions'
import { getAdminOOSNetworks, isNetworkOOS } from '@/lib/network-stock'
import { resolveOrderQueueing } from '@/lib/number-registration'
import { checkMtnWhitelistGateBatch } from '@/lib/mtn-whitelist-gate'
import { triggerFulfillment } from '@/lib/fulfillment-trigger'
import { versionMeta } from '@/lib/api-version'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'

// ============================================================================
// lib/api-handlers/data-bulk.ts
// Handler for POST /api/v2/data/bulk.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Place up to MAX_BULK_ORDERS data orders in a single batch via API.
// Mirrors app/api/orders/bulk-purchase/route.ts logic:
//   validate all orders → resolve packages → compute total →
//   atomic wallet deduction → batch insert → background fulfillment
//
// Sub-agent pricing (2026-09-17): each item is priced individually — a batch
// can mix packages carrying different configured recruiter markups — via the
// same resolveSubAgentDataCost used by lib/api-handlers/data-purchase.ts and
// app/api/orders/purchase. Ahead of the dashboard's own bulk-purchase route
// (app/api/orders/bulk-purchase), which still blocks sub-agents outright —
// this is the first surface to support per-item sub-agent bulk pricing.
// ============================================================================

const VALID_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']
const MAX_BULK_ORDERS = 100

interface BulkOrderInput {
    network: string
    volume_gb: number
    recipient: string
    reference?: string
}

export async function handleDataBulk(request: NextRequest) {
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

        // Sub-agent eligibility (2026-09-17): each item is priced individually below
        // (a batch can mix packages with different configured markups) — only the
        // pending/suspended/ineligible-recruiter gate is checked here, before any
        // other work, same as every other purchase surface.
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

        const { orders } = body

        if (!Array.isArray(orders) || orders.length === 0) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'No orders' })
            return apiError(400, 'orders array is required and must not be empty')
        }

        if (orders.length > MAX_BULK_ORDERS) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Too many orders' })
            return apiError(400, `Maximum ${MAX_BULK_ORDERS} orders per batch`)
        }

        // ── Validate each order item ──────────────────────────────────────
        const ghanaPhoneRegex = /^0\d{9}$/
        const errors: string[] = []

        for (let i = 0; i < orders.length; i++) {
            const o = orders[i] as BulkOrderInput
            if (!o.network || !VALID_NETWORKS.includes(o.network)) {
                errors.push(`Order ${i + 1}: Invalid network "${o.network}"`)
            }
            if (!o.volume_gb || typeof o.volume_gb !== 'number' || o.volume_gb <= 0) {
                errors.push(`Order ${i + 1}: Invalid volume_gb`)
            }
            if (!o.recipient || !ghanaPhoneRegex.test(o.recipient.replace(/\s+/g, ''))) {
                errors.push(`Order ${i + 1}: Invalid recipient phone number`)
            }
        }

        if (errors.length > 0) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: errors.join('; ') })
            return apiError(400, errors.join('; '))
        }

        // ── Resolve all packages by network + volume_gb ───────────────────
        // Build unique (network, size) pairs to query
        const uniquePairs = new Map<string, string>()
        for (const o of orders as BulkOrderInput[]) {
            const key = `${o.network}|${o.volume_gb}GB`
            uniquePairs.set(key, `${o.volume_gb}GB`)
        }

        // Fetch all needed packages in one query
        const { data: allPackages, error: pkgsError } = await (supabase
            .from('data_packages') as any)
            .select('*')
            .eq('is_available', true)
            .neq('category', 'mtn_mashup')

        if (pkgsError || !allPackages) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Failed to load packages' })
            return apiError(500, 'Failed to load packages')
        }

        // Build lookup map: "MTN|5GB" → package
        const pkgMap = new Map<string, any>()
        for (const p of allPackages as any[]) {
            pkgMap.set(`${p.network}|${p.size}`, p)
        }

        // Per-network out-of-stock guard (admin/global). Fetched once before the
        // validation loop so a batch containing a hidden network is rejected
        // BEFORE any wallet deduction (mirrors app/api/orders/bulk-purchase).
        const adminOOS = await getAdminOOSNetworks(supabase)

        // ── Map each order to its package and compute price ───────────────
        // Uses auth.effectiveRole. This route previously ran its OWN inline expiry
        // check deriving expired as `expiry < now`; together with data/purchase's,
        // these were the last two sites outside the expiry unification in 44a4059f,
        // and the ones the Phase 2A review flagged as creating a NEW inconsistency
        // once every other surface moved to strict `>`. All pricing now reads one
        // value from lib/effective-role.ts, and the per-request `users` round-trip
        // this route made purely for the expiry columns is gone — validateApiKey
        // already selected them.
        const isActiveDealerBulk = effectiveRole === 'dealer'
        const isActiveAgentBulk = effectiveRole === 'agent'

        const validatedOrders: any[] = []
        const missingPackages: string[] = []

        for (let i = 0; i < orders.length; i++) {
            const o = orders[i] as BulkOrderInput
            const sizeString = `${o.volume_gb}GB`
            const key = `${o.network}|${sizeString}`
            const pkg = pkgMap.get(key)

            if (!pkg) {
                missingPackages.push(`Order ${i + 1}: ${o.network} ${sizeString} not found`)
                continue
            }

            if (isNetworkOOS(adminOOS, pkg.network)) {
                missingPackages.push(`Order ${i + 1}: ${pkg.network} is out of stock at the moment`)
                continue
            }

            let price: number
            // Sub-agent recruiter margin for THIS item, if any — recorded per-order after
            // insert (matching the single-item /data/purchase pattern), since a batch can
            // mix packages with different configured markups.
            let recruiterAmount = 0

            if (subCtx.isSub) {
                // Same "unconfigured = unbuyable" server-side teeth as every other
                // sub-agent pricing surface (spec C4) — treated as an item-level failure
                // in the SAME missingPackages list a not-found/OOS package already uses,
                // so the whole batch fails closed (404) rather than silently skipping or
                // mispricing one item, matching this file's own existing convention that
                // a bad item rejects the batch rather than partial-succeeding.
                if (
                    subCtx.recruiterId
                    && !(await hasSubAgentPricingConfigured(supabase, subCtx.recruiterId, userId, 'data', pkg.id))
                ) {
                    missingPackages.push(`Order ${i + 1}: Pricing is not available for ${o.network} ${sizeString} right now`)
                    continue
                }

                const resolved = await resolveSubAgentDataCost(supabase, userId, pkg.id, pkg, pkg.category)
                if (!resolved.ok) {
                    console.error(`[API Data Bulk] sub cost unresolvable for pkg ${pkg.id} (user ${userId}): ${resolved.reason}`)
                    missingPackages.push(`Order ${i + 1}: Pricing is not available for ${o.network} ${sizeString} right now`)
                    continue
                }
                price = resolved.subCost
                if (resolved.recruiterEarns > 0 && resolved.recruiterId) {
                    recruiterAmount = resolved.recruiterEarns
                }
            } else {
                price = isActiveDealerBulk && pkg.dealer_price > 0
                    ? pkg.dealer_price
                    : isActiveAgentBulk && pkg.agent_price > 0
                        ? pkg.agent_price
                        : pkg.price
            }

            validatedOrders.push({
                phoneNumber: o.recipient.replace(/\s+/g, ''),
                network: pkg.network,
                size: pkg.size,
                packagePrice: price,
                costPrice: pkg.cost_price || 0,
                category: pkg.category,
                clientReference: o.reference || null,
                recruiterAmount,
            })
        }

        if (missingPackages.length > 0) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: missingPackages.join('; ') })
            return apiError(404, missingPackages.join('; '))
        }

        // ── MTN AgentPortal whitelist gate â€” filter out blocked MTN items ──
        // Partial-process, same as the dashboard bulk route: blocked items are
        // skipped (not charged, not created) and reported individually; the
        // rest of the batch still goes through. A batch with EVERY item blocked
        // is still a valid response (0 placed, N skipped) â€” not a client error.
        const whitelistResults = await checkMtnWhitelistGateBatch(
            validatedOrders.map((o: any) => ({ phoneNumber: o.phoneNumber, network: o.network, category: o.category }))
        )
        const skipped: { recipient: string; reason: string }[] = []
        const chargeableOrders = validatedOrders.filter((o: any) => {
            const result = whitelistResults.get(o.phoneNumber)
            if (result?.blocked) {
                skipped.push({ recipient: o.phoneNumber, reason: result.reason || 'Not yet whitelisted' })
                return false
            }
            return true
        })

        if (chargeableOrders.length === 0) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            return apiSuccess({ orders_placed: 0, total_cost: 0, new_balance: null, orders: [], skipped }, meta)
        }

        // Price floor — never charge a zero/invalid amount for any item (mirrors the
        // single-item /data/purchase parity fix). Not currently reachable
        // (computeSubAgentCost already rejects non-finite/<=0 inputs, and the plain
        // role-based branch always resolves to a positive tier/customer price), but
        // explicit rather than assumed.
        const invalidPriced = chargeableOrders.filter((o: any) => !Number.isFinite(o.packagePrice) || o.packagePrice <= 0)
        if (invalidPriced.length > 0) {
            console.error(`[API Data Bulk] 🚨 Invalid packagePrice on ${invalidPriced.length} item(s) for user ${userId} — blocked`)
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid packagePrice' })
            return apiError(409, 'One or more packages are temporarily unavailable')
        }

        // ── Calculate total and deduct atomically ─────────────────────────
        const totalCost = chargeableOrders.reduce((sum: number, o: any) => sum + o.packagePrice, 0)

        const { data: deductResult, error: deductError } = await (supabase as any)
            .rpc('deduct_wallet_balance', {
                p_user_id: userId,
                p_amount: totalCost,
            })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Insufficient balance' })
                return apiError(400, `Insufficient wallet balance. Need GHS ${totalCost.toFixed(2)}`)
            }
            console.error('[API Bulk] Wallet deduction error:', deductError)
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

        // ── Generate reference codes and insert all orders ────────────────
        const referenceCodes = chargeableOrders.map((o: any) =>
            o.clientReference ? `API-${o.clientReference}` : `API-${generateReferenceCode()}`
        )

        // MTN number-registration gate â€” per row; unregistered MTN numbers held 'queued'.
        const queueDecisions = await Promise.all(
            chargeableOrders.map((order: any) => resolveOrderQueueing(order.phoneNumber, order.network))
        )

        const orderInserts = chargeableOrders.map((order: any, i: number) => ({
            user_id: userId,
            phone_number: order.phoneNumber,
            network: order.network,
            size: order.size,
            price: order.packagePrice,
            cost_price_at_time: order.costPrice,
            role_at_time: effectiveRole,
            status: queueDecisions[i].queue ? 'queued' : 'pending',
            payment_status: 'paid',
            reference_code: referenceCodes[i],
            fulfillment_method: 'auto',
            source: 'api',
            api_key_id: apiKeyId,
        }))

        const { data: createdOrders, error: ordersError } = await (supabase.from('orders') as any)
            .insert(orderInserts)
            .select('id, reference_code, network, size, phone_number, price, status')

        if (ordersError) {
            console.error('[API Bulk] Order insert error:', ordersError)
            // Refund the full debited amount atomically. A duplicate batch that
            // collides on a per-order reference_code fails the whole insert here
            // (all-or-nothing) and is fully refunded, so retries never double-charge.
            const { error: refundError } = await (supabase as any)
                .rpc('credit_wallet_balance', { p_user_id: userId, p_amount: totalCost })
            if (refundError) {
                console.error('[API Bulk] CRITICAL: refund failed, manual reconciliation required:', refundError)
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order insert failed; refund failed' })
                return apiError(500, 'Order processing failed. Your wallet has been debited. Please contact support for assistance.')
            }
            // orders_reference_code_key is a GLOBAL unique constraint (verified on
            // the live DB), not per-user, and batch references are developer-chosen
            // plaintext. The insert is all-or-nothing, so ONE colliding reference —
            // possibly one another tenant already used — fails the entire batch.
            // "Please try again" is advice that will fail identically forever; the
            // caller has to change that reference. Same fix already applied to
            // data/purchase and the v2 airtime/RC/AFA endpoints (finding m1/I5).
            // The full refund above has already run, so the wallet really is intact.
            if (ordersError.code === '23505' || ordersError.message?.includes('duplicate key')) {
                logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Reference already in use' })
                return apiError(409, 'One or more references in this batch are already in use. Your wallet was not charged. Use fresh references and retry.')
            }
            logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order insert failed; refunded' })
            return apiError(500, 'Orders could not be placed. Your wallet was not charged. Please try again.')
        }

        // Sub-agent purchase: credit the ONE direct recruiter for each item that carries a
        // margin (spec C3, C4 — a pending row now, credited by the trigger only once each
        // order actually completes). Never blocks the batch — the sub already paid, the
        // data must still ship. referenceCodes[i] is the SAME value just persisted as that
        // order's own reference_code, matching the trigger's lookup.
        if (subCtx.isSub && subCtx.recruiterId) {
            const recruiterId = subCtx.recruiterId
            await Promise.all(
                chargeableOrders.map((order: any, i: number) =>
                    order.recruiterAmount > 0
                        ? recordPendingSubAgentEarning(supabase, {
                            orderReference: referenceCodes[i],
                            orderTable: 'orders',
                            recruiterId,
                            subUserId: userId,
                            amount: order.recruiterAmount,
                        }).catch((e) => console.error(`[API Data Bulk] recordPendingSubAgentEarning threw for ${referenceCodes[i]}:`, e))
                        : Promise.resolve()
                )
            )
        }

        // ── Wallet transactions (batch insert) ────────────────────────────
        const txInserts = chargeableOrders.map((order: any, i: number) => ({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: order.packagePrice,
            description: `API bulk purchase: ${order.size} for ${order.phoneNumber}`,
            reference: referenceCodes[i],
            source: 'purchase',
            status: 'completed',
        }))

        // waitUntil, not a bare floating promise: the wallet has ALREADY been
        // debited for the whole batch by this point, so a lambda freeze right
        // after the response would leave that debit with no matching
        // wallet_transactions rows — an audit gap on a money path, and a larger
        // one here than on the single-order route since it covers the entire
        // batch at once. Same fix already applied to data/purchase and the v2
        // airtime route (review finding m2).
        waitUntil((supabase.from('wallet_transactions') as any).insert(txInserts)
            .then(() => {}).catch((e: any) => console.error('[API Data Bulk] Tx insert error:', e)))

        // ── Background fulfillment ────────────────────────────────────────
        if (createdOrders && (createdOrders as any[]).length > 0) {
            waitUntil((async () => {
                try {
                    const { data: userData } = await supabase
                        .from('users')
                        .select('email, first_name, last_name')
                        .eq('id', userId)
                        .single()

                    const userName = `${(userData as any)?.first_name || ''} ${(userData as any)?.last_name || ''}`.trim() || 'Customer'
                    const userEmail = (userData as any)?.email || 'Unknown'

                    // Fulfill each order â€” queued (unregistered MTN) orders are held.
                    for (const createdOrder of createdOrders as any[]) {
                        if (createdOrder.status === 'queued') {
                            console.log(`[API Bulk] Order ${createdOrder.id} QUEUED for MTN number registration â€” fulfillment held`)
                            continue
                        }
                        try {
                            await triggerFulfillment(createdOrder.id, createdOrder.network, { email: userEmail, name: userName })
                        } catch (err) {
                            console.error(`[API Bulk] Fulfillment error for ${createdOrder.id}:`, err)
                        }
                    }
                } catch (bgError) {
                    console.error('[API Bulk] Background fulfillment error:', bgError)
                }
            })())
        }

        // ── Return response ───────────────────────────────────────────────
        logApiRequest({
            apiKeyId, userId,
            endpoint, method: 'POST',
            statusCode: 200, responseTimeMs: Date.now() - startTime, ip,
        })

        // Strip "API-" prefix from references in response for developer clarity
        const responseOrders = (createdOrders as any[]).map((o: any) => ({
            order_id: o.id,
            reference: o.reference_code.replace(/^API-/, ''),
            status: o.status === 'queued' ? 'queued' : 'pending',
            network: o.network,
            size: o.size,
            recipient: o.phone_number,
            price: parseFloat(String(o.price)),
        }))

        return apiSuccess({
            orders_placed: chargeableOrders.length,
            total_cost: totalCost,
            new_balance: newBalance,
            orders: responseOrders,
            skipped,
        }, meta)

    } catch (error: any) {
        console.error('[API Bulk] Exception:', error.message)
        logApiRequest({
            apiKeyId: auth.apiKeyId, userId: auth.userId,
            endpoint, method: 'POST',
            statusCode: 500, responseTimeMs: Date.now() - startTime,
            ip, errorMessage: error.message,
        })
        return apiError(500, 'Internal server error')
    }
}
