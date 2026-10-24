import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function GET() {
    try {
        const routeClient = await createRouteClient()
        const { data: { user }, error: authError } = await routeClient.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // Customer-safe columns only: never fulfillment_metadata, kf_order_ref or commission_amount.
        const supabase = createServerClient()
        const { data, error } = await (supabase as any).from('standard_bundle_orders')
            .select('id, reference_code, status, network, kind, bundle_label, beneficiary_phone, total_paid, created_at, completed_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50)

        if (error) {
            console.error('[StandardBundles] history error:', error.message)
            return NextResponse.json({ success: false, error: 'Failed to load orders' }, { status: 500 })
        }

        const orders = (data || []).map((o: any) => ({ ...o, total_paid: Number(o.total_paid) }))
        return NextResponse.json({ success: true, data: { orders } })
    } catch (e) {
        console.error('[StandardBundles] history unexpected error:', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
