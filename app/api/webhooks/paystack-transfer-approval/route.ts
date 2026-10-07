import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// Paystack posts the transfer payload here before processing. We approve ONLY
// transfers that correspond to a paystack_pending row WE created with a matching
// amount. Anything else (e.g. a transfer initiated with a stolen secret key) is
// rejected -> Paystack marks it 'rejected' and no money moves. Respond fast.
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}))
        const data = body?.data ?? body
        const reference: string | undefined = data?.reference
        const amountSub: number | undefined = data?.amount   // pesewas
        if (!reference || typeof amountSub !== 'number') {
            return NextResponse.json({}, { status: 400 })
        }
        const db = createServerClient() as any
        const { data: row } = await db
            .from('shop_wallet_transactions')
            .select('id, net_amount, status')
            .eq('paystack_transfer_reference', reference)
            .eq('status', 'paystack_pending')
            .maybeSingle()

        if (!row) return NextResponse.json({}, { status: 400 })             // default-deny
        const expectedSub = Math.round(Number(row.net_amount) * 100)
        if (amountSub !== expectedSub) return NextResponse.json({}, { status: 400 })

        return NextResponse.json({}, { status: 200 })                        // approve
    } catch {
        return NextResponse.json({}, { status: 400 })                        // fail closed
    }
}
