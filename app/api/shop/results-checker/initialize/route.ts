import { NextRequest, NextResponse } from 'next/server'
import { generateReferenceCode } from '@/lib/utils'
import {
    isStorefrontRCEnabled,
    getMaxQuantity,
    getTypeById,
    getAvailableCount,
    calculateRCPrice,
    getRCSettings,
    resolveShopRCMarkup,
    effectiveRoleFromExpiry,
    applySubAgentRcOverride,
} from '@/lib/results-checker-service'
import {
    SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE,
    SUB_AGENT_PRICING_UNAVAILABLE_STATUS,
} from '@/lib/results-checker-pricing'
import {
    isValidResultsCheckerPhone,
    normalizeResultsCheckerPhone,
} from '@/lib/results-checker-utils'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'

const rateLimitCache = new Map<string, { count: number; resetTime: number }>()

function cleanupCache() {
    const now = Date.now()
    for (const [key, val] of rateLimitCache.entries()) {
        if (val.resetTime < now) rateLimitCache.delete(key)
    }
}

/**
 * POST /api/shop/results-checker/initialize
 *
 * Guest Paystack payment initialization for RC vouchers via shop storefront.
 * Mirrors app/api/shop/initialize/route.ts pattern exactly.
 * No auth required — guest purchase flow.
 */
export async function POST(request: NextRequest) {
    try {
        cleanupCache()

        const ip = request.headers.get('x-forwarded-for') || 'unknown'
        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { shopSlug, typeId, quantity, guestPhone, guestEmail } = body

        // ── Required field validation ──────────────────────────────────────
        if (!shopSlug || !typeId || !quantity || !guestPhone) {
            return NextResponse.json(
                { error: 'Missing required fields: shopSlug, typeId, quantity, guestPhone' },
                { status: 400 }
            )
        }
        // Email is required for RC storefront purchases (voucher delivery channel)
        if (!guestEmail || typeof guestEmail !== 'string' || !guestEmail.trim()) {
            return NextResponse.json(
                { error: 'Email address is required to receive your voucher' },
                { status: 400 }
            )
        }

        // ── Rate limiting (mirrors shop/initialize) ────────────────────────
        const rlKey = `${ip}-rc-${shopSlug}`
        const rlEntry = rateLimitCache.get(rlKey) || { count: 0, resetTime: Date.now() + 60000 }
        if (rlEntry.count >= 5 && rlEntry.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
        }
        rlEntry.count++
        rateLimitCache.set(rlKey, rlEntry)

        // ── Phone validation ───────────────────────────────────────────────
        const cleanPhone = normalizeResultsCheckerPhone(String(guestPhone))
        if (!isValidResultsCheckerPhone(cleanPhone)) {
            return NextResponse.json(
                { error: 'Invalid phone number. Use format: 0XXXXXXXXX or 233XXXXXXXXX' },
                { status: 400 }
            )
        }

        // ── Email validation (required for RC storefront) ──────────────────
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
        const trimmedEmail = guestEmail.trim()
        if (!emailRegex.test(trimmedEmail) || trimmedEmail.length > 254) {
            return NextResponse.json(
                { error: 'Invalid email address. Please provide a valid email to receive your voucher.' },
                { status: 400 }
            )
        }
        const validatedGuestEmail = trimmedEmail.toLowerCase()

        // ── Slug validation ────────────────────────────────────────────────
        if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
            return NextResponse.json({ error: 'Invalid shop identifier' }, { status: 400 })
        }

        const parsedQuantity = parseInt(String(quantity), 10)
        if (isNaN(parsedQuantity) || parsedQuantity < 1) {
            return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })
        }

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        // ── Fetch shop ─────────────────────────────────────────────────────
        const { data: shop, error: shopError } = await db
            .from('shop_profiles')
            .select(`
                id, shop_name, shop_slug, owner_id, approval_status, is_active,
                results_checker_markup_customer,
                results_checker_markup_agent,
                results_checker_markup_dealer,
                owner:users!shop_profiles_owner_id_fkey(role, email, dealer_expires_at, agent_expires_at)
            `)
            .eq('shop_slug', shopSlug)
            .single()

        if (shopError || !shop) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        const rawOwnerRole: string = shop.owner?.role || 'customer'
        // Effective pricing role respects agent/dealer expiry (matches USSD + the data path).
        const ownerRole = effectiveRoleFromExpiry(rawOwnerRole, (shop.owner as any)?.agent_expires_at, (shop.owner as any)?.dealer_expires_at)

        if (
            shop.approval_status !== 'approved' ||
            !shop.is_active ||
            !['customer', 'agent', 'dealer', 'subagent', 'admin', 'sub-admin'].includes(rawOwnerRole)
        ) {
            return NextResponse.json({ error: 'This shop is not currently active' }, { status: 403 })
        }

        // ── Guest Storefront RC enabled check ──────────────────────────────
        // Separate toggle from main-site RC to allow independent control
        const enabled = await isStorefrontRCEnabled()
        if (!enabled) {
            return NextResponse.json({ error: 'Results Checker is currently unavailable' }, { status: 503 })
        }

        // ── Max quantity check ─────────────────────────────────────────────
        const maxQty = await getMaxQuantity()
        if (parsedQuantity > maxQty) {
            return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })
        }

        // ── Validate type ──────────────────────────────────────────────────
        const type = await getTypeById(typeId)
        if (!type || !type.is_active) {
            return NextResponse.json({ error: 'Voucher type not found or unavailable' }, { status: 404 })
        }

        // ── Stock check + backorder control ───────────────────────────────
        // SECURITY (FINDING-1 FIX): Backorders are DENIED by default (secure fail-closed).
        // The admin must explicitly set results_checker_allow_backorders=true in
        // admin_settings to enable the backorder path. This prevents unlimited
        // paid orders being placed when there is no stock to fulfill them.
        // If the key is absent from admin_settings, === 'true' will be false → deny.
        const available = await getAvailableCount(typeId)
        const rcSettings = await getRCSettings()
        const allowBackorders = rcSettings['results_checker_allow_backorders'] === 'true'

        if (!allowBackorders && available < parsedQuantity) {
            return NextResponse.json({
                error: available === 0
                    ? 'This voucher type is currently out of stock. Please check back later.'
                    : `Only ${available} voucher(s) available. Please reduce your quantity.`,
                available,
            }, { status: 400 })
        }

        // ── Server-side pricing (buyer pays Paystack fee on top) ───────────
        // Use the shop owner's role to determine the correct base price tier.
        // Dealers buy at dealer_price; agents at agent_price; everyone else at customer_price.
        // No client-supplied price is ever accepted — all amounts recalculated here.
        const pricingRole =
            ownerRole === 'dealer'    ? 'dealer' :
            ownerRole === 'agent'     ? 'agent'  : 'customer'

        // Per-exam-type markup takes priority; the legacy single markup on
        // shop_profiles is the fallback for shops that haven't configured
        // per-exam pricing yet. Shared with USSD via resolveShopRCMarkup.
        const flatMarkup = parseFloat(String(
            pricingRole === 'dealer' ? ((shop as any).results_checker_markup_dealer ?? 0) :
            pricingRole === 'agent'  ? ((shop as any).results_checker_markup_agent  ?? 0) :
                                       (shop.results_checker_markup_customer ?? 0)
        )) || 0
        const shopMarkupAmount = await resolveShopRCMarkup(db, shop.id, typeId, flatMarkup)

        // ── Sub-agent storefront pricing (Plan 2c, Task 3) ─────────────────
        // The shop OWNER may themselves be a recruited sub-agent. When so, their true
        // wholesale cost basis comes from the sub-agent pricing engine instead of the flat
        // role price derived above — the shop's own markup to the guest is unaffected either
        // way. Fails closed before any order row is created or Paystack is touched.
        const subCtx = await resolveSubAgentContext(db, shop.owner_id)
        let subAgentUnitPrice: number | null = null
        if (subCtx.isSub) {
            const subCostResult = await resolveSubAgentRcCost(db, shop.owner_id, type, parsedQuantity)
            if (!subCostResult.ok) {
                return NextResponse.json({ error: SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE }, { status: SUB_AGENT_PRICING_UNAVAILABLE_STATUS })
            }
            subAgentUnitPrice = subCostResult.subCost
        }

        let breakdown = await calculateRCPrice({
            type,
            quantity: parsedQuantity,
            userRole: pricingRole,
            shopMarkup: shopMarkupAmount,
            includePaystackFee: true,
        })
        if (subAgentUnitPrice !== null) {
            breakdown = applySubAgentRcOverride(breakdown, subAgentUnitPrice, parsedQuantity)
        }

        const unitPrice = breakdown.unitPrice + breakdown.shopMarkup
        const subtotal = breakdown.subtotal
        const paystackFee = breakdown.paystackFee
        const totalCharged = breakdown.total
        const totalAmountKobo = Math.round(totalCharged * 100)

        // ── Paystack setup ─────────────────────────────────────────────────
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) {
            return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })
        }

        // Email is validated and required — use directly (no synthetic fallback needed)
        const paystackEmail = validatedGuestEmail
        const paystackRef = `RC-${shop.id.slice(0, 8)}-${Date.now()}`

        const protocol = request.headers.get('x-forwarded-proto') || 'https'
        const host = request.headers.get('host') || 'kingflexygh.com'

        // Determine the correct base URL for the shop storefront (mirrors shop/verify/route.ts)
        let targetBaseUrl = ''
        if (host.includes('localhost') || host.includes('127.0.0.1')) {
            targetBaseUrl = host.startsWith('shop.') ? `${protocol}://${host}` : `${protocol}://shop.${host}`
        } else {
            targetBaseUrl = 'https://shop.kingflexygh.com'
        }

        // Shop storefront paths never carry a /shop prefix (that prefix belongs to the
        // main-domain router only). The callback always lands on the subdomain.
        const callbackUrl = `${targetBaseUrl}/${shopSlug}?rc_ref=${paystackRef}`

        // ── Create pending order record ────────────────────────────────────
        const referenceCode = paystackRef
        const { data: pendingOrder, error: orderError } = await db
            .from('results_checker_orders')
            .insert({
                shop_id:           shop.id,
                shop_name:         shop.shop_name,
                shop_markup:       breakdown.shopMarkup,
                customer_phone:    cleanPhone,
                customer_email:    validatedGuestEmail,
                type_id:           typeId,
                type_name:         type.name,
                quantity:          parsedQuantity,
                unit_price:        unitPrice,
                cost_price_at_time: type.cost_price,
                fee_amount:        paystackFee,
                total_paid:        totalCharged,
                status:            'pending',
                payment_status:    'pending_payment',
                reference_code:    referenceCode,
            })
            .select('id')
            .single()

        if (orderError || !pendingOrder) {
            console.error('[RC Shop Initialize] Order creation error:', orderError)
            return NextResponse.json({ error: 'Failed to create order record' }, { status: 500 })
        }

        // ── Initialize Paystack ────────────────────────────────────────────
        const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                email:        paystackEmail,
                amount:       totalAmountKobo,
                reference:    paystackRef,
                callback_url: callbackUrl,
                metadata: {
                    rc_order_id:       pendingOrder.id,
                    type_id:           typeId,
                    type_name:         type.name,
                    quantity:          parsedQuantity,
                    shop_id:           shop.id,
                    shop_name:         shop.shop_name,
                    shop_slug:         shopSlug,
                    guest_phone:       cleanPhone,
                    guest_email:       validatedGuestEmail,
                    unit_price:        unitPrice,
                    shop_markup:       breakdown.shopMarkup,
                    subtotal,
                    paystack_fee:      paystackFee,
                    total_charged:     totalCharged,
                    // cost_price intentionally NOT sent to Paystack metadata — it is the admin
                    // supplier margin and is visible to reseller shop owners on the Paystack
                    // dashboard. The order row already stores cost_price_at_time for fulfillment.
                    custom_fields: [
                        { display_name: 'Shop', variable_name: 'shop', value: shop.shop_name },
                        { display_name: 'Phone', variable_name: 'phone', value: cleanPhone },
                        { display_name: 'Order', variable_name: 'order', value: `${parsedQuantity}x ${type.name}` },
                        ...(validatedGuestEmail ? [{ display_name: 'Email', variable_name: 'email', value: validatedGuestEmail }] : []),
                    ],
                },
            }),
        })

        const paystackData = await paystackRes.json()
        if (!paystackData.status) {
            // Rollback pending order
            await db.from('results_checker_orders').delete().eq('id', pendingOrder.id)
            return NextResponse.json({ error: 'Payment initialization failed' }, { status: 500 })
        }

        return NextResponse.json({
            success:           true,
            authorization_url: paystackData.data.authorization_url,
            reference:         paystackRef,
            breakdown: {
                unit_price:   unitPrice,
                quantity:     parsedQuantity,
                subtotal,
                paystack_fee: paystackFee,
                total:        totalCharged,
            },
        })

    } catch (error) {
        console.error('[RC Shop Initialize] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
