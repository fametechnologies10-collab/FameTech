import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { sendWalletTopupSuccessSMS } from '@/lib/sms-service'
import { waitUntil } from '@vercel/functions'

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: adminUser } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (adminUser?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const {
            userId,
            amount,
            description = 'Manual wallet top-up',
            markAsUnpaid = false,
            notes,
            deductFromDebt = false,
            deductAmount = 0,
            settlementId
        } = body

        // Input validation
        if (!userId || !amount || amount <= 0) {
            return NextResponse.json({ error: 'Invalid input: userId and amount > 0 are required' }, { status: 400 })
        }

        if (deductFromDebt && (deductAmount <= 0 || deductAmount > amount)) {
            return NextResponse.json({
                error: 'Deduct amount must be greater than 0 and cannot exceed the top-up amount'
            }, { status: 400 })
        }

        const supabase = createServerClient() as any

        // --- IDEMPOTENCY CHECK ---
        // Block if same user_id + amount was already credited by admin in the last 5 seconds
        const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString()
        const { data: recentTx } = await supabase
            .from('wallet_transactions')
            .select('id')
            .eq('user_id', userId)
            .eq('amount', amount)
            .eq('source', 'admin')
            .eq('type', 'credit')
            .gte('created_at', fiveSecondsAgo)
            .limit(1)

        if (recentTx && recentTx.length > 0) {
            return NextResponse.json({
                error: 'DUPLICATE',
                message: `A top-up of this exact amount was already processed within the last 5 seconds. Please wait before retrying.`
            }, { status: 409 })
        }

        // --- FETCH WALLET ---
        const { data: wallet, error: walletError } = await supabase
            .from('wallets')
            .select('id, balance')
            .eq('user_id', userId)
            .single()

        if (walletError || !wallet) {
            return NextResponse.json({ error: 'User wallet not found' }, { status: 404 })
        }

        // --- COMPUTE NET CREDIT ---
        const netCredit = deductFromDebt ? amount - deductAmount : amount
        if (netCredit < 0) {
            return NextResponse.json({ error: 'Deduction exceeds top-up amount' }, { status: 400 })
        }

        // --- FETCH USER FOR SMS ---
        const { data: userRecord } = await supabase
            .from('users')
            .select('phone_number, first_name')
            .eq('id', userId)
            .single()

        // --- INSERT WALLET TRANSACTION ---
        const { data: newTx, error: txError } = await supabase
            .from('wallet_transactions')
            .insert({
                wallet_id: wallet.id,
                user_id: userId,
                type: 'credit',
                amount: netCredit,
                description: deductFromDebt
                    ? `${description} (GHS ${amount} cash received, GHS ${deductAmount} debt deducted)`
                    : description,
                source: 'admin',
                status: 'completed'
            })
            .select('id')
            .single()

        if (txError || !newTx) {
            throw new Error(`Failed to create transaction: ${txError?.message}`)
        }

        // --- CREDIT WALLET (SEC-004/SEC-018) ---
        // Atomic relative increment of balance + total_credited in a single
        // statement, with a checked error. Replaces the previous read-then-write
        // UPDATE (lost-update race + unchecked error → silent 200) and the
        // double total_credited increment.
        const { data: creditResult, error: creditError } = await (supabase as any).rpc('admin_credit_wallet', {
            p_user_id: userId,
            p_amount: netCredit,
        })
        if (creditError) {
            console.error('[AdminTopUp] admin_credit_wallet failed:', creditError)
            return NextResponse.json({ error: 'Balance update failed' }, { status: 500 })
        }
        const newBalance = (creditResult as any)?.new_balance ?? (wallet.balance + netCredit)

        // --- CREATE DEBT RECORD IF UNPAID ---
        if (markAsUnpaid) {
            await supabase
                .from('pending_settlements')
                .insert({
                    user_id: userId,
                    wallet_transaction_id: newTx.id,
                    amount_owed: netCredit,
                    amount_settled: 0,
                    status: 'pending',
                    notes: notes || null
                })
        }

        // --- SETTLE EXISTING DEBT IF FORCE SETTLEMENT ---
        if (deductFromDebt && settlementId && deductAmount > 0) {
            const { data: existingDebt } = await supabase
                .from('pending_settlements')
                .select('amount_owed, amount_settled')
                .eq('id', settlementId)
                .single()

            if (existingDebt) {
                const newAmountSettled = (existingDebt.amount_settled || 0) + deductAmount
                const isFullySettled = newAmountSettled >= existingDebt.amount_owed

                await supabase
                    .from('pending_settlements')
                    .update({
                        amount_settled: newAmountSettled,
                        status: isFullySettled ? 'settled' : 'partially_settled',
                        settled_at: isFullySettled ? new Date().toISOString() : null,
                        notes: notes || null
                    })
                    .eq('id', settlementId)
            }
        }

        // --- SEND PUSH & SMS ---
        if (userId && netCredit > 0) {
            waitUntil((async () => {
                try {
                    const { sendPushNotification } = await import('@/lib/push-service')
                    await sendPushNotification(userId, {
                        title: 'Wallet Credited',
                        body: `Your wallet has been credited with GHS ${netCredit.toFixed(2)} by Admin.`,
                        url: '/dashboard/wallet'
                    })
                } catch (pushError) {
                    console.error('[Top-Up Push] Error:', pushError)
                }
            })())
        }

        if (userRecord?.phone_number && netCredit > 0) {
            waitUntil(
                sendWalletTopupSuccessSMS(userRecord.phone_number, {
                    amount: netCredit,
                    newBalance
                }).catch(err => console.error('[Top-Up SMS] Error:', err))
            )
        }

        return NextResponse.json({
            success: true,
            netCredit,
            newBalance,
            deducted: deductFromDebt ? deductAmount : 0,
            idempotencyBlocked: false
        })

    } catch (error: any) {
        console.error('[Top-Up Credit] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
