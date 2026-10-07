// lib/sub-agent-credentials-delivery.ts
//
// Single shared SMS+email delivery path for handing a sub-agent a plaintext
// access key — used by BOTH new-account onboarding (lib/sub-agent-create.ts)
// and recruiter/self-service key regeneration (lib/sub-agent-regenerate.ts,
// lib/sub-agent-key.ts). Keeping one path means there is exactly one place
// to audit for "does the plaintext key ever leak outside the message body."

export interface CredentialsDeliveryDeps {
    sendSms: (options: { recipient: string; message: string }) => Promise<{ success: boolean; error?: string }>
    sendEmail: (options: { to: string; toName?: string; subject: string; htmlContent: string }) => Promise<{ success: boolean; error?: string }>
}

export type CredentialsDeliveryKind = 'onboarding' | 'reset'

export interface CredentialsDeliveryResult {
    smsDelivered: boolean
    emailDelivered: boolean
}

const AGENT_LOGIN_URL = process.env.NEXT_PUBLIC_AGENT_URL || 'https://agent.kingflexygh.com'

function buildSmsMessage(kind: CredentialsDeliveryKind, plaintextKey: string): string {
    if (kind === 'onboarding') {
        return `Welcome to KiNG FLEXY GH! Your sub-agent access key is: ${plaintextKey}. `
            + `Sign in at ${AGENT_LOGIN_URL} — you'll be asked to set your own password on first login.`
    }
    return `Your KiNG FLEXY GH sub-agent access key was reset. New key: ${plaintextKey}. It becomes active the next time you sign in with it, within 2 hours. Didn't request this? Contact your recruiter.`
}

function buildEmailHtml(kind: CredentialsDeliveryKind, plaintextKey: string, firstName: string | null): string {
    const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
    if (kind === 'onboarding') {
        return `<p>${greeting}</p>`
            + `<p>You've been added as a sub-agent on KiNG FLEXY GH. Your access key is:</p>`
            + `<p style="font-size:18px;font-weight:bold;letter-spacing:1px;">${plaintextKey}</p>`
            + `<p>Sign in at <a href="${AGENT_LOGIN_URL}">${AGENT_LOGIN_URL}</a>. `
            + `You'll be asked to set your own password the first time you log in.</p>`
    }
    return `
        <p>Your KiNG FLEXY GH sub-agent access key was reset by your recruiter.</p>
        <p style="font-size: 20px; font-weight: 700; letter-spacing: 2px;">${plaintextKey}</p>
        <p>It becomes active the next time you sign in with it, within 2 hours. Until then, your old key still works.</p>
        <p>If you did not expect this, contact your recruiter or support.</p>
    `
}

/**
 * Attempts one channel's delivery and logs the outcome with full detail
 * before collapsing it to a boolean — distinguishes three cases so nothing
 * is lost to callers that only see the returned boolean:
 *   1. No contact info on file for this channel at all (never calls `send`).
 *   2. `send` resolved but reported failure (logs its `error` field).
 *   3. `send` rejected/threw (logs the rejection reason).
 * Never throws — a failure on this channel must never take down the other.
 */
async function attemptChannelDelivery(
    channel: 'sms' | 'email',
    kind: CredentialsDeliveryKind,
    target: string | null,
    send: () => Promise<{ success: boolean; error?: string }>,
): Promise<boolean> {
    if (!target) {
        console.error(`[deliverSubAgentCredentials] ${kind} ${channel}: no contact info on file, skipping`)
        return false
    }
    try {
        const result = await send()
        if (!result.success) {
            console.error(`[deliverSubAgentCredentials] ${kind} ${channel} delivery failed for ${target}`, result.error)
            return false
        }
        return true
    } catch (err) {
        console.error(`[deliverSubAgentCredentials] ${kind} ${channel} delivery threw for ${target}`, err)
        return false
    }
}

/**
 * Sends the plaintext access key to a sub-agent via SMS + email. Best-effort
 * on each channel independently (a failure on one does not block the other,
 * and neither failure throws). Logs every failure mode (missing contact
 * info, a resolved-but-unsuccessful send, or a thrown/rejected send) here —
 * the one place both the onboarding and reset call sites share — so callers
 * only need the returned booleans and never have to duplicate logging.
 */
export async function deliverSubAgentCredentials(
    kind: CredentialsDeliveryKind,
    recipient: { phone: string | null; email: string | null; firstName: string | null },
    plaintextKey: string,
    deps: CredentialsDeliveryDeps,
): Promise<CredentialsDeliveryResult> {
    const smsMessage = buildSmsMessage(kind, plaintextKey)
    const emailHtml = buildEmailHtml(kind, plaintextKey, recipient.firstName)
    const subject = kind === 'onboarding'
        ? 'Your KiNG FLEXY GH sub-agent access key'
        : 'Your new KiNG FLEXY GH sub-agent access key'

    const [smsDelivered, emailDelivered] = await Promise.all([
        attemptChannelDelivery('sms', kind, recipient.phone, () =>
            deps.sendSms({ recipient: recipient.phone as string, message: smsMessage })),
        attemptChannelDelivery('email', kind, recipient.email, () =>
            deps.sendEmail({ to: recipient.email as string, toName: recipient.firstName || undefined, subject, htmlContent: emailHtml })),
    ])

    return { smsDelivered, emailDelivered }
}
