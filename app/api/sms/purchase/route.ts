/**
 * POST /api/sms/purchase — buy an SMS credit bundle (KFT SMS).
 *
 * v1 pay source: main wallet (atomic conditional debit inside
 * purchase_user_sms_credits; ledger key purchase:{client_key} makes retries
 * no-ops). The RPC + schema already support paid_from='momo' with
 * payment_reference + PSP amount verification — the direct-MoMo charge sheet
 * is a wired-ready follow-up (users can meanwhile top up the wallet via the
 * existing MoMo rails).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { getSmsAccountContext } from '@/lib/sms-campaign-pipeline'
import { clearLowBalanceFlag } from '@/lib/sms-low-balance-alert'

export const dynamic = 'force-dynamic'

const purchaseSchema = z.object({
    bundleId: z.string().uuid(),
    // Client-generated idempotency key so a double-tap / retry can never
    // double-debit (UNIQUE ledger key server-side).
    clientKey: z.string().min(8).max(80),
})

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-purchase:${user.id}`, 10, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const body = await request.json().catch(() => null)
        const parsed = purchaseSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid request' }, { status: 400 })
        }

        const db = createServerClient() as any
        const ctxRes = await getSmsAccountContext(db, user.id)
        if (!ctxRes.ok) {
            return NextResponse.json({ success: false, error: ctxRes.error }, { status: ctxRes.status })
        }

        const { data, error } = await db.rpc('purchase_user_sms_credits', {
            p_user_id: user.id,
            p_bundle_id: parsed.data.bundleId,
            p_paid_from: 'wallet',
            p_client_key: `${user.id}:${parsed.data.clientKey}`,
        })
        if (error) {
            const msg = error.message || ''
            if (msg.includes('INSUFFICIENT_BALANCE')) return NextResponse.json({ success: false, error: 'Insufficient wallet balance' }, { status: 402 })
            if (msg.includes('BUNDLE_NOT_FOUND')) return NextResponse.json({ success: false, error: 'Bundle not available' }, { status: 404 })
            if (msg.includes('ACCOUNT_SUSPENDED')) return NextResponse.json({ success: false, error: 'Your SMS account is suspended' }, { status: 403 })
            if (msg.includes('BUNDLE_MODE_MISMATCH')) return NextResponse.json({ success: false, error: 'This bundle is not available for your account type' }, { status: 400 })
            console.error('[SMS Purchase] rpc error:', msg)
            return NextResponse.json({ success: false, error: 'Purchase failed' }, { status: 500 })
        }

        clearLowBalanceFlag(db, ctxRes.ctx.account.id).catch(() => {})

        return NextResponse.json({ success: true, data })
    } catch (e: any) {
        console.error('[SMS Purchase] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
