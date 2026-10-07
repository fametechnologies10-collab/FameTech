import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import { sendWelcomeEmail, sendAdminNewUserAlert } from '@/lib/email-service'
import { sendWelcomeSMS } from '@/lib/sms-service'
import { welcomeNotification } from '@/lib/notification-service'
import { waitUntil } from '@vercel/functions'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// Best-effort idempotency store (matches middleware's KV/Upstash naming).
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

// Only fire the welcome flow for an account created within this window. A real
// signup calls this immediately; an attacker replaying an old/known userId is
// rejected.
const FRESH_SIGNUP_WINDOW_MS = 30 * 60 * 1000

// Generic OK response — never reveal whether the userId was valid/fresh/duplicate.
const ok = () => NextResponse.json({ success: true })

/**
 * Fires the post-signup welcome flow (email + SMS + in-app + admin alert).
 *
 * SECURITY (A6): this route was unauthenticated and sent email/SMS to ANY
 * body-supplied recipient with an attacker-controlled name — an email/SMS-credit
 * drain, an admin-inbox flood, and a branded-phishing cannon. It cannot require
 * an auth session because the email-confirmation signup flow has none yet.
 * Instead we bind every recipient to the user's OWN database record:
 *   - the caller may only pass a userId; email/name/phone are read from the DB,
 *     so an attacker can never target an arbitrary victim address;
 *   - the account must have been created in the last 30 minutes (fresh signup);
 *   - a one-shot Redis guard makes it send at most once per user.
 * Body-supplied email/firstName/etc. are ignored for sending.
 */
export async function POST(request: NextRequest) {
    try {
        let body: { userId?: unknown }
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const userId = body?.userId
        if (!userId || typeof userId !== 'string' || userId.length > 64) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 })
        }

        // Bind to the user's own record — recipients come from the DB, not the body.
        const { data: userRow, error: lookupError } = await supabaseAdmin
            .from('users')
            .select('first_name, last_name, email, phone_number, created_at')
            .eq('id', userId)
            .single<{
                first_name: string | null
                last_name: string | null
                email: string | null
                phone_number: string | null
                created_at: string | null
            }>()

        // Unknown user → generic OK (no enumeration of which IDs exist).
        if (lookupError || !userRow || !userRow.email) {
            return ok()
        }

        // Only for a freshly-created account.
        const createdMs = userRow.created_at ? new Date(userRow.created_at).getTime() : 0
        if (!createdMs || Date.now() - createdMs > FRESH_SIGNUP_WINDOW_MS) {
            return ok()
        }

        // One-shot: send the welcome flow at most once per user (best-effort).
        if (redis) {
            try {
                const fresh = await redis.set(`welcome-sent:${userId}`, '1', { nx: true, ex: 86400 })
                if (fresh === null) return ok() // already sent
            } catch (e) {
                console.error('[WelcomeEmail] idempotency check failed, proceeding:', e)
            }
        }

        const firstName = userRow.first_name || 'there'
        const lastName = userRow.last_name || ''
        const email = userRow.email
        const phoneNumber = userRow.phone_number || ''

        // Send welcome email to the user's own registered address.
        const welcomeResult = await sendWelcomeEmail(email, firstName)
        if (!welcomeResult.success) {
            console.error('[WelcomeEmail] Failed to send:', welcomeResult.error)
        }

        // In-app welcome notification (non-blocking).
        waitUntil(
            (async () => {
                try {
                    const template = welcomeNotification()
                    await (supabaseAdmin.from('notifications') as any).insert({
                        user_id: userId,
                        title: template.title,
                        message: template.message,
                        type: template.type,
                        action_url: template.actionUrl,
                        is_read: false,
                    })
                } catch (err) {
                    console.error('[WelcomeEmail] Failed to create welcome notification:', err)
                }
            })()
        )

        // Welcome SMS to the user's own number (non-blocking).
        if (phoneNumber) {
            waitUntil(
                sendWelcomeSMS(phoneNumber, firstName)
                    .catch((err: Error) => console.error('[WelcomeEmail] Welcome SMS failed:', err))
            )
        }

        // Admin new-user alert (non-blocking) — all fields from the DB record.
        waitUntil(
            sendAdminNewUserAlert({
                firstName,
                lastName,
                email,
                phoneNumber: phoneNumber || 'Not provided',
            }).catch((err: Error) => console.error('[WelcomeEmail] Admin notification failed:', err))
        )

        return NextResponse.json({ success: true, messageId: welcomeResult.messageId })
    } catch (error: any) {
        console.error('[WelcomeEmail] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
