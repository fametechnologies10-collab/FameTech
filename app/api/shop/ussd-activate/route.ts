import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { generateUssdCode } from '@/lib/ussd/code-generator'

const activateSchema = z.object({
    paidFrom: z.enum(['wallet', 'profit']),
})

// admin_settings.value is JSONB — a fee stored as "50.00" arrives quoted.
function parseFee(rawFee: unknown): number {
    const feeStr = typeof rawFee === 'string' ? rawFee.replace(/^"|"$/g, '') : String(rawFee ?? '50.00')
    const fee = parseFloat(feeStr)
    return isNaN(fee) ? 50 : fee
}

// GET — activation fee plus the caller's wallet & profit balances, so the page
// can render the pay-source selector and pre-select whichever covers the fee.
// The fee is public; balances need auth and default to 0 when unauthenticated
// (keeps the public fee read working).
export async function GET() {
    const db = createServerClient() as any

    const { data: feeSetting } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'ussd_shop_activation_fee')
        .maybeSingle()
    const fee = parseFee(feeSetting?.value)

    let walletBalance = 0
    let profitBalance = 0
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user } } = await supabaseAuth.auth.getUser()
        if (user) {
            // Only shop owners can activate USSD — don't surface balances to
            // anyone else. Reads are scoped to the verified session's own id.
            const { data: shop } = await db
                .from('shop_profiles')
                .select('id')
                .eq('owner_id', user.id)
                .maybeSingle()
            if (shop) {
                const [walletRes, profitRes] = await Promise.all([
                    db.from('wallets').select('balance').eq('user_id', user.id).maybeSingle(),
                    db.from('shop_wallets').select('balance').eq('owner_id', user.id).maybeSingle(),
                ])
                walletBalance = parseFloat((walletRes.data as any)?.balance ?? '0') || 0
                profitBalance = parseFloat((profitRes.data as any)?.balance ?? '0') || 0
            }
        }
    } catch {
        // balances are best-effort — keep 0/0 on any auth/read failure
    }

    return NextResponse.json({ fee, walletBalance, profitBalance })
}

// POST — one-time paid activation, debiting WALLET or PROFIT. All money
// movement + activation happens atomically inside activate_shop_ussd (a
// service-role-only RPC). This route only authenticates, rate-limits, supplies
// a candidate code, and translates RPC errors.
export async function POST(req: NextRequest) {
    const supabaseAuth = await createRouteClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rl = consumeRateLimit(`ussd-activate:${user.id}`, 5, 60 * 60 * 1000)
    if (!rl.allowed) {
        return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
    }

    let body: unknown
    try {
        body = await req.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const parsed = activateSchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid payment source' }, { status: 400 })
    }
    const paidFrom = parsed.data.paidFrom

    const db = createServerClient() as any

    // Fee for the error message only — the RPC reads its own authoritative copy.
    const { data: feeSetting } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'ussd_shop_activation_fee')
        .maybeSingle()
    const fee = parseFee(feeSetting?.value)

    // Generate a candidate code and retry only on CODE_TAKEN (a UNIQUE
    // collision). The RPC rolls its debit back on collision, so retrying can
    // never double-charge. Every other RPC error is terminal.
    for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = generateUssdCode()
        const { data, error } = await db.rpc('activate_shop_ussd', {
            p_owner_id:  user.id,
            p_paid_from: paidFrom,
            p_code:      candidate,
        })

        if (!error) {
            const result = (data ?? {}) as { code?: string; already_active?: boolean }
            return NextResponse.json({
                success:       true,
                code:          result.code ?? candidate,
                alreadyActive: result.already_active ?? false,
            })
        }

        const msg = error.message || ''
        if (msg.includes('CODE_TAKEN')) {
            continue // collision — try a fresh candidate
        }
        if (msg.includes('INVALID_SOURCE')) {
            return NextResponse.json({ error: 'Invalid payment source' }, { status: 400 })
        }
        if (msg.includes('SHOP_NOT_FOUND')) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }
        if (msg.includes('SHOP_NOT_APPROVED')) {
            return NextResponse.json(
                { error: 'Shop must be approved and active before activating USSD' },
                { status: 403 },
            )
        }
        if (msg.includes('INSUFFICIENT_BALANCE')) {
            return NextResponse.json(
                { error: `Insufficient ${paidFrom} balance. Required: GHS ${fee.toFixed(2)}` },
                { status: 402 },
            )
        }
        console.error('[USSD Activate] RPC error:', error)
        return NextResponse.json({ error: 'Activation failed. Please try again.' }, { status: 500 })
    }

    return NextResponse.json(
        { error: 'Could not generate a unique code. Please try again.' },
        { status: 503 },
    )
}
