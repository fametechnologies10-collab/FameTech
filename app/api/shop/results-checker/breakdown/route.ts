import { NextRequest, NextResponse } from 'next/server'
import {
    isStorefrontRCEnabled,
    getMaxQuantity,
    getTypeById,
    calculateRCPrice,
    resolveShopRCMarkup,
    effectiveRoleFromExpiry,
    applySubAgentRcOverride,
} from '@/lib/results-checker-service'
import {
    SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE,
    SUB_AGENT_PRICING_UNAVAILABLE_STATUS,
} from '@/lib/results-checker-pricing'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'

const rateLimitCache = new Map<string, { count: number; resetTime: number }>()
function cleanup() { const now = Date.now(); for (const [k, v] of rateLimitCache.entries()) if (v.resetTime < now) rateLimitCache.delete(k) }

/**
 * POST /api/shop/results-checker/breakdown
 *
 * Server-authoritative RC price preview for a storefront purchase. The browser
 * cannot reproduce the charge amount because the server floors bulk prices at the
 * (secret) cost_price and caps the shop markup at the per-role maximum — neither of
 * which can be exposed to the client. So the sheet asks the server for the exact
 * total it WILL charge and displays THAT, instead of a locally-estimated number.
 *
 * Mirrors the price resolution in /api/shop/results-checker/charge EXACTLY, but
 * creates no order, starts no charge, and NEVER returns cost_price.
 * No auth — guest preview. Read-only.
 */
export async function POST(request: NextRequest) {
    try {
        cleanup()
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'

        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

        const { shopSlug, typeId, quantity } = body

        // Validate identifiers BEFORE shopSlug is used as a rate-limit key or typeId hits a query.
        if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
            return NextResponse.json({ error: 'Invalid shop identifier' }, { status: 400 })
        }
        if (typeof typeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(typeId)) {
            return NextResponse.json({ error: 'Invalid voucher type identifier' }, { status: 400 })
        }
        const parsedQuantity = parseInt(String(quantity), 10)
        if (isNaN(parsedQuantity) || parsedQuantity < 1) return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })

        // Light rate limit (30/min per ip+shop) — this is a read-only preview but still hits the DB.
        const rlKey = `${ip}-rc-breakdown-${shopSlug}`
        const rlEntry = rateLimitCache.get(rlKey) || { count: 0, resetTime: Date.now() + 60000 }
        if (rlEntry.count >= 30 && rlEntry.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
        }
        rlEntry.count++; rateLimitCache.set(rlKey, rlEntry)

        // Service-role read, exactly like the sibling /charge and /initialize guest endpoints:
        // the RC pricing helpers (getRCSettings/getTypeById/calculateRCPrice) all read
        // admin_settings + types server-side and there is no authenticated user on a guest
        // preview. SAFETY: this endpoint is READ-ONLY and the response below is an explicit
        // field whitelist that NEVER includes cost_price (the admin supplier margin).
        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        const { data: shop, error: shopError } = await db
            .from('shop_profiles')
            .select(`
                id, shop_slug, owner_id, approval_status, is_active,
                results_checker_markup_customer, results_checker_markup_agent, results_checker_markup_dealer,
                owner:users!shop_profiles_owner_id_fkey(role, dealer_expires_at, agent_expires_at)
            `)
            .eq('shop_slug', shopSlug)
            .single()
        if (shopError || !shop) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

        const rawOwnerRole: string = shop.owner?.role || 'customer'
        // Effective pricing role respects agent/dealer expiry (matches USSD + the data path).
        const ownerRole = effectiveRoleFromExpiry(rawOwnerRole, (shop.owner as any)?.agent_expires_at, (shop.owner as any)?.dealer_expires_at)
        if (shop.approval_status !== 'approved' || !shop.is_active || !['customer', 'agent', 'dealer', 'subagent', 'admin', 'sub-admin'].includes(rawOwnerRole)) {
            return NextResponse.json({ error: 'This shop is not currently active' }, { status: 403 })
        }

        if (!(await isStorefrontRCEnabled())) return NextResponse.json({ error: 'Results Checker is currently unavailable' }, { status: 503 })

        const maxQty = await getMaxQuantity()
        if (parsedQuantity > maxQty) return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })

        const type = await getTypeById(typeId)
        if (!type || !type.is_active) return NextResponse.json({ error: 'Voucher type not found or unavailable' }, { status: 404 })

        // Resolve role + markup EXACTLY as the charge route does (per-exam override wins).
        const pricingRole = ownerRole === 'dealer' ? 'dealer' : ownerRole === 'agent' ? 'agent' : 'customer'
        const flatMarkup = parseFloat(String(
            pricingRole === 'dealer' ? ((shop as any).results_checker_markup_dealer ?? 0) :
            pricingRole === 'agent'  ? ((shop as any).results_checker_markup_agent  ?? 0) :
                                       (shop.results_checker_markup_customer ?? 0)
        )) || 0
        // Per-exam override wins over the flat markup — shared with USSD via resolveShopRCMarkup.
        const shopMarkupAmount = await resolveShopRCMarkup(db, shop.id, typeId, flatMarkup)

        // ── Sub-agent storefront pricing (review finding C1) ───────────────────────────────
        // This is a PRICE PREVIEW — no order row, no Paystack call — but it must show the
        // SAME price initialize/charge will actually collect, or a recruited shop owner's
        // guest sees one number here and gets charged a different one when they pay. Wired
        // identically to initialize/charge: same resolver, same override helper, same
        // rejection message/status (no order created yet, so a clean 409 is safe here too).
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

        // unitPrice here is the customer-facing per-voucher price (base + markup). cost_price is
        // deliberately omitted — it is the admin's supplier margin and must never reach the browser.
        return NextResponse.json({
            unitPrice: breakdown.unitPrice + breakdown.shopMarkup,
            shopMarkup: breakdown.shopMarkup,
            subtotal: breakdown.subtotal,
            paystackFee: breakdown.paystackFee,
            total: breakdown.total,
            quantity: parsedQuantity,
        })
    } catch (error) {
        console.error('[RC Breakdown] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
