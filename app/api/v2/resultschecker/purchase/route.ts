import { NextRequest } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { isRCEnabled, getMaxQuantity, getAvailableCount, getTypeById, purchaseWithWallet } from '@/lib/results-checker-service'
import {
    SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE,
    SUB_AGENT_PRICING_UNAVAILABLE_STATUS,
} from '@/lib/results-checker-pricing'
import { phoneSchema, emailSchema } from '@/lib/validation'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'

// ============================================================================
// POST /api/v2/resultschecker/purchase
// Vouchers are ALWAYS returned in the response body — recipientPhone/Email
// are optional with NO fallback to the caller's own account details (unlike
// the dashboard route). Omit them and KFT sends nothing; the developer owns
// delivery. Out-of-stock is rejected upfront via a pre-check, before any
// wallet debit. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §3.
//
// referenceCode/apiKeyId/source are passed INTO purchaseWithWallet (not
// stamped on via a post-hoc .update()) — see CONTROLLER RULING R2 in
// task-6-brief.md. A post-hoc update runs after purchaseWithWallet already
// returned, so its own webhook-dispatch hook would see api_key_id as null;
// threading the params in makes idempotency, the UNIQUE(reference_code)
// backstop, and the webhook hook all line up on the first call.
// ============================================================================

const ENDPOINT = '/api/v2/resultschecker/purchase'

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

    try {
        // Sub-agent eligibility (spec §11 lift, 2026-09-17): purchaseWithWallet
        // (lib/results-checker-service.ts) now resolves sub-agent pricing for every
        // caller regardless of source — only the pending/suspended/ineligible-recruiter
        // gate is checked here, at the route level, before any other work.
        const subCtx = await resolveSubAgentContext(supabase, userId)
        if (subCtx.isSub && !subCtx.effectiveActive) {
            done(403, 'Sub-agent inactive')
            return apiError(403, subCtx.inactiveReason || 'Your account is not currently active')
        }

        const rl = consumeRateLimit(`v2-rc-purchase:${apiKeyId}`, 10, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (10/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        let body: any
        try { body = await request.json() } catch {
            done(400, 'Invalid JSON')
            return apiError(400, 'Invalid request body')
        }

        const { typeId, quantity, recipientPhone, recipientEmail, reference } = body || {}

        if (!typeId || !quantity) {
            done(400, 'Missing fields')
            return apiError(400, 'Missing required fields: typeId, quantity')
        }
        const parsedQuantity = parseInt(String(quantity), 10)
        if (isNaN(parsedQuantity) || parsedQuantity < 1) {
            done(400, 'Invalid quantity')
            return apiError(400, 'Quantity must be a positive integer')
        }
        if (!reference || typeof reference !== 'string' || reference.length < 3 || reference.length > 100) {
            done(400, 'Invalid reference')
            return apiError(400, 'reference is required (3-100 characters) — your unique transaction ID for idempotency')
        }
        const referenceCode = `API-${reference}`

        const { data: existingOrder } = await (supabase.from('results_checker_orders') as any)
            .select('id, reference_code, status, type_name, quantity, unit_price, total_paid, inventory_ids')
            .eq('reference_code', referenceCode).eq('user_id', userId).maybeSingle()
        if (existingOrder) {
            let vouchers: any[] = []
            if ((existingOrder as any).inventory_ids?.length) {
                const { data: v } = await (supabase.from('results_checker_inventory') as any)
                    .select('id, pin, serial_number').in('id', (existingOrder as any).inventory_ids)
                vouchers = v || []
            }
            done(200)
            return apiSuccess({
                order: { id: existingOrder.id, reference, status: existingOrder.status, type_name: existingOrder.type_name, quantity: existingOrder.quantity, unit_price: parseFloat(String(existingOrder.unit_price)), total_paid: parseFloat(String(existingOrder.total_paid)) },
                vouchers, is_duplicate: true,
            }, { version: 'v2' })
        }

        const { data: userRow } = await (supabase.from('users') as any).select('id').eq('id', userId).single()
        if (!userRow) {
            done(404, 'User not found')
            return apiError(404, 'User not found')
        }
        // Expiry-aware, so a lapsed reseller is priced the same here as on the
        // storefront and USSD (both already use effectiveRoleFromExpiry).
        const userRole = effectiveRole

        if (!(await isRCEnabled())) {
            done(503, 'RC disabled')
            return apiError(503, 'Results Checker is currently unavailable')
        }
        const maxQty = await getMaxQuantity()
        if (parsedQuantity > maxQty) {
            done(400, 'Over max quantity')
            return apiError(400, `Maximum ${maxQty} vouchers per order`)
        }
        const type = await getTypeById(typeId)
        if (!type || !type.is_active) {
            done(404, 'Type not found')
            return apiError(404, 'Voucher type not found or unavailable')
        }

        // Reject upfront, before any wallet debit — never accept-then-refund
        // for the common insufficient-stock case.
        const available = await getAvailableCount(typeId)
        if (available < parsedQuantity) {
            done(400, 'Insufficient stock')
            return apiError(400, `Insufficient stock. Available: ${available}`)
        }

        const rawRecipientPhone = recipientPhone ? String(recipientPhone).trim() : ''
        const rawRecipientEmail = recipientEmail ? String(recipientEmail).trim() : ''
        if (rawRecipientPhone && !phoneSchema.safeParse(rawRecipientPhone).success) {
            done(400, 'Invalid recipient phone')
            return apiError(400, 'Invalid recipient phone number')
        }
        if (rawRecipientEmail && !emailSchema.safeParse(rawRecipientEmail).success) {
            done(400, 'Invalid recipient email')
            return apiError(400, 'Invalid recipient email address')
        }

        // NO fallback to the caller's own account phone/email — deliberate
        // v2 divergence from the dashboard route. Omitted means "developer
        // handles delivery themselves."
        const customerPhone = rawRecipientPhone || null
        const customerEmail = rawRecipientEmail || null

        let purchaseResult
        try {
            purchaseResult = await purchaseWithWallet({
                userId, userRole, typeId, quantity: parsedQuantity,
                customerPhone, customerEmail, customerName: null,
                apiKeyId, source: 'api', referenceCode,
            })
        } catch (err: any) {
            if (err.message === 'INSUFFICIENT_BALANCE') {
                done(400, 'Insufficient balance')
                return apiError(400, 'Insufficient wallet balance. Please top up.')
            }
            if (err.message === 'INSUFFICIENT_INVENTORY') {
                if (apiKeyId) {
                    waitUntil((async () => {
                        const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                        await dispatchApiWebhook(supabase, {
                            apiKeyId, event: 'order.failed', product: 'resultschecker',
                            reference, status: 'failed',
                            detail: { type_name: type.name, quantity: parsedQuantity },
                        })
                    })())
                }
                done(400, 'Race: stock depleted')
                return apiError(400, 'Vouchers sold out. Please try again later.')
            }
            if (err.message === 'VOUCHER_TYPE_NOT_FOUND') {
                done(404, 'Type not found')
                return apiError(404, 'Voucher type not found or unavailable')
            }
            // purchaseWithWallet throws this when the order insert fails, which for an
            // API caller is nearly always the global UNIQUE(reference_code) rejecting a
            // reference already used (possibly by another account — the constraint is not
            // per-user). Unmapped it surfaced as a bare 500 "Internal server error", which
            // tells the developer nothing actionable. purchaseWithWallet reverses its own
            // debit before throwing, so the wallet really is untouched.
            if (err.message === 'ORDER_CREATION_FAILED') {
                done(409, 'Reference already in use')
                return apiError(409, 'This reference is already in use. Your wallet was not charged. Choose a different reference.')
            }
            // Genuinely reachable now (2026-09-17 spec §11 lift lets sub-agents through):
            // an unconfigured/zero-markup product, or one whose price became unresolvable
            // between checkout and this call. Mirrors app/api/results-checker/purchase and
            // app/api/user/afa-registration's analogous 409 handling.
            if (err.message === 'SUB_AGENT_PRICING_UNAVAILABLE') {
                done(409, 'Pricing unavailable')
                return apiError(SUB_AGENT_PRICING_UNAVAILABLE_STATUS, SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE)
            }
            throw err
        }

        const { order, vouchers, newBalance } = purchaseResult

        if (apiKeyId) {
            waitUntil((async () => {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                await dispatchApiWebhook(supabase, {
                    apiKeyId, event: 'order.completed', product: 'resultschecker',
                    reference, status: 'completed',
                    detail: { type_name: order.type_name, quantity: order.quantity },
                })
            })())
        }

        // Delivery, only if recipient fields were given (best-effort, non-blocking).
        // waitUntil, not a bare floating promise: the vouchers are already sold and the wallet
        // already debited, so a lambda freeze here would silently strand the customer's PINs.
        // (They remain recoverable via GET /resultschecker/orders/:reference and the resend
        // paths, but the developer would never learn delivery was skipped.)
        if (customerPhone || customerEmail) {
            const { deliverVouchers } = await import('@/lib/results-checker-notification-service')
            waitUntil(
                deliverVouchers({ ...order, customer_phone: customerPhone, customer_email: customerEmail, customer_name: null, user_id: userId }, vouchers)
                    .catch((err: any) => console.error('[API v2 RC Purchase] Delivery error:', err))
            )
        }

        done(200)
        return apiSuccess({
            order: { id: order.id, reference, status: order.status, type_name: order.type_name, quantity: order.quantity, unit_price: order.unit_price, total_paid: order.total_paid },
            vouchers, new_balance: newBalance,
        }, { version: 'v2' })

    } catch (error: any) {
        console.error('[API v2 RC Purchase] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
