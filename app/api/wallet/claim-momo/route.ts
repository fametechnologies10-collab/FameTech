import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { sendWalletTopupSuccessSMS } from '@/lib/sms-service'
import { sendMomoClaimSuccessEmail, sendMomoClaimAdminAlert } from '@/lib/email-service'
import { createNotification, balanceUpdatedNotification } from '@/lib/notification-service'
import { waitUntil } from '@vercel/functions'
import { resolvePaystackFeePercent, resolveTopupLimits, parseSettingNumber } from '@/lib/paystack-fees'

// ── DB-backed rate limiter (per user, 3 requests per 30 seconds) ──
// Queries the permanent momo_claim_attempts table so it survives
// cold starts, redeployments, and multi-instance scaling.
async function checkRateLimit(userId: string, supabaseAdmin: any): Promise<boolean> {
    const since = new Date(Date.now() - 30_000).toISOString()

    const { count, error } = await (supabaseAdmin
        .from('momo_claim_attempts') as any)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', since)

    if (error) {
        console.error('[ClaimMoMo] Rate limit DB check failed:', error.message)
        // VULN-03 fix: Fail-closed — block requests when we can't verify the limit
        return false
    }

    return (count || 0) < 3
}

// ── Input sanitization ───────────────────────────────────────────
function sanitizeTransactionId(raw: string): string | null {
    // Strip all non-digit characters
    const digits = raw.replace(/\D/g, '')
    // Validate length: must be 8-15 digits
    if (digits.length < 8 || digits.length > 15) return null
    return digits
}

// ── GET: Lookup step (Check a transaction ID) ────────────────────
export async function GET(request: NextRequest) {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── Settings-only mode: return display settings for wallet page ──
        // Called with ?settings_only=true — no txn_id required.
        // Uses service-role client to bypass RLS safely.
        const settingsOnly = request.nextUrl.searchParams.get('settings_only') === 'true'
        if (settingsOnly) {
            const supabaseAdmin = createServerClient()
            const { data: settingsRows } = await (supabaseAdmin
                .from('admin_settings') as any)
                .select('key, value')
                .in('key', [
                    'momo_claim_enabled',
                    'momo_payment_accounts',
                    'momo_account_name',
                    'momo_min_claimable',
                    'momo_max_claimable',
                    'paystack_fee_percent',
                    'paystack_fee_capped',
                    'agent_paystack_fee_percent',
                    'dealer_paystack_fee_percent',
                    'paystack_min_topup',
                    'paystack_max_topup'
                ])
            const map: Record<string, any> = {}
            ;((settingsRows as any[]) || []).forEach((s: any) => { map[s.key] = s.value })

            let accounts: { network: string; number: string }[] = []
            const rawAccts = map['momo_payment_accounts']
            if (Array.isArray(rawAccts)) accounts = rawAccts
            else if (typeof rawAccts === 'string') {
                try { const p = JSON.parse(rawAccts); if (Array.isArray(p)) accounts = p } catch {}
            }

            const rawName = map['momo_account_name']
            const accountName = typeof rawName === 'string' ? rawName.replace(/^\"|\"$/g, '') : String(rawName || '')

            // Determine effective fee based on user role
            const { data: userRoleData, error: userRoleError } = await supabaseAdmin
                .from('users')
                .select('role, agent_expires_at, dealer_expires_at')
                .eq('id', authUser.id)
                .single()

            if (userRoleError) {
                console.error('[ClaimMoMo] User role lookup failed, using base fee:', userRoleError.message)
                // Graceful degradation: return settings with base fee
            }

            const userRole = (userRoleData as any)?.role
            const agentExpiry = (userRoleData as any)?.agent_expires_at
            const dealerExpiry = (userRoleData as any)?.dealer_expires_at

            // Same resolver the charge route uses → displayed fee == charged fee.
            const effectiveFeePercent = resolvePaystackFeePercent({
                role: userRole,
                agentExpiresAt: agentExpiry,
                dealerExpiresAt: dealerExpiry,
            }, map)
            const { min: paystackMinTopup, max: paystackMaxTopup } = resolveTopupLimits(map)

            return NextResponse.json({
                momo_enabled: map['momo_claim_enabled'] !== 'false' && map['momo_claim_enabled'] !== false,
                momo_accounts: accounts,
                momo_account_name: accountName,
                momo_min_claimable: parseSettingNumber(map['momo_min_claimable'], 1),
                momo_max_claimable: parseSettingNumber(map['momo_max_claimable'], 50000),
                paystack_fee_percent: effectiveFeePercent,
                paystack_fee_capped: parseFloat(String(map['paystack_fee_capped']).replace(/^\"|\"$/g, '') || '0') || 0,
                paystack_min_topup: paystackMinTopup,
                paystack_max_topup: paystackMaxTopup,
            }, {
                headers: {
                    'Cache-Control': 'no-store, no-cache',
                }
            })
        }

        // VULN-08 fix: The GET lookup path is dead code since we switched to POST-only.
        // We block any GET requests containing a txn_id to prevent orphaned enumeration attacks.
        const hasTxnId = request.nextUrl.searchParams.has('txn_id')
        if (hasTxnId) {
            return NextResponse.json(
                { error: 'Endpoint no longer supports GET lookups. Use POST.' },
                { status: 410 }
            )
        }

        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    } catch (error: any) {
        console.error('[ClaimMoMo GET] Error:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── POST: Claim step ─────────────────────────────────────────────
export async function POST(request: NextRequest) {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const rawTxnId = body?.transaction_id || ''
        const txnId = sanitizeTransactionId(rawTxnId)

        if (!txnId) {
            return NextResponse.json(
                { error: 'Invalid Transaction ID. Must be 8–15 digits.' },
                { status: 400 }
            )
        }

        const supabaseAdmin = createServerClient()

        // ── Rate limit check (DB-backed, survives cold starts) ──
        if (!(await checkRateLimit(authUser.id, supabaseAdmin))) {
            // Log the rate-limited attempt
            await (supabaseAdmin.from('momo_claim_attempts') as any).insert({
                user_id: authUser.id,
                transaction_id_input: txnId,
                result: 'rate_limited',
            })
            return NextResponse.json(
                { error: 'Too many attempts. Please wait 30 seconds before trying again.' },
                { status: 429 }
            )
        }

        // ── Check if feature is enabled ────────────────────────
        const { data: enabledSetting } = await (supabaseAdmin
            .from('admin_settings') as any)
            .select('value')
            .eq('key', 'momo_claim_enabled')
            .single()

        if ((enabledSetting as any)?.value === 'false' || (enabledSetting as any)?.value === false) {
            return NextResponse.json(
                { error: 'MoMo claim feature is currently unavailable.' },
                { status: 503 }
            )
        }

        // ── Call the atomic PostgreSQL RPC ─────────────────────
        // ONLY transaction_id and user_id are sent — NO amounts from client
        const { data: result, error: rpcError } = await (supabaseAdmin
            .rpc as any)('claim_momo_transaction', {
            p_transaction_id: txnId,
            p_user_id: authUser.id,
        })

        if (rpcError) {
            console.error('[ClaimMoMo POST] RPC error:', rpcError)
            return NextResponse.json({ error: 'Failed to process claim. Please try again.' }, { status: 500 })
        }

        const res = result as any

        if (!res?.success) {
            const errCode = res?.error

            // Log failed claim attempt for rate limiting
            await (supabaseAdmin.from('momo_claim_attempts') as any).insert({
                user_id: authUser.id,
                transaction_id_input: txnId,
                result: errCode || 'claim_failed',
            })

            if (errCode === 'already_claimed') {
                return NextResponse.json({
                    error: 'already_claimed',
                    is_own_claim: res.is_own_claim,
                    claimed_at: res.claimed_at,
                }, { status: 409 })
            }

            if (errCode === 'below_minimum') {
                return NextResponse.json({
                    error: `Below minimum claimable amount of GHS ${parseFloat(res.min_claimable).toFixed(2)}.`,
                }, { status: 400 })
            }

            return NextResponse.json({ error: errCode || 'Claim failed.' }, { status: 400 })
        }

        // Log successful claim attempt
        await (supabaseAdmin.from('momo_claim_attempts') as any).insert({
            user_id: authUser.id,
            transaction_id_input: txnId,
            result: 'claimed_successfully',
        })

        // ── Fetch user details for notifications ───────────────
        const { data: userDetails } = await supabaseAdmin
            .from('users')
            .select('first_name, last_name, phone_number, email')
            .eq('id', authUser.id)
            .single()

        const firstName = (userDetails as any)?.first_name || 'User'
        const phoneNumber = (userDetails as any)?.phone_number
        const email = (userDetails as any)?.email

        // Create in-app notification
        waitUntil(
            createNotification({
                userId: authUser.id,
                ...balanceUpdatedNotification(parseFloat(res.net_amount), 'credit'),
                message: `Your wallet was credited GHS ${parseFloat(res.net_amount).toFixed(2)} from MoMo TXN: ${res.transaction_id}`,
            }).catch(e => console.error('[ClaimMoMo] In-app notification error:', e.message))
        )
 
        // ── Fire SMS + Email notifications (non-blocking) ──────
        const notificationPayload = {
            netAmount:       parseFloat(res.net_amount),
            newBalance:      parseFloat(res.new_balance),
            transactionId:   res.transaction_id,
            senderNetwork:   res.sender_network,
        }

        const emailPayload = {
            transactionId:  res.transaction_id,
            senderName:     res.sender_name,
            senderNetwork:  res.sender_network,
            amount:         parseFloat(res.amount),
            feePercent:     parseFloat(res.fee_percent),
            feeAmount:      parseFloat(res.fee_amount),
            netAmount:      parseFloat(res.net_amount),
            newBalance:     parseFloat(res.new_balance),
        }

        // Background execution — Vercel won't freeze the server until these complete
        if (phoneNumber) {
            waitUntil(
                sendWalletTopupSuccessSMS(phoneNumber, {
                    amount: parseFloat(res.net_amount),
                    newBalance: parseFloat(res.new_balance)
                }).catch((e: any) =>
                    console.error('[ClaimMoMo] SMS error:', e.message)
                )
            )
        }
        if (email) {
            waitUntil(
                sendMomoClaimSuccessEmail(email, firstName, emailPayload).catch((e: any) =>
                    console.error('[ClaimMoMo] Email error:', e.message)
                )
            )
            waitUntil(
                sendMomoClaimAdminAlert({
                    userName: firstName + ' ' + ((userDetails as any)?.last_name || ''),
                    userEmail: email,
                    transactionId: res.transaction_id,
                    amount: parseFloat(res.amount),
                    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                }).catch((e: any) =>
                    console.error('[ClaimMoMo] Admin Email error:', e.message)
                )
            )
        }
        
        waitUntil(
            (async () => {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'New MoMo Claim',
                    body: `${firstName} has successfully claimed GHS ${parseFloat(res.amount).toFixed(2)}.`,
                    url: '/admin/momo-claims'
                }).catch(err => console.error('[ClaimMoMo] Admin Push error:', err))
            })()
        )

        return NextResponse.json({
            success: true,
            amount:         parseFloat(res.amount),
            fee_percent:    parseFloat(res.fee_percent),
            fee_amount:     parseFloat(res.fee_amount),
            net_amount:     parseFloat(res.net_amount),
            new_balance:    parseFloat(res.new_balance),
            sender_name:    res.sender_name,
            sender_network: res.sender_network,
            transaction_id: res.transaction_id,
        })

    } catch (error: any) {
        console.error('[ClaimMoMo POST] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
