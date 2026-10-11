/**
 * Brevo transactional email client — fallback provider used by
 * lib/email-service.ts when Resend fails.
 */

interface BrevoSendOptions {
    to: string
    toName?: string
    from: string
    fromName: string
    subject: string
    htmlContent: string
}

export async function sendViaBrevo(options: BrevoSendOptions): Promise<{ messageId: string }> {
    const apiKey = process.env.BREVO_API_KEY
    if (!apiKey) {
        throw new Error('BREVO_API_KEY not set')
    }

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'api-key': apiKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            sender: { name: options.fromName, email: options.from },
            to: [{ email: options.to, name: options.toName }],
            subject: options.subject,
            htmlContent: options.htmlContent,
        }),
    })

    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
        throw new Error(body?.message || `Brevo API error (status ${res.status})`)
    }

    return { messageId: body.messageId }
}
