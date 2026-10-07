import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
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
import { buildGuestEmail } from '@/lib/shop-checkout'
import {
    isValidResultsCheckerPhone,
    normalizeResultsCheckerPhone,
} from '@/lib/results-checker-utils'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'

// Storefront network name → Paystack mobile_money provider code (mirrors /api/shop/charge).
const PROVIDER_MAP: Record<string, 'MTN' | 'VOD' | 'ATL'> = { MTN: 'MTN', Telecel: 'VOD', AT: 'ATL' }
// MoMo wallet prefix → provider (fallback detection).
const GHANA_NETWORK_MAP: Record<string, 'MTN' | 'VOD' | 'ATL'> = {
    '024': 'MTN', '025': 'MTN', '053': 'MTN', '054': 'MTN', '055': 'MTN', '059': 'MTN',
    '020': 'VOD', '050': 'VOD',
    '026': 'ATL', '027': 'ATL', '056': 'ATL', '057': 'ATL',
}

const rateLimitCache = new Map<string, { count: number; resetTime: number }>()
function cleanup() { const now = Date.now(); for (const [k, v] of rateLimitCache.entries()) if (v.resetTime < now) rateLimitCache.delete(k) }

/**
 * POST /api/shop/results-checker/charge
 *
 * Native in-app Paystack MoMo charge for RC vouchers via shop storefront.
 * Mirrors /api/shop/charge (MoMo) + /api/shop/results-checker/initialize (RC pricing/order).
 * No auth — guest purchase flow. Server is authoritative for price.
 */
export async function POST(request: NextRequest) {
    try {
        cleanup()
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'

        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

        const { shopSlug, typeId, quantity, guestPhone, guestEmail } = body

        if (!shopSlug || !typeId || !quantity || !guestPhone) {
            return NextResponse.json({ error: 'Missing required fields: shopSlug, typeId, quantity, guestPhone' }, { status: 400 })
        }

        // Validate identifiers up front — BEFORE shopSlug is used as the rate-limit cache key
        // and BEFORE typeId reaches any DB query (prevents map-bloat / malformed-input vectors).
        if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
            return NextResponse.json({ error: 'Invalid shop identifier' }, { status: 400 })
        }
        if (typeof typeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(typeId)) {
            return NextResponse.json({ error: 'Invalid voucher type identifier' }, { status: 400 })
        }

        // MoMo wallet to charge (normalize 233XXXXXXXXX → 0XXXXXXXXX)
        let momoPhone: string = (body.momoPhone || '').replace(/\s+/g, '')
        if (/^233\d{9}$/.test(momoPhone)) momoPhone = '0' + momoPhone.slice(3)
        const momoProvider: string | undefined = typeof body.momoProvider === 'string' && body.momoProvider.length <= 12 ? body.momoProvider : undefined
        if (!/^0[0-9]{9}$/.test(momoPhone)) {
            return NextResponse.json({ error: 'Enter a valid Ghana mobile money number (e.g. 0241234567)' }, { status: 400 })
        }
        const provider = (momoProvider && PROVIDER_MAP[momoProvider]) || GHANA_NETWORK_MAP[momoPhone.slice(0, 3)] || null
        if (!provider) {
            return NextResponse.json({ error: 'Could not detect your mobile money network. Please select it.', needsManualSelection: true }, { status: 400 })
        }

        // Rate limit (mirrors RC initialize: 5/min per ip+shop)
        const rlKey = `${ip}-rc-charge-${shopSlug}`
        const rlEntry = rateLimitCache.get(rlKey) || { count: 0, resetTime: Date.now() + 60000 }
        if (rlEntry.count >= 5 && rlEntry.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
        }
        rlEntry.count++; rateLimitCache.set(rlKey, rlEntry)

        // Recipient phone (voucher delivery target) — validated like RC initialize
        const cleanPhone = normalizeResultsCheckerPhone(String(guestPhone))
        if (!isValidResultsCheckerPhone(cleanPhone)) {
            return NextResponse.json({ error: 'Invalid phone number. Use format: 0XXXXXXXXX or 233XXXXXXXXX' }, { status: 400 })
        }

        // Email is OPTIONAL for RC storefront (voucher is also shown on-screen + texted).
        // Validate only when present; blank/invalid → null → synthetic gmail for Paystack.
        let validatedGuestEmail: string | null = null
        if (guestEmail && typeof guestEmail === 'string' && guestEmail.trim()) {
            const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
            const t = guestEmail.trim()
            if (emailRegex.test(t) && t.length <= 254) validatedGuestEmail = t.toLowerCase()
        }

        const parsedQuantity = parseInt(String(quantity), 10)
        if (isNaN(parsedQuantity) || parsedQuantity < 1) return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        const { data: shop, error: shopError } = await db
            .from('shop_profiles')
            .select(`
                id, shop_name, shop_slug, owner_id, approval_status, is_active,
                results_checker_markup_customer, results_checker_markup_agent, results_checker_markup_dealer,
                owner:users!shop_profiles_owner_id_fkey(role, email, dealer_expires_at, agent_expires_at)
            `)
            .eq('shop_slug', shopSlug)
            .single()
        if (shopError || !shop) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

        const rawOwnerRole: string = shop.owner?.role || 'customer'
        // Effective pricing role respects agent/dealer expiry (matches USSD + the data path), so an
        // expired reseller is priced at the customer tier consistently across every surface.
        const ownerRole = effectiveRoleFromExpiry(rawOwnerRole, (shop.owner as any)?.agent_expires_at, (shop.owner as any)?.dealer_expires_at)
        if (shop.approval_status !== 'approved' || !shop.is_active || !['customer', 'agent', 'dealer', 'subagent', 'admin', 'sub-admin'].includes(rawOwnerRole)) {
            return NextResponse.json({ error: 'This shop is not currently active' }, { status: 403 })
        }

        if (!(await isStorefrontRCEnabled())) return NextResponse.json({ error: 'Results Checker is currently unavailable' }, { status: 503 })

        const maxQty = await getMaxQuantity()
        if (parsedQuantity > maxQty) return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })

        const type = await getTypeById(typeId)
        if (!type || !type.is_active) return NextResponse.json({ error: 'Voucher type not found or unavailable' }, { status: 404 })

        // Stock check + backorder control (fail-closed unless admin opts in)
        const available = await getAvailableCount(typeId)
        const rcSettings = await getRCSettings()
        const allowBackorders = rcSettings['results_checker_allow_backorders'] === 'true'
        if (!allowBackorders && available < parsedQuantity) {
            return NextResponse.json({
                error: available === 0
                    ? 'This voucher type is currently out of stock. Please check back later.'
                    : `Only ${available} voucher(s) available. Please reduce your quantity.`,
            }, { status: 400 })
        }

        // Server-side pricing — buyer pays Paystack fee on top. No client price trusted.
        const pricingRole = ownerRole === 'dealer' ? 'dealer' : ownerRole === 'agent' ? 'agent' : 'customer'
        const flatMarkup = parseFloat(String(
            pricingRole === 'dealer' ? ((shop as any).results_checker_markup_dealer ?? 0) :
            pricingRole === 'agent'  ? ((shop as any).results_checker_markup_agent  ?? 0) :
                                       (shop.results_checker_markup_customer ?? 0)
        )) || 0
        // Per-exam override (shop_rc_markups) wins over the flat role-based markup — shared with
        // USSD via resolveShopRCMarkup so the two surfaces can't drift.
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
            type, quantity: parsedQuantity, userRole: pricingRole, shopMarkup: shopMarkupAmount, includePaystackFee: true,
        })
        if (subAgentUnitPrice !== null) {
            breakdown = applySubAgentRcOverride(breakdown, subAgentUnitPrice, parsedQuantity)
        }
        const unitPrice = breakdown.unitPrice + breakdown.shopMarkup
        const totalCharged = breakdown.total
        const totalAmountKobo = Math.round(totalCharged * 100)

        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })

        const paystackEmail = validatedGuestEmail || buildGuestEmail(shop.shop_name, cleanPhone)
        const paystackRef = `RC-${shop.id.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`

        // Create pending order BEFORE charging (so the webhook/status poll can fulfill idempotently)
        const { data: pendingOrder, error: orderError } = await db
            .from('results_checker_orders')
            .insert({
                shop_id: shop.id, shop_name: shop.shop_name, shop_markup: breakdown.shopMarkup,
                customer_phone: cleanPhone, customer_email: validatedGuestEmail,
                type_id: typeId, type_name: type.name, quantity: parsedQuantity,
                unit_price: unitPrice, cost_price_at_time: type.cost_price,
                fee_amount: breakdown.paystackFee, total_paid: totalCharged,
                status: 'pending', payment_status: 'pending_payment', reference_code: paystackRef,
            })
            .select('id').single()
        if (orderError || !pendingOrder) {
            console.error('[RC Charge] Order creation error:', orderError)
            return NextResponse.json({ error: 'Failed to create order record' }, { status: 500 })
        }

        const paystackRes = await fetch('https://api.paystack.co/charge', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: paystackEmail, amount: totalAmountKobo, currency: 'GHS', reference: paystackRef,
                mobile_money: { phone: momoPhone, provider },
                metadata: {
                    rc_order_id: pendingOrder.id, type_id: typeId, type_name: type.name, quantity: parsedQuantity,
                    shop_id: shop.id, shop_name: shop.shop_name, shop_slug: shopSlug,
                    guest_phone: cleanPhone, guest_email: validatedGuestEmail,
                    unit_price: unitPrice, shop_markup: breakdown.shopMarkup,
                    subtotal: breakdown.subtotal, paystack_fee: breakdown.paystackFee,
                    total_charged: totalCharged, // cost_price NOT in metadata — admin margin, leaks to owners via Paystack dashboard (order row keeps it)
                    custom_fields: [
                        { display_name: 'Shop', variable_name: 'shop', value: shop.shop_name },
                        { display_name: 'Phone', variable_name: 'phone', value: cleanPhone },
                        { display_name: 'Order', variable_name: 'order', value: `${parsedQuantity}x ${type.name}` },
                    ],
                },
            }),
        })
        const paystackData = await paystackRes.json()
        if (!paystackData.status || !paystackData.data) {
            // Roll back the pending order so it doesn't linger
            await db.from('results_checker_orders').delete().eq('id', pendingOrder.id)
            const safeMessage = typeof paystackData.message === 'string' && paystackData.message.length > 0 && paystackData.message.length < 200
                ? paystackData.message
                : 'Failed to initiate charge'
            return NextResponse.json({ error: safeMessage }, { status: 502 })
        }

        return NextResponse.json({
            status: paystackData.data.status, // send_otp | pay_offline | pending | success | failed | ...
            reference: paystackRef,
            display_text: paystackData.data.display_text || paystackData.data.message || '',
            total: Math.round(totalAmountKobo) / 100,
        })
    } catch (error) {
        console.error('[RC Charge] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
