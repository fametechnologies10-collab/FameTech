import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'

// Owners may edit only tags and notes — every other column is system-managed
// by the order triggers.
const updateSchema = z.object({
    customerId: z.string().uuid(),
    tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
    notes: z.string().max(500).optional().nullable(),
}).refine(d => d.tags !== undefined || d.notes !== undefined, {
    message: 'Nothing to update',
})

// ─── GET — list this owner's customers ───────────────────────────────────────
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        // RLS-aware client: the owner-select policy guarantees only this
        // shop's customers come back.
        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ success: true, data: { customers: [] } })
        }

        const shopId = (shop as any).id

        const { data: customers, error } = await supabase
            .from('shop_customers')
            .select('id, phone, name, tags, notes, total_orders, total_spent, first_order_at, last_order_at')
            .eq('shop_id', shopId)
            .order('last_order_at', { ascending: false })
            .limit(1000)

        if (error) {
            console.error('[ShopCustomers] List error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load customers' }, { status: 500 })
        }

        // Flag customers who bought via USSD (data orders source='ussd',
        // results-checker source='ussd_shop') so the owner can see which
        // customers came through their USSD shop code. Only the small USSD
        // subset is scanned — both queries are filtered by source + shop.
        const [ussdData, ussdRc] = await Promise.all([
            supabase.from('shop_orders').select('guest_phone').eq('shop_id', shopId).in('source', ['ussd', 'ussd_shop']),
            supabase.from('results_checker_orders').select('customer_phone').eq('shop_id', shopId).in('source', ['ussd', 'ussd_shop']),
        ])
        const ussdPhones = new Set<string>()
        for (const r of ((ussdData.data as any[]) || [])) if (r.guest_phone) ussdPhones.add(r.guest_phone)
        for (const r of ((ussdRc.data as any[]) || [])) if (r.customer_phone) ussdPhones.add(r.customer_phone)

        const withFlag = ((customers as any[]) || []).map(c => ({ ...c, from_ussd: ussdPhones.has(c.phone) }))

        return NextResponse.json({ success: true, data: { customers: withFlag } })
    } catch (err) {
        console.error('[ShopCustomers] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── PATCH — update tags/notes on one customer ───────────────────────────────
export async function PATCH(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const body = await req.json()
        const parsed = updateSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid input' },
                { status: 400 }
            )
        }

        const updates: Record<string, any> = { updated_at: new Date().toISOString() }
        if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags
        if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes?.trim() || null

        // shop_customers is server-write-only (authenticated holds no UPDATE
        // grant — see docs/security-audits/2026-09-24-client-order-forgery.md),
        // so resolve the caller's shop via the RLS client, then write with the
        // service role scoped to BOTH the customer id and that shop — a foreign
        // customerId simply matches zero rows.
        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 })
        }

        const admin = createServerClient()
        const { data, error } = await (admin as any)
            .from('shop_customers')
            .update(updates)
            .eq('id', parsed.data.customerId)
            .eq('shop_id', (shop as any).id)
            .select('id')
            .maybeSingle()

        if (error) {
            console.error('[ShopCustomers] Update error:', error)
            return NextResponse.json({ success: false, error: 'Failed to update customer' }, { status: 500 })
        }
        if (!data) {
            return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, data: {} })
    } catch (err) {
        console.error('[ShopCustomers] PATCH error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
