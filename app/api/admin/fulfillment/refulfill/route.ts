import { cookies } from 'next/headers'
import { createRouteClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fulfillOrder } from '@/lib/fulfillment-service'
import { syncShopOrderStatus } from '@/lib/shop-service'

// Create a service role client to bypass RLS for administrative fulfillment
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
)

export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Verify admin role
        const { data: user } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!user || (user.role !== 'admin' && user.role !== 'sub-admin')) {
            return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 })
        }

        const body = await request.json()
        const { orderIds } = body

        const { processRefulfillment } = await import('@/lib/refulfillment-service')
        
        // Call the shared service for manual refulfillment (isCron: false)
        const result = await processRefulfillment(false, orderIds)

        return NextResponse.json(result)
    } catch (error: any) {
        console.error('[ManualRefulfill] Route Error:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
