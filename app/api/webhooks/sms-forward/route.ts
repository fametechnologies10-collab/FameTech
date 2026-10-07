import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { waitUntil } from '@vercel/functions'
import { sendWalletTopupSuccessSMS } from '@/lib/sms-service'
import { sendMomoClaimSuccessEmail, sendMomoClaimAdminAlert } from '@/lib/email-service'
import { createNotification, balanceUpdatedNotification } from '@/lib/notification-service'

// ── SMS format regexes for Ghanaian MoMo networks ──────────────

// MTN Cash In (Merchant to User): "Cash In received for GHS 200.00 from EDWARD APPIAH. Current Balance GHS 272.65 Available Balance GHS 272.65. Transaction ID: 80488644568."
const MTN_CASH_IN_REGEX = /Cash\s+In\s+received\s+for\s+GHS\s+([\d,]+\.?\d*)\s+from\s+(.+?)\.\s+Current.*?Transaction\s+ID[:\s]*([\d]+)/i

// MTN Payment (User to User OR Cross-Network to MTN): "Payment received for GHS 3.00 from FELIX BOAHEN  Current Balance... Reference: FELIX BOAHEN ,233507193592,2 from VODAFONE. Transaction ID: 80488860869."
const MTN_PAYMENT_REGEX = /Payment\s+received\s+for\s+GHS\s+([\d,]+\.?\d*)\s+from\s+(.+?)\s+Current.*?Transaction\s+ID[:\s]*([\d]+)/i

// Telecel/Vodafone Native (Telecel to Telecel)
const TELECEL_REGEX = /GHS\s+([\d,]+\.?\d*)\s+has\s+been\s+received\s+from\s+(.+?)[\.‚\n].*?Transaction\s+ID[:\s]*([\d]+)/i

// AirtelTigo Native (AirtelTigo to AirtelTigo)
const AIRTELTIGO_REGEX = /received\s+GHS\s+([\d,]+\.?\d*)\s+from\s+(.+?)[\.‚\n].*?Transaction\s+ID[:\s]*([\d]+)/i

// ── Reference code pattern — word+number format ─────────────
// Matches new format: 3-8 letters + 1-4 digits OR 1-4 digits + 3-8 letters
// (e.g., BOOK45, 12GIFT, AIRTIME100, 99CASH)
// Also matches legacy 5-char alphanumeric codes for backward compatibility.
// We cross-check all candidates against the DB, so false positives are safe.
const REFERENCE_CODE_REGEX = /\b([A-Z]{3,8}[0-9]{1,4}|[0-9]{1,4}[A-Z]{3,8}|[A-Z0-9]{5})\b/g

interface ParseResult {
    amount: number
    senderName: string
    transactionId: string
    network: 'MTN' | 'Telecel' | 'AirtelTigo' | 'Unknown'
    candidates: string[] // possible 5-char reference codes found in the body
}

function parseSMS(body: string): ParseResult | null {
    // Must contain Transaction ID and GHS to be a MoMo payment
    // This immediately drops all promotional and non-payment messages.
    if (!body.includes('Transaction ID') || !body.includes('GHS')) {
        return null
    }

    let match: RegExpMatchArray | null = null
    let network: ParseResult['network'] = 'Unknown'

    // Try MTN Cash In first
    match = body.match(MTN_CASH_IN_REGEX)
    if (match) {
        network = 'MTN'
    }

    // Try MTN Payment Received (Includes Cross-Network to MTN)
    if (!match) {
        match = body.match(MTN_PAYMENT_REGEX)
        if (match) {
            // Check if it specifically mentions VODAFONE/TELECEL/AIRTEL in the body
            if (/from\s+(VODAFONE|TELECEL)/i.test(body)) network = 'Telecel'
            else if (/from\s+(AIRTEL|TIGO)/i.test(body)) network = 'AirtelTigo'
            else network = 'MTN'
        }
    }

    // Try Telecel
    if (!match) {
        match = body.match(TELECEL_REGEX)
        if (match) network = 'Telecel'
    }

    // Try AirtelTigo
    if (!match) {
        match = body.match(AIRTELTIGO_REGEX)
        if (match) network = 'AirtelTigo'
    }

    if (!match) return null

    const rawAmount = match[1].replace(/,/g, '')
    const amount = parseFloat(rawAmount)
    const senderName = match[2].trim()
    const transactionId = match[3].trim()

    // Validate extracted data
    if (isNaN(amount) || amount <= 0) return null
    if (!transactionId || !/^\d{8,15}$/.test(transactionId)) return null
    if (!senderName || senderName.length < 2) return null

    // ── Extract all 5-char uppercase alphanumeric candidates from the body ──
    const candidates: string[] = []
    let refMatch: RegExpExecArray | null
    const upperBody = body.toUpperCase()
    while ((refMatch = REFERENCE_CODE_REGEX.exec(upperBody)) !== null) {
        candidates.push(refMatch[1])
    }
    // Reset regex lastIndex for next call
    REFERENCE_CODE_REGEX.lastIndex = 0

    return { amount, senderName, transactionId, network, candidates }
}

export async function POST(request: NextRequest) {
    try {
        // ── Security: validate secret ─────────────────────────────
        // SEC-016: accept the secret ONLY via the custom header. The previous
        // ?secret= query fallback leaked the secret into CDN/proxy/Vercel access
        // logs in plaintext.
        const providedSecret = request.headers.get('x-sms-forward-secret')
        const expectedSecret = process.env.SMS_FORWARD_SECRET

        if (!expectedSecret) {
            console.error('[SMSWebhook] CRITICAL: SMS_FORWARD_SECRET env var not configured — rejecting ALL requests')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        // Constant-time: compare equal-length HMAC digests (same pattern as
        // lib/ussd/callback-auth.ts) so neither content nor length leaks via timing.
        const providedDigest = createHmac('sha256', expectedSecret).update(providedSecret ?? '').digest()
        const expectedDigest = createHmac('sha256', expectedSecret).update(expectedSecret).digest()
        if (!providedSecret || !timingSafeEqual(providedDigest, expectedDigest)) {
            console.warn('[SMSWebhook] Invalid secret — request rejected')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── Parse the incoming payload ─────────────────────────
        let smsBody = ''
        const contentType = request.headers.get('content-type') || ''

        if (contentType.includes('application/json')) {
            const payload = await request.json()
            smsBody = payload.text || payload.body || payload.message || payload.sms || ''
        } else {
            const formData = await request.formData()
            smsBody = (formData.get('text') || formData.get('body') || formData.get('message') || '').toString()
        }

        if (!smsBody.trim()) {
            console.warn('[SMSWebhook] Empty SMS body received')
            return NextResponse.json({ received: true })
        }

        // SEC-031: do NOT log the raw SMS body — it contains payer PII
        // (sender name, amount, transaction ID).

        // ── Parse the SMS ──────────────────────────────────────
        const parsed = parseSMS(smsBody)

        if (!parsed) {
            console.log('[SMSWebhook] SMS did not match any MoMo format — logging as parse_failed')
            return NextResponse.json({ received: true, status: 'parse_failed' })
        }

        console.log('[SMSWebhook] Parsed:', { ...parsed, candidates: parsed.candidates })

        const supabase = createServerClient()

        // ── Fetch admin settings for max claimable ─────────────
        const { data: maxSetting } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'momo_max_claimable')
            .single()

        const maxClaimable = maxSetting ? parseFloat((maxSetting as any).value) : 50000
        const txnStatus = parsed.amount > maxClaimable ? 'flagged' : 'pending'

        if (txnStatus === 'flagged') {
            console.warn(`[SMSWebhook] Amount GHS ${parsed.amount} exceeds max ${maxClaimable} — flagging for admin review`)
        }

        // ── Insert with ON CONFLICT to prevent duplicates ──────
        // ignoreDuplicates=true ensures re-forwarded SMS doesn't overwrite existing data
        const { error: upsertError } = await (supabase
            .from('momo_transactions') as any)
            .upsert(
                {
                    transaction_id:  parsed.transactionId,
                    amount:          parsed.amount,
                    sender_name:     parsed.senderName,
                    sender_network:  parsed.network,
                    raw_sms:         smsBody,
                    status:          txnStatus,
                },
                { onConflict: 'transaction_id', ignoreDuplicates: true }
            )

        if (upsertError) {
            console.error('[SMSWebhook] DB upsert error:', upsertError)
            // Still return 200 so the SMS forwarder doesn't retry infinitely
            return NextResponse.json({ received: true, status: 'db_error' })
        }

        console.log(`[SMSWebhook] ✅ Saved TXN ${parsed.transactionId} as ${txnStatus}`)

        // ── Auto-Claim via Reference Code ──────────────────────
        // Only attempt if the transaction is pending (not flagged/voided)
        // and if there are reference code candidates in the SMS.
        if (txnStatus === 'pending' && parsed.candidates.length > 0) {
            // Look up if any of the scanned candidates match an active reference
            const { data: refRows } = await (supabase
                .from('user_payment_references') as any)
                .select('user_id, reference_code')
                .in('reference_code', parsed.candidates)
                .eq('is_active', true)
                .limit(1)

            const matchedRef = refRows && refRows.length > 0 ? refRows[0] : null

            if (matchedRef) {
                const matchedUserId: string = (matchedRef as any).user_id
                const matchedCode: string = (matchedRef as any).reference_code

                console.log(`[SMSWebhook] 🔑 Reference ${matchedCode} matched user ${matchedUserId}. Attempting auto-claim...`)

                // ── Invoke the atomic claim RPC ────────────────
                const { data: rpcResult, error: rpcError } = await (supabase
                    .rpc as any)('claim_momo_transaction', {
                    p_transaction_id: parsed.transactionId,
                    p_user_id:        matchedUserId,
                    p_is_auto:        true,
                    p_ref_code:       matchedCode,
                })

                if (rpcError) {
                    console.error('[SMSWebhook] Auto-claim RPC error:', rpcError.message)
                    // Non-fatal — transaction stays as pending, user can claim manually
                    return NextResponse.json({ received: true, status: 'auto_claim_rpc_error' })
                }

                const res = rpcResult as any

                if (!res?.success) {
                    // Graceful failures (already_claimed, below_minimum, etc.)
                    console.warn(`[SMSWebhook] Auto-claim not completed: ${res?.error}`)
                    return NextResponse.json({ received: true, status: `auto_claim_skipped:${res?.error}` })
                }

                // ── Auto-claim succeeded — fire notifications ──
                console.log(`[SMSWebhook] ✅ Auto-claimed TXN ${parsed.transactionId} for user ${matchedUserId} via ref ${matchedCode}`)

                // Create in-app notification
                waitUntil(
                    createNotification({
                        userId: matchedUserId,
                        ...balanceUpdatedNotification(parseFloat(res.net_amount), 'credit'),
                        message: `Your wallet was auto-credited GHS ${parseFloat(res.net_amount).toFixed(2)} from MoMo TXN: ${parsed.transactionId}`,
                    }).catch(e => console.error('[SMSWebhook] In-app notification error:', e.message))
                )

                // Fetch user details for notification dispatch
                const { data: userDetails } = await supabase
                    .from('users')
                    .select('first_name, last_name, phone_number, email')
                    .eq('id', matchedUserId)
                    .single()

                const firstName = (userDetails as any)?.first_name || 'User'
                const phoneNumber = (userDetails as any)?.phone_number
                const email = (userDetails as any)?.email

                // Fire SMS notification (non-blocking)
                if (phoneNumber) {
                    waitUntil(
                        sendWalletTopupSuccessSMS(phoneNumber, {
                            amount: parseFloat(res.net_amount),
                            newBalance: parseFloat(res.new_balance)
                        }).catch((e: any) =>
                            console.error('[SMSWebhook] Auto-claim SMS error:', e.message)
                        )
                    )
                }

                // Fire email notifications (non-blocking)
                if (email) {
                    const emailPayload = {
                        transactionId:  res.transaction_id,
                        senderName:     res.sender_name,
                        senderNetwork:  res.sender_network,
                        amount:         parseFloat(res.amount),
                        feePercent:     parseFloat(res.fee_percent),
                        feeAmount:      parseFloat(res.fee_amount),
                        netAmount:      parseFloat(res.net_amount),
                        newBalance:     parseFloat(res.new_balance),
                        isAutoClaim:    true,
                        refCode:        matchedCode,
                    }

                    waitUntil(
                        sendMomoClaimSuccessEmail(email, firstName, emailPayload).catch((e: any) =>
                            console.error('[SMSWebhook] Auto-claim email error:', e.message)
                        )
                    )
                    waitUntil(
                        sendMomoClaimAdminAlert({
                            userName: firstName + ' ' + ((userDetails as any)?.last_name || ''),
                            userEmail: email,
                            transactionId: res.transaction_id,
                            amount: parseFloat(res.amount),
                            date: new Date().toLocaleDateString('en-GB', {
                                day: 'numeric', month: 'short', year: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                            }),
                            isAutoClaim: true,
                            refCode: matchedCode,
                        }).catch((e: any) =>
                            console.error('[SMSWebhook] Auto-claim admin alert error:', e.message)
                        )
                    )
                }

                waitUntil(
                    (async () => {
                        const { sendAdminPushNotification } = await import('@/lib/push-service')
                        await sendAdminPushNotification({
                            title: 'New MoMo Auto-Claim',
                            body: `${firstName} has successfully auto-claimed GHS ${parseFloat(res.amount).toFixed(2)}.`,
                            url: '/admin/momo-claims'
                        }).catch(err => console.error('[SMSWebhook] Admin Push error:', err))
                    })()
                )

                return NextResponse.json({ received: true, status: 'auto_claimed', ref: matchedCode })
            }
        }

        return NextResponse.json({ received: true, status: txnStatus })

    } catch (error: any) {
        console.error('[SMSWebhook] Exception:', error.message)
        // Always return 200 to prevent Forward SMS app from retrying
        return NextResponse.json({ received: true })
    }
}
