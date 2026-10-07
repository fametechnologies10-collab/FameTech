import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { generateWebhookSecret, fingerprintSecret } from '@/lib/sms-webhook'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export async function GET() {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const rl = consumeRateLimit(`sms-webhook-config-get:${user.id}`, 20, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

    const { data: account } = await (supabase.from('sms_accounts') as any)
        .select('mode, webhook_url, webhook_secret')
        .eq('user_id', user.id)
        .maybeSingle()

    if (!account || account.mode !== 'business') {
        return NextResponse.json({ success: false, error: 'Webhook config requires business mode' }, { status: 403 })
    }

    return NextResponse.json({
        success: true,
        data: {
            webhookUrl: account.webhook_url,
            hasSecret: !!account.webhook_secret,
            secretFingerprint: account.webhook_secret ? fingerprintSecret(account.webhook_secret) : null,
        },
    })
}

export async function PUT(request: NextRequest) {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const rl = consumeRateLimit(`sms-webhook-config-put:${user.id}`, 10, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

    const { data: account } = await (supabase.from('sms_accounts') as any)
        .select('id, mode').eq('user_id', user.id).maybeSingle()
    if (!account || account.mode !== 'business') {
        return NextResponse.json({ success: false, error: 'Webhook config requires business mode' }, { status: 403 })
    }

    let body: any
    try { body = await request.json() } catch {
        return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
    }

    const webhookUrl = typeof body?.webhookUrl === 'string' ? body.webhookUrl.trim() : null
    if (webhookUrl && webhookUrl.length > 2048) {
        return NextResponse.json({ success: false, error: 'webhookUrl is too long (max 2048 characters)' }, { status: 400 })
    }
    if (webhookUrl) {
        try {
            const u = new URL(webhookUrl)
            if (u.protocol !== 'https:') {
                return NextResponse.json({ success: false, error: 'webhookUrl must be an https:// URL' }, { status: 400 })
            }
        } catch {
            return NextResponse.json({ success: false, error: 'webhookUrl is not a valid URL' }, { status: 400 })
        }
    }

    const newSecret = webhookUrl ? generateWebhookSecret() : null
    // sms_accounts RLS has a SELECT-only policy (no UPDATE grant for
    // authenticated/public) — the mode column must only ever change via the
    // admin KYC review flow, so no blanket owner-UPDATE policy exists. This
    // write is therefore issued through the service-role client, scoped to
    // exactly webhook_url/webhook_secret (never mode or any other column).
    const db = createServerClient() as any
    const { error } = await db.from('sms_accounts')
        .update({ webhook_url: webhookUrl, webhook_secret: newSecret })
        .eq('id', account.id)

    if (error) {
        return NextResponse.json({ success: false, error: 'Failed to update webhook config' }, { status: 500 })
    }

    return NextResponse.json({
        success: true,
        data: {
            webhookUrl,
            secret: newSecret, // shown ONCE — caller must store it now
        },
    })
}
