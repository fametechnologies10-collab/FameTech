import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import {
    isRCEnabled,
    getMaxQuantity,
    getAvailableCount,
    getTypeById,
    purchaseWithWallet,
} from '@/lib/results-checker-service'
import {
    SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE,
    SUB_AGENT_PRICING_UNAVAILABLE_STATUS,
} from '@/lib/results-checker-pricing'
import { deliverVouchers } from '@/lib/results-checker-notification-service'
import { phoneSchema, emailSchema } from '@/lib/validation'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'

/**
 * POST /api/results-checker/purchase
 *
 * Authenticated wallet-based purchase.
 * Mirrors app/api/airtime/create/route.ts pattern exactly.
 */
export async function POST(request: NextRequest) {
    try {
        // ── Auth (same pattern as airtime/create L17-28) ───────────────────
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const supabase = createServerClient()
        const db = supabase as any

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { typeId, quantity, recipientPhone, recipientEmail } = body

        // ── Validate required fields ───────────────────────────────────────
        if (!typeId || !quantity) {
            return NextResponse.json({ error: 'Missing required fields: typeId, quantity' }, { status: 400 })
        }

        const parsedQuantity = parseInt(String(quantity), 10)
        if (isNaN(parsedQuantity) || parsedQuantity < 1) {
            return NextResponse.json({ error: 'Quantity must be a positive integer' }, { status: 400 })
        }

        // ── Fetch user role ────────────────────────────────────────────────
        const { data: userData, error: userError } = await db
            .from('users')
            .select('role, first_name, last_name, email, phone_number, dealer_expires_at, agent_expires_at')
            .eq('id', userId)
            .single()

        if (userError || !userData) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        // Expiry-aware. The shop/storefront RC routes already used
        // effectiveRoleFromExpiry; this dashboard route did not, so a lapsed reseller
        // was quoted customer prices on the storefront but still charged agent prices
        // here. Now one rule across every surface. See lib/effective-role.ts.
        const userRole = effectiveRoleFromExpiry(
            userData.role,
            (userData as any).agent_expires_at ?? null,
            (userData as any).dealer_expires_at ?? null,
        )

        // ── Feature enabled check ──────────────────────────────────────────
        const enabled = await isRCEnabled()
        if (!enabled) {
            return NextResponse.json({ error: 'Results Checker is currently unavailable' }, { status: 503 })
        }

        // ── Max quantity check (server-side) ──────────────────────────────
        const maxQty = await getMaxQuantity()
        if (parsedQuantity > maxQty) {
            return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })
        }

        // ── Validate type exists and is active ────────────────────────────
        const type = await getTypeById(typeId)
        if (!type || !type.is_active) {
            return NextResponse.json({ error: 'Voucher type not found or unavailable' }, { status: 404 })
        }

        // ── Available stock check ──────────────────────────────────────────
        const available = await getAvailableCount(typeId)
        if (available < parsedQuantity) {
            return NextResponse.json({
                error: `Insufficient stock. Available: ${available}`,
                available,
            }, { status: 400 })
        }

        // ── 30-second idempotency guard (mirrors airtime/create L122-137) ─
        const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString()
        const { data: recentOrder } = await db
            .from('results_checker_orders')
            .select('id, reference_code')
            .eq('user_id', userId)
            .eq('type_id', typeId)
            .eq('quantity', parsedQuantity)
            .gte('created_at', thirtySecondsAgo)
            .maybeSingle()

        if (recentOrder) {
            return NextResponse.json({
                error: 'Duplicate order detected. Please wait 30 seconds before placing the same order again.',
                isDuplicate: true,
            }, { status: 409 })
        }

        // ── Purchase via wallet ────────────────────────────────────────────
        // Use the optional recipient contact details if provided; fall back to the
        // authenticated user's own account details. Persisted on the order row itself
        // (not just merged in-memory for this call) so any later resend — the admin/user
        // resend button or the fulfill-pending-rc-vouchers retry cron — has a customer to
        // deliver to.
        const rawRecipientPhone = recipientPhone ? String(recipientPhone).trim() : ''
        const rawRecipientEmail = recipientEmail ? String(recipientEmail).trim() : ''

        if (rawRecipientPhone && !phoneSchema.safeParse(rawRecipientPhone).success) {
            return NextResponse.json({ error: 'Invalid recipient phone number' }, { status: 400 })
        }
        if (rawRecipientEmail && !emailSchema.safeParse(rawRecipientEmail).success) {
            return NextResponse.json({ error: 'Invalid recipient email address' }, { status: 400 })
        }

        const customerPhone = rawRecipientPhone || userData.phone_number || null
        const customerEmail = rawRecipientEmail || userData.email || null
        const customerName = `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || null

        const { order, vouchers, newBalance } = await purchaseWithWallet({
            userId,
            userRole,
            typeId,
            quantity: parsedQuantity,
            customerPhone,
            customerEmail,
            customerName,
        })

        // ── Deliver vouchers (non-blocking post-response) ─────────────────
        const orderForDelivery = { ...order, customer_phone: customerPhone, customer_email: customerEmail, customer_name: customerName }
        deliverVouchers(orderForDelivery, vouchers)
            .catch((err: any) => console.error('[RC Purchase] Delivery error:', err))

        return NextResponse.json({
            success:     true,
            order: {
                id:             order.id,
                reference_code: order.reference_code,
                type_name:      order.type_name,
                quantity:       order.quantity,
                unit_price:     order.unit_price,
                total_paid:     order.total_paid,
                status:         order.status,
            },
            vouchers,
            newBalance,
        })

    } catch (error: any) {
        console.error('[RC Purchase] Unexpected error:', error)

        if (error.message === 'INSUFFICIENT_BALANCE') {
            return NextResponse.json({ error: 'Insufficient wallet balance. Please top up.' }, { status: 400 })
        }
        if (error.message === 'INSUFFICIENT_INVENTORY') {
            return NextResponse.json({ error: 'Vouchers sold out. Please try again later.' }, { status: 400 })
        }
        if (error.message === 'VOUCHER_TYPE_NOT_FOUND') {
            return NextResponse.json({ error: 'Voucher type not found or unavailable' }, { status: 404 })
        }
        if (error.message === 'SUB_AGENT_PRICING_UNAVAILABLE') {
            // Mirrors app/api/user/afa-registration/route.ts's analogous 409 for the same
            // failure shape (review finding I2) — previously fell through to the generic 500
            // below, which leaked nothing actionable to the user and read as a server bug.
            return NextResponse.json({ error: SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE }, { status: SUB_AGENT_PRICING_UNAVAILABLE_STATUS })
        }

        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
