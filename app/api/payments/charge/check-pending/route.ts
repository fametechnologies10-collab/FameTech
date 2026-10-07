import { NextRequest, NextResponse } from 'next/server'
import { processCompletedWalletPayment } from '@/lib/payments'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// Paystack charge statuses that are a genuine, terminal decline. Anything else
// that isn't an outright `success` (pay_offline, pending, ongoing, timeout,
// send_otp, or any undocumented value) is still recoverable — the customer may
// approve the MoMo prompt late and the charge.success webhook will credit them.
const TERMINAL_CHARGE_STATUSES = new Set(['failed', 'abandoned', 'reversed'])

/**
 * Authoritative wallet-payment status check, used by BOTH the background poll
 * and the "I've paid" button on the wallet page.
 *
 * Contract: { paid: boolean, pending?: boolean, terminal?: boolean,
 *             status: string, display_text?: string }
 *
 *  - paid:true      → wallet is credited (DB row completed, or Paystack success
 *                     processed just now). Show success.
 *  - terminal:true  → genuine decline / amount mismatch. Show failed.
 *  - pending:true   → not yet — keep waiting. NEVER show a hard failure.
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('reference')

        if (!reference || typeof reference !== 'string' || reference.trim() === '') {
            return NextResponse.json({ error: 'Reference is required' }, { status: 400 })
        }

        // Cap length before forwarding to Paystack. Platform refs (WAL-…) are
        // <30 chars; reject anything absurd to avoid outbound payload abuse.
        if (reference.length > 100) {
            return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
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

        // ── 1. DB is authoritative ────────────────────────────────────────
        // The webhook (or a prior poll) may have already completed this. Trust
        // the row before calling Paystack. This removes the read-after-write
        // race against Paystack's laggy charge/transaction endpoints that was
        // flipping already-credited top-ups to "failed".
        if (paymentRow.status === 'completed') {
            return NextResponse.json({ paid: true, status: 'success' })
        }
        if (paymentRow.status === 'failed') {
            return NextResponse.json({ paid: false, terminal: true, status: 'failed' })
        }

        // ── 2. Still pending in our DB — ask Paystack ─────────────────────
        const res = await fetch(`https://api.paystack.co/charge/${encodeURIComponent(reference)}`, {
            headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        })
        const data = await res.json()

        // A failed status-check call is itself non-terminal — keep the user
        // waiting rather than declaring failure on a transient hiccup.
        if (!data.status || !data.data) {
            console.error('[ChargePending] Status check failed:', data?.message || data?.status)
            return NextResponse.json({ paid: false, pending: true, status: 'pending' })
        }

        const chargeStatus: string = data.data.status
        const displayText: string = data.data.display_text || ''

        // ── 3. Paystack says success → credit (idempotent) ────────────────
        if (chargeStatus === 'success') {
            const result = await processCompletedWalletPayment(reference, data.data)
            if (result.success) {
                return NextResponse.json({ paid: true, status: 'success' })
            }
            if (result.error === 'Amount mismatch') {
                return NextResponse.json({
                    paid: false, terminal: true, status: 'failed', display_text: 'Amount mismatch',
                })
            }
            // Transient processing failure (e.g. credit RPC hiccup — already
            // rolled back to pending). Keep waiting; webhook/cron will retry.
            return NextResponse.json({ paid: false, pending: true, status: 'pending' })
        }

        // ── 4. Genuine terminal decline ───────────────────────────────────
        if (TERMINAL_CHARGE_STATUSES.has(chargeStatus)) {
            return NextResponse.json({
                paid: false, terminal: true, status: chargeStatus, display_text: displayText,
            })
        }

        // ── 5. Everything else is still in flight ─────────────────────────
        return NextResponse.json({
            paid: false, pending: true, status: chargeStatus, display_text: displayText,
        })
    } catch (error) {
        console.error('[ChargePending] Unhandled error:', error)
        // Even an unhandled error is non-terminal for the payment — surface as
        // pending so the UI keeps waiting and the webhook can still resolve it.
        return NextResponse.json({ paid: false, pending: true, status: 'pending' })
    }
}
