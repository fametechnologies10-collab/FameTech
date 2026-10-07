import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { sendWalletTopupSuccessEmail } from '@/lib/email-service'
import { sendWalletTopupSuccessSMS } from '@/lib/sms-service'
import { logAdminAction } from '@/lib/admin-audit'

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Check if requester is admin
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const { userId, amount, type, description } = body

        if (!userId || amount === undefined || !type) {
            return NextResponse.json({ error: 'userId, amount, and type are required' }, { status: 400 })
        }

        const adjustmentAmount = parseFloat(amount)
        if (isNaN(adjustmentAmount) || adjustmentAmount <= 0) {
            return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
        }

        // ✅ SECURITY: Add maximum adjustment limit
        const MAX_ADJUSTMENT = 10000  // GHS 10,000
        if (adjustmentAmount > MAX_ADJUSTMENT) {
            return NextResponse.json({
                error: `Adjustment exceeds maximum limit of GHS ${MAX_ADJUSTMENT.toLocaleString()}. Please contact system administrator for larger adjustments.`
            }, { status: 400 })
        }

        // ✅ AUDIT: Log large adjustments
        if (adjustmentAmount > 1000) {
            console.warn(`[AUDIT] Large wallet adjustment: Admin ${authUser.id} ${type} GHS ${adjustmentAmount} to user ${userId}. Reason: ${description || 'No reason provided'}`)
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // CHECK ENV VAR
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
            console.error('[CRITICAL] SUPABASE_SERVICE_ROLE_KEY is MISSING in environment variables!')
        }

        const isCredit = type === 'credit'

        // 1+2+3. Atomic delta + ledger insert via SECURITY DEFINER RPC (row-locked —
        // concurrent adjustments can no longer clobber each other's balance write).
        const { data: adjResult, error: adjError } = await (supabase as any).rpc('admin_adjust_wallet', {
            p_user_id: userId,
            p_delta: isCredit ? adjustmentAmount : -adjustmentAmount,
            p_description: description || 'Admin manual adjustment',
        })

        if (adjError) {
            console.error('[AdminWalletAdjustment] RPC error:', adjError)
            throw adjError
        }
        if (!(adjResult as any)?.ok) {
            const code = (adjResult as any)?.error
            if (code === 'wallet_not_found') {
                return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
            }
            if (code === 'insufficient_balance') {
                return NextResponse.json({ error: 'User has insufficient balance for this debit' }, { status: 400 })
            }
            return NextResponse.json({ error: code || 'Adjustment failed' }, { status: 400 })
        }

        const newBalance = Number((adjResult as any).new_balance)

        await logAdminAction(supabase, {
            adminId: authUser.id,
            action: isCredit ? 'wallet_credit' : 'wallet_debit',
            targetUserId: userId,
            oldValue: { balance: Number((adjResult as any).old_balance) },
            newValue: { balance: newBalance, amount: adjustmentAmount, description: description || null },
        })

        // 4. Send notification
        await (supabase.from('notifications') as any).insert({
            user_id: userId,
            title: isCredit ? 'Wallet Credited' : 'Wallet Debited',
            message: `Your wallet has been ${isCredit ? 'credited' : 'debited'} with GHS ${adjustmentAmount.toFixed(2)}. ${description || ''}`,
            type: 'balance_updated',
            is_read: false
        })

        if (type === 'credit') {
            // 5. Fetch user data for notifications
            const { data: user } = await supabase
                .from('users')
                .select('email, first_name, phone_number')
                .eq('id', userId)
                .single()

            if (user) {
                const reference = `MNL-${Date.now()}`

                // Push Notification
                try {
                    const { sendPushNotification } = await import('@/lib/push-service')
                    await sendPushNotification(userId, {
                        title: 'Wallet Adjustment (Credit)',
                        body: `Your wallet has been credited with GHS ${adjustmentAmount.toFixed(2)} by Admin.`,
                        url: '/dashboard/wallet'
                    }).catch(pushErr => console.error('[AdminWalletAdjustment Push] Error:', pushErr))
                } catch (pushError) {
                    console.error('[AdminWalletAdjustment Push] Import Error:', pushError)
                }

                // Email
                await sendWalletTopupSuccessEmail(
                    (user as any).email,
                    (user as any).first_name || 'Customer',
                    adjustmentAmount,
                    reference,
                    newBalance
                )

                // SMS
                if ((user as any).phone_number) {
                    try {
                        await sendWalletTopupSuccessSMS(
                            (user as any).phone_number,
                            { amount: adjustmentAmount, newBalance }
                        )
                    } catch (smsError: any) {
                        console.error('[AdminWalletAdjustment] SMS failed:', smsError)
                    }
                }
            }
        }

        return NextResponse.json({ success: true, newBalance })

    } catch (error: any) {
        console.error('Admin Wallet Adjustment Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
