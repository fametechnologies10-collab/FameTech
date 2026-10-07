import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { isCommissionTransferEnabled } from '@/lib/commission-wallet'

export async function POST(request: NextRequest) {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const rl = consumeRateLimit(`commission-transfer:${user.id}`, 10, 60_000)
    if (!rl.allowed) {
        return NextResponse.json({ success: false, error: `Rate limit exceeded. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` }, { status: 429 })
    }

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

    const { destination, amount } = body || {}
    if (destination !== 'main' && destination !== 'shop') {
        return NextResponse.json({ success: false, error: "destination must be 'main' or 'shop'" }, { status: 400 })
    }
    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return NextResponse.json({ success: false, error: 'Invalid amount' }, { status: 400 })
    }

    const admin = createServerClient() as any
    const { data: settingsRows } = await admin.from('admin_settings').select('key, value').eq('key', 'commission_transfer_enabled')
    const settingsMap: Record<string, any> = {}
    for (const s of (settingsRows || [])) settingsMap[s.key] = s.value
    if (!isCommissionTransferEnabled(settingsMap)) {
        return NextResponse.json({ success: false, error: 'Internal transfers are currently disabled' }, { status: 503 })
    }

    const roundedAmount = Math.round(parsedAmount * 100) / 100

    // Double-transfer guard: the RPC's row lock already makes concurrent transfers
    // money-safe (balance can never go negative), so this is a UX guard against an
    // accidental rapid double-click/double-submit sending the same transfer twice —
    // same shape as the 30s duplicate-order guard in lib/api-handlers/utilities-pay.ts.
    // Best-effort only (read-then-act, not atomic) — it closes the common case, not
    // a determined attacker; the RPC's own lock is what actually prevents overdraft.
    // Both lookups below intentionally ignore their `error` field and fail OPEN
    // (fall through to the RPC unaffected) rather than fail closed — a transient DB
    // hiccup on this UX-only guard must never block a legitimate transfer.
    const { data: wallet } = await admin.from('commission_wallets').select('id').eq('owner_id', user.id).maybeSingle()
    if (wallet) {
        const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString()
        const destType = destination === 'main' ? 'transfer_out_main' : 'transfer_out_shop'
        // `.eq('amount', roundedAmount)` compares a JS number against a numeric
        // column — safe for the 2-decimal GHS amounts this route accepts, but a
        // pathological float-rounding edge case could in theory miss a match.
        // Acceptable: this guard is UX-only, never the money-safety mechanism.
        const { data: recent } = await admin.from('commission_wallet_transactions')
            .select('id')
            .eq('commission_wallet_id', wallet.id)
            .eq('type', destType)
            .eq('amount', roundedAmount)
            .gte('created_at', tenSecondsAgo)
            .limit(1)
            .maybeSingle()
        if (recent) {
            return NextResponse.json({ success: false, error: 'Duplicate transfer — please wait a few seconds before retrying' }, { status: 409 })
        }
    }

    const { data: rpcResult, error } = await admin.rpc('transfer_commission_wallet', {
        p_owner_id: user.id,
        p_amount: roundedAmount,
        p_destination: destination,
    })
    if (error) {
        console.error('[Commission Transfer] RPC error:', error)
        return NextResponse.json({ success: false, error: 'Transfer failed' }, { status: 500 })
    }
    if (!rpcResult?.success) {
        const errorMap: Record<string, string> = {
            no_commission_wallet: 'You do not have a commission wallet yet',
            insufficient_balance: 'Insufficient commission wallet balance',
            no_shop_wallet: 'You do not have a shop wallet to transfer into',
            invalid_amount: 'Invalid amount',
            invalid_destination: 'Invalid destination',
        }
        return NextResponse.json({ success: false, error: errorMap[rpcResult?.error] || 'Transfer failed' }, { status: 400 })
    }

    return NextResponse.json({ success: true, data: { destination, amount: rpcResult.amount } })
}
