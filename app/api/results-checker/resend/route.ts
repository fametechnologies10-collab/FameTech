import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { resendVouchers } from '@/lib/results-checker-notification-service'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export async function POST(req: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { orderId } = await req.json()

        if (!orderId) {
            return NextResponse.json({ error: 'Order ID is required' }, { status: 400 })
        }

        // SEC-014: validate orderId format before any DB round-trip, so a malformed
        // value gets a uniform 400 instead of racing the ownership-lookup's 403 below.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
            return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 })
        }

        // Verify that the user owns the order OR is an admin
        const { data: user } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        const isAdmin = user?.role === 'admin'

        if (!isAdmin) {
            const { data: order } = await supabase
                .from('results_checker_orders')
                .select('id')
                .eq('id', orderId)
                .eq('user_id', authUser.id)
                .single()

            if (!order) {
                return NextResponse.json({ error: 'Unauthorized or Order not found' }, { status: 403 })
            }
        }

        const { allowed } = consumeRateLimit(`rc-resend:${authUser.id}:${orderId}`, 3, 10 * 60 * 1000)
        if (!allowed) {
            return NextResponse.json({ error: 'Too many resend attempts. Please try again later.' }, { status: 429 })
        }

        const result = await resendVouchers(orderId)

        if (!result.success) {
            return NextResponse.json({ error: result.error || 'Failed to resend vouchers' }, { status: 500 })
        }

        return NextResponse.json({ success: true, message: 'Vouchers resent successfully' })
    } catch (error: any) {
        console.error('[RC Resend API] Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
