import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { getResultsCheckerOrderForUser } from '@/lib/results-checker-retrieval'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request) {
    try {
        const supabase = await createRouteClient()

        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { orderId } = await req.json()
        if (!orderId || !UUID_REGEX.test(String(orderId))) {
            return NextResponse.json({ error: 'Valid order ID is required' }, { status: 400 })
        }

        const result = await getResultsCheckerOrderForUser(String(orderId), user.id)
        if (!result) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        return NextResponse.json(result)
    } catch (err) {
        console.error('[RC Order Vouchers API] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
