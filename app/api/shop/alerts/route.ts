import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import {
    sendShopPricingApprovedSMS,
    sendShopPricingRejectedSMS,
    sendShopProfileApprovedSMS,
    sendShopProfileRejectedSMS,
    sendShopWithdrawalProcessedSMS,
    sendShopWithdrawalRejectedSMS,
} from '@/lib/sms-service'
import {
    sendShopPricingApprovedEmail,
    sendShopPricingRejectedEmail,
    sendShopProfileApprovedEmail,
    sendShopProfileRejectedEmail,
    sendShopWithdrawalProcessedEmail,
    sendShopWithdrawalRejectedEmail,
    sendAdminShopPricingSubmissionAlert,
    sendAdminNewShopRegistrationAlert,
    sendAdminShopWithdrawalRequestAlert,
} from '@/lib/email-service'

export async function POST(req: NextRequest) {
    try {
        // Auth check — must be a signed-in user with an elevated role
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // Role check — admins, sub-admins, agents, and customer-tier shop owners can fire alerts
        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        const allowedRoles = ['admin', 'sub-admin', 'dealer', 'agent', 'customer']
        if (!dbUser || !allowedRoles.includes(dbUser.role)) {
            return NextResponse.json({ error: 'Forbidden: insufficient role' }, { status: 403 })
        }

        const body = await req.json()
        const { type, payload } = body

        if (!type || !payload) {
            return NextResponse.json({ error: 'Missing type or payload' }, { status: 400 })
        }

        // SEC-008: every alert type here is admin-initiated — owner-facing ones
        // (pricing_*/profile_*/withdrawal_*) take the recipient phone/email from
        // the payload, and admin-inbox ones (admin_*) feed the admin queue. Gate
        // them ALL to admin/sub-admin upfront so no customer/agent/dealer can
        // relay a branded "Payout Successful" SMS/email to an arbitrary victim
        // over our sender ID. (Per-case admin_* guards below stay as a backstop.)
        const ADMIN_ONLY_ALERT_TYPES = [
            'pricing_approved', 'pricing_rejected',
            'profile_approved', 'profile_rejected',
            'withdrawal_processed', 'withdrawal_rejected',
            'admin_pricing_submission', 'admin_new_shop', 'admin_withdrawal_request',
        ]
        if (ADMIN_ONLY_ALERT_TYPES.includes(type) && !['admin', 'sub-admin'].includes(dbUser.role)) {
            return NextResponse.json({ error: 'Forbidden: admin-only alert type' }, { status: 403 })
        }

        let smsResult, emailResult

        switch (type) {

            // ── Alert 3: Pricing Approved ──────────────────────────────
            case 'pricing_approved': {
                const { phone, firstName, email, shopName } = payload
                    ;[smsResult, emailResult] = await Promise.allSettled([
                        sendShopPricingApprovedSMS(phone, firstName),
                        sendShopPricingApprovedEmail(email, firstName, shopName),
                    ])
                break
            }

            // ── Alert 4: Pricing Rejected ──────────────────────────────
            case 'pricing_rejected': {
                const { phone, firstName, email, shopName, reason } = payload
                    ;[smsResult, emailResult] = await Promise.allSettled([
                        sendShopPricingRejectedSMS(phone, firstName, reason),
                        sendShopPricingRejectedEmail(email, firstName, shopName, reason),
                    ])
                break
            }

            // ── Alert 5: Shop Profile Approved ─────────────────────────
            case 'profile_approved': {
                const { phone, firstName, email, shopName } = payload
                    ;[smsResult, emailResult] = await Promise.allSettled([
                        sendShopProfileApprovedSMS(phone, shopName),
                        sendShopProfileApprovedEmail(email, firstName, shopName),
                    ])
                break
            }

            // ── Alert 6: Shop Profile Rejected ─────────────────────────
            case 'profile_rejected': {
                const { phone, firstName, email, shopName, reason } = payload
                    ;[smsResult, emailResult] = await Promise.allSettled([
                        sendShopProfileRejectedSMS(phone, firstName, reason || 'Please check your dashboard for details.'),
                        sendShopProfileRejectedEmail(email, firstName, shopName, reason || 'Please check your dashboard for details.'),
                    ])
                break
            }

            // ── Alert 7: Withdrawal Processed (owner) ──────────────────
            case 'withdrawal_processed': {
                const { phone, firstName, email, shopName, amount, momoNumber, network } = payload
                    ;[smsResult, emailResult] = await Promise.allSettled([
                        sendShopWithdrawalProcessedSMS(phone, firstName, amount, network, momoNumber),
                        sendShopWithdrawalProcessedEmail(email, firstName, shopName, amount, momoNumber, network),
                    ])
                break
            }

            // ── Alert 7b: Withdrawal Rejected (owner) ──────────────────
            case 'withdrawal_rejected': {
                const { phone, firstName, email, shopName, amount, adminNote } = payload
                    ;[smsResult, emailResult] = await Promise.allSettled([
                        sendShopWithdrawalRejectedSMS(phone, firstName),
                        sendShopWithdrawalRejectedEmail(email, firstName, shopName, amount, adminNote),
                    ])
                break
            }

            // ── Alert 9: New Pricing Submission (admin) ────────────────
            case 'admin_pricing_submission': {
                // Only real admins/sub-admins can trigger alerts into the admin inbox.
                // Prevents customer/agent roles from spamming or spoofing admin alerts.
                if (!['admin', 'sub-admin'].includes(dbUser.role)) {
                    return NextResponse.json({ error: 'Forbidden: admin-only alert type' }, { status: 403 })
                }
                emailResult = await sendAdminShopPricingSubmissionAlert(payload)
                break
            }

            // ── Alert 10: New Shop Registration (admin) ────────────────
            case 'admin_new_shop': {
                if (!['admin', 'sub-admin'].includes(dbUser.role)) {
                    return NextResponse.json({ error: 'Forbidden: admin-only alert type' }, { status: 403 })
                }
                emailResult = await sendAdminNewShopRegistrationAlert(payload)
                break
            }

            // ── Alert 11: Withdrawal Request (admin) ───────────────────
            case 'admin_withdrawal_request': {
                if (!['admin', 'sub-admin'].includes(dbUser.role)) {
                    return NextResponse.json({ error: 'Forbidden: admin-only alert type' }, { status: 403 })
                }
                emailResult = await sendAdminShopWithdrawalRequestAlert(payload)
                break
            }

            default:
                return NextResponse.json({ error: `Unknown alert type: ${type}` }, { status: 400 })
        }

        return NextResponse.json({ success: true, smsResult, emailResult })

    } catch (err: any) {
        console.error('[Shop Alerts API]', err)
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
    }
}
