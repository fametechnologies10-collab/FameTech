import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// Customer-facing columns ONLY. This used to be `select('*')`, which also returned
// fulfillment_service ("kingflexy-commission"), the raw supplier response in fulfillment_metadata,
// admin_fee_amount / commission_amount (our margin) and api_key_id to every buyer. Customers must
// never learn which wholesaler we route through (see the supplier checklist in
// fametech-fulfillment, item 20), so list what the page renders and nothing else.
const CUSTOMER_COLUMNS = [
    'id', 'reference_code', 'network', 'beneficiary_phone',
    'airtime_amount', 'fee_amount', 'total_paid', 'use_exact_amount',
    'status', 'type', 'bundle_preference', 'created_at',
].join(', ')

const MAX_PAGE_SIZE = 200

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    const n = parseInt(raw || '', 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const supabase = createServerClient()

        const { searchParams } = new URL(request.url)
        const page = clampInt(searchParams.get('page'), 1, 1, 100000)
        const limit = clampInt(searchParams.get('limit'), 20, 1, MAX_PAGE_SIZE)
        const offset = (page - 1) * limit

        const { data: orders, error, count } = await (supabase.from('airtime_orders') as any)
            .select(CUSTOMER_COLUMNS, { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (error) {
            console.error('[Airtime History] Error:', error)
            return NextResponse.json({ error: 'Failed to load order history' }, { status: 500 })
        }

        return NextResponse.json({
            orders: orders || [],
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit)
        })
    } catch (error) {
        console.error('[Airtime History] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
