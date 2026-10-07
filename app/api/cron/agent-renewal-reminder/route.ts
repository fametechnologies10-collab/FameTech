import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendAgentRenewalReminderSMS, sendDealerRenewalReminderSMS } from '@/lib/sms-service'
import { sendAgentRenewalReminderEmail, sendDealerRenewalReminderEmail } from '@/lib/email-service'
import { sendPushNotification } from '@/lib/push-service'
import { createNotification, roleRenewalReminderNotification } from '@/lib/notification-service'
import { validateCronAuth } from '@/lib/cron-utils'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// ── Helper ────────────────────────────────────────────────────────────────────
// Returns true if a reminder notification with the given title was already
// sent to userId in the last 2 days (deduplication guard).
async function alreadySentReminder(userId: string, title: string): Promise<boolean> {
    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)

    const { data } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('title', title)
        .gte('created_at', twoDaysAgo.toISOString())
        .limit(1)

    return !!(data && data.length > 0)
}

// ── processReminder ───────────────────────────────────────────────────────────
async function processReminder(
    user: { id: string; first_name: string | null; phone_number: string | null; email: string | null },
    role: 'agent' | 'dealer'
): Promise<{ id: string; status: string; smsSent?: boolean; emailSent?: boolean }> {
    const title = role === 'agent' ? 'Agent Role Expiring Soon' : 'Dealer Role Expiring Soon'
    const firstName = user.first_name || (role === 'agent' ? 'Agent' : 'Dealer')

    // Deduplication check
    if (await alreadySentReminder(user.id, title)) {
        console.log(`[RenewalReminder] Reminder already sent for ${role} ${user.id}`)
        return { id: user.id, status: 'already_sent' }
    }

    let smsSuccess = false
    let emailSuccess = false

    if (user.phone_number) {
        const smsResult = role === 'agent'
            ? await sendAgentRenewalReminderSMS(user.phone_number, firstName)
            : await sendDealerRenewalReminderSMS(user.phone_number, firstName)
        if (smsResult.success) smsSuccess = true
        else console.error(`[RenewalReminder] SMS failed for ${role} ${user.id}:`, smsResult.error)
    }

    if (user.email) {
        const emailResult = role === 'agent'
            ? await sendAgentRenewalReminderEmail(user.email, firstName)
            : await sendDealerRenewalReminderEmail(user.email, firstName)
        if (emailResult.success) emailSuccess = true
        else console.error(`[RenewalReminder] Email failed for ${role} ${user.id}:`, emailResult.error)
    }

    if (smsSuccess || emailSuccess) {
        // Create in-app notification and capture the ID for push deep-link
        const template = roleRenewalReminderNotification(role)
        const { id: notifId } = await createNotification({ userId: user.id, ...template })

        // Fire push notification pointing to the specific notification row
        await sendPushNotification(user.id, {
            title: template.title,
            body: template.message,
            notificationId: notifId,
        })

        return { id: user.id, status: 'success', smsSent: smsSuccess, emailSent: emailSuccess }
    }

    return { id: user.id, status: 'failed', smsSent: false, emailSent: false }
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        // Window: now → now + 48 hours
        const now = new Date()
        const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000)

        // ── Agents expiring within 48h ────────────────────────────────────────
        const { data: expiringAgents, error: agentError } = await supabaseAdmin
            .from('users')
            .select('id, first_name, phone_number, email')
            .eq('role', 'agent')
            .gte('agent_expires_at', now.toISOString())
            .lt('agent_expires_at', in48h.toISOString())

        if (agentError) {
            console.error('[RenewalReminder] Error fetching expiring agents:', agentError)
            return NextResponse.json({ error: 'Database error fetching agents' }, { status: 500 })
        }

        // ── Dealers expiring within 48h ───────────────────────────────────────
        const { data: expiringDealers, error: dealerError } = await supabaseAdmin
            .from('users')
            .select('id, first_name, phone_number, email')
            .eq('role', 'dealer')
            .gte('dealer_expires_at', now.toISOString())
            .lt('dealer_expires_at', in48h.toISOString())

        if (dealerError) {
            console.error('[RenewalReminder] Error fetching expiring dealers:', dealerError)
            return NextResponse.json({ error: 'Database error fetching dealers' }, { status: 500 })
        }

        const agents = expiringAgents || []
        const dealers = expiringDealers || []

        console.log(`[RenewalReminder] Found ${agents.length} agents and ${dealers.length} dealers expiring within 48h`)

        if (agents.length === 0 && dealers.length === 0) {
            return NextResponse.json({ message: 'No roles expiring within the next 48 hours' })
        }

        // Process all in parallel
        const [agentResults, dealerResults] = await Promise.all([
            Promise.all(agents.map(u => processReminder(u, 'agent'))),
            Promise.all(dealers.map(u => processReminder(u, 'dealer'))),
        ])

        return NextResponse.json({
            message: 'Renewal reminder process completed',
            agents: { processed: agentResults.length, details: agentResults },
            dealers: { processed: dealerResults.length, details: dealerResults },
        })

    } catch (error: any) {
        console.error('[RenewalReminder] Exception:', error)
        return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 })
    }
}
