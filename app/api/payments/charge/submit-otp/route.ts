import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function POST(request: NextRequest) {
    try {
        const { reference, otp } = await request.json()

        if (!reference || typeof reference !== 'string' || reference.trim() === '') {
            return NextResponse.json({ error: 'Reference is required' }, { status: 400 })
        }

        if (!otp || typeof otp !== 'string' || otp.trim() === '') {
            return NextResponse.json({ error: 'OTP is required' }, { status: 400 })
        }

        // SEC-015: validate shape before forwarding to Paystack (reject malformed/oversized input)
        const REFERENCE_SHAPE = /^[A-Za-z0-9_-]{6,64}$/
        if (!REFERENCE_SHAPE.test(reference)) {
            return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
        }

        const otpLen = otp.trim().length
        if (otpLen < 4 || otpLen > 10) {
            return NextResponse.json({ error: 'Invalid OTP' }, { status: 400 })
        }

        const supabase = await createRouteClient()
        const supabaseAdmin = createServerClient()

        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: paymentRow } = await (supabaseAdmin.from('wallet_payments') as any)
            .select('user_id, status')
            .eq('reference', reference)
            .maybeSingle()

        if (!paymentRow) {
            return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
        }

        if (paymentRow.user_id !== authUser.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        if (paymentRow.status !== 'pending') {
            return NextResponse.json({ error: 'Payment is not awaiting OTP' }, { status: 400 })
        }

        const res = await fetch('https://api.paystack.co/charge/submit_otp', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ reference, otp }),
        })

        const data = await res.json()

        if (!data.status || !data.data) {
            console.error('[ChargeOTP] OTP submission failed:', data)
            return NextResponse.json({ error: 'OTP submission failed' }, { status: 500 })
        }

        return NextResponse.json({
            status: data.data.status,
            display_text: data.data.display_text || data.data.message || '',
        })
    } catch (error) {
        console.error('[ChargeOTP] Unhandled error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
