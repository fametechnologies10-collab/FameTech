import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import {
    createMomoRecipient, initiateTransfer, buildWithdrawalReference, getBalanceGhs, PAYSTACK_MOMO_BANK_CODE,
} from '@/lib/paystack-transfer-service'

const maskNumber = (n: string | null | undefined) => !n ? '' : n.length <= 4 ? '****' : '*'.repeat(n.length - 4) + n.slice(-4)
// Provider failure messages may echo account data — clamp + namespace them before storing/logging.
const maskNote = (e?: string | null) => (e ? `Paystack: ${e}`.slice(0, 500) : null)

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const db = createServerClient() as any
    const { data: user } = await db.from('users').select('role').eq('id', authUser.id).single()
    return user?.role === 'admin' || user?.role === 'sub-admin' ? { id: authUser.id, role: user.role } : null
}

export async function GET(request: NextRequest) {
    const supabase = await createRouteClient()
    const admin = await verifyAdmin(supabase)
    if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const db = createServerClient() as any
    const { data: wallets, error: walletsError } = await db
        .from('commission_wallets')
        .select('id, owner_id, balance, total_earned, total_withdrawn, users:owner_id(email, first_name, last_name)')
        .order('total_earned', { ascending: false })
        .limit(200)
    if (walletsError) {
        console.error('[commission-wallets] GET wallets', { msg: walletsError.message })
        return NextResponse.json({ success: false, error: 'Failed to load wallets' }, { status: 500 })
    }

    const { data: pendingWithdrawals, error: pendingError } = await db
        .from('commission_wallet_transactions')
        .select('id, commission_wallet_id, amount, net_amount, fee, status, momo_number, network, account_name, created_at, commission_wallets:commission_wallet_id(owner_id, users:owner_id(email, first_name, last_name))')
        .eq('type', 'withdrawal')
        .in('status', ['pending', 'paystack_pending'])
        .order('created_at', { ascending: true })
        .limit(100)
    if (pendingError) {
        console.error('[commission-wallets] GET pending_withdrawals', { msg: pendingError.message })
        return NextResponse.json({ success: false, error: 'Failed to load pending withdrawals' }, { status: 500 })
    }

    return NextResponse.json({
        success: true,
        data: {
            wallets: (wallets || []).map((w: any) => ({
                id: w.id, owner_id: w.owner_id, balance: w.balance, total_earned: w.total_earned,
                total_withdrawn: w.total_withdrawn, email: w.users?.email, name: `${w.users?.first_name || ''} ${w.users?.last_name || ''}`.trim(),
            })),
            pending_withdrawals: (pendingWithdrawals || []).map((t: any) => ({
                id: t.id, status: t.status, amount: t.amount, net_amount: t.net_amount, fee: t.fee, momo_number: maskNumber(t.momo_number), network: t.network,
                account_name: t.account_name, created_at: t.created_at,
                owner_id: t.commission_wallets?.owner_id,
                owner_email: t.commission_wallets?.users?.email,
                owner_name: `${t.commission_wallets?.users?.first_name || ''} ${t.commission_wallets?.users?.last_name || ''}`.trim(),
            })),
        },
    })
}

export async function PATCH(request: NextRequest) {
    const supabase = await createRouteClient()
    const admin = await verifyAdmin(supabase)
    if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    // Both approve (real payout) and reject (balance-affecting reversal) are full-admin only —
    // sub-admins get 403 on either. GET stays open to sub-admin for read-only visibility (SEC-022).
    if (admin.role !== 'admin') {
        return NextResponse.json({ success: false, error: 'Forbidden — requires full admin' }, { status: 403 })
    }

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid body' }, { status: 400 }) }
    const { action, transaction_id, note } = body || {}
    if (action !== 'approve' && action !== 'reject') {
        return NextResponse.json({ success: false, error: "action must be 'approve' or 'reject'" }, { status: 400 })
    }
    if (typeof transaction_id !== 'string') {
        return NextResponse.json({ success: false, error: 'transaction_id is required' }, { status: 400 })
    }

    const db = createServerClient() as any

    if (action === 'reject') {
        // FIX 1(a): a row already handed to Paystack (paystack_pending) must NEVER be rejected —
        // the RPC would credit the gross amount back while Paystack may still pay it out, a real
        // double-payout. Pre-check status/type here in addition to the RPC's own narrowed guard
        // (status = 'pending' only, see 20260901d migration).
        const { data: rejectTx } = await db.from('commission_wallet_transactions')
            .select('id, status, type')
            .eq('id', transaction_id).single()
        if (!rejectTx) return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 })
        if (rejectTx.type !== 'withdrawal' || rejectTx.status !== 'pending') {
            return NextResponse.json({
                success: false,
                error: rejectTx.status === 'paystack_pending'
                    ? 'This transfer is already in flight with Paystack and cannot be rejected — it must be resolved by reconciliation.'
                    : 'Already being processed or completed',
            }, { status: 409 })
        }

        const { data: result, error } = await db.rpc('reject_commission_withdrawal', {
            p_transaction_id: transaction_id, p_admin_id: admin.id, p_note: typeof note === 'string' ? note.slice(0, 500) : null,
        })
        if (error || !result?.success) {
            console.error('[commission-wallets] reject', { tx: transaction_id, msg: error?.message || result?.error })
            return NextResponse.json({ success: false, error: 'Reject failed' }, { status: 400 })
        }
        return NextResponse.json({ success: true })
    }

    // approve — real money movement (SEC-022 convention already enforced above).
    const { data: tx } = await db.from('commission_wallet_transactions')
        .select('id, amount, net_amount, momo_number, network, account_name, status, type')
        .eq('id', transaction_id).eq('type', 'withdrawal').single()
    if (!tx) return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 })
    if (tx.status !== 'pending') return NextResponse.json({ success: false, error: 'Already being processed or completed' }, { status: 400 })

    // Pay net_amount (post-fee), never the gross `amount` — the fee stays with the business.
    if (typeof tx.net_amount !== 'number' || tx.net_amount <= 0) {
        return NextResponse.json({ success: false, error: 'Transaction has an invalid net_amount' }, { status: 400 })
    }

    const network = tx.network as keyof typeof PAYSTACK_MOMO_BANK_CODE
    if (!PAYSTACK_MOMO_BANK_CODE[network]) {
        return NextResponse.json({ success: false, error: `Network "${tx.network}" is not supported` }, { status: 400 })
    }

    const reference = buildWithdrawalReference(transaction_id)
    const { data: locked } = await db.from('commission_wallet_transactions')
        .update({ status: 'paystack_pending', payout_provider: 'paystack', paystack_transfer_reference: reference, processed_by: admin.id, updated_at: new Date().toISOString() })
        .eq('id', transaction_id).eq('status', 'pending').eq('type', 'withdrawal').select()
    if (!locked || locked.length === 0) {
        return NextResponse.json({ success: false, error: 'Already being processed or completed' }, { status: 400 })
    }

    // FIX 4: capture and act on revertToPending's own error — if this UPDATE itself fails,
    // the row is stuck at paystack_pending with a stale reference and no external transfer in
    // flight, which is exactly the stuck state the spec calls out. Tell the caller to escalate
    // to manual review rather than silently reporting a plain "failed" as if it reverted cleanly.
    const revertToPending = async (failureReason?: string | null) => {
        const { error } = await db.from('commission_wallet_transactions')
            .update({ status: 'pending', payout_provider: null, paystack_transfer_reference: null, processed_by: null, failure_reason: failureReason ?? null, updated_at: new Date().toISOString() })
            .eq('id', transaction_id)
        if (error) {
            console.error('[commission-wallets] revertToPending failed', { tx: transaction_id, msg: error.message })
        }
        return !error
    }

    const balance = await getBalanceGhs()
    if (balance !== null && balance < tx.net_amount) {
        console.error('[commission-wallets] approve: insufficient balance', { tx: transaction_id, balance })
        const reverted = await revertToPending()
        return NextResponse.json({
            success: false,
            error: reverted
                ? `Insufficient Paystack balance (GH₵${balance.toFixed(2)})`
                : `Insufficient Paystack balance (GH₵${balance.toFixed(2)}) — revert also failed, this row needs manual review`,
        }, { status: 400 })
    }

    const rec = await createMomoRecipient({ name: tx.account_name, momoNumber: tx.momo_number, network })
    if (!rec.success || !rec.recipientCode) {
        console.error('[commission-wallets] approve: createMomoRecipient failed', { tx: transaction_id, msg: rec.error })
        const reverted = await revertToPending(maskNote(rec.error))
        return NextResponse.json({
            success: false,
            error: reverted
                ? `Could not create Paystack recipient: ${rec.error}`
                : `Could not create Paystack recipient: ${rec.error} — revert also failed, this row needs manual review`,
        }, { status: 400 })
    }
    await db.from('commission_wallet_transactions').update({ paystack_recipient_code: rec.recipientCode }).eq('id', transaction_id)

    const tr = await initiateTransfer({ amountGhs: tx.net_amount, recipientCode: rec.recipientCode, reference, reason: 'KingFlexy commission payout' })
    if (!tr.success) {
        console.error('[commission-wallets] approve: initiateTransfer failed', { tx: transaction_id, msg: tr.error })
        const reverted = await revertToPending(maskNote(tr.error))
        return NextResponse.json({
            success: false,
            error: reverted
                ? `Paystack transfer error: ${tr.error}`
                : `Paystack transfer error: ${tr.error} — revert also failed, this row needs manual review`,
        }, { status: 400 })
    }
    await db.from('commission_wallet_transactions').update({ paystack_transfer_code: tr.transferCode, paystack_transfer_status: tr.status, updated_at: new Date().toISOString() }).eq('id', transaction_id)

    if (tr.status === 'success') {
        await db.from('commission_wallet_transactions')
            .update({ status: 'completed', processed_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() })
            .eq('id', transaction_id).eq('status', 'paystack_pending')
        return NextResponse.json({ success: true, status: 'completed' })
    }
    return NextResponse.json({ success: true, status: 'paystack_pending' })
}
