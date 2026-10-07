import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { validateWebhookUrl, invalidateWebhookConfig } from '@/lib/api-webhook'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// ============================================================================
// Developer-API webhook configuration (api_keys.webhook_url / webhook_secret).
//
// GET    — current config for each of the caller's keys (URL + whether a secret
//          is set; NEVER the secret itself after creation).
// PUT    — set/replace the webhook URL for one key. Returns a freshly generated
//          signing secret ONCE, at creation time only.
// DELETE — turn the webhook off for one key.
//
// ── WHY THIS ROUTE HAS TO EXIST AT ALL ─────────────────────────────────────
// api_keys is write-locked for the `authenticated` role
// (20260824_lock_api_keys_writes.sql), because leaving it writable let any
// logged-in user self-approve their own key, raise their own rate limits, and
// point webhook_url at an internal host. So a browser CANNOT update these
// columns directly — every write must come through a service-role route like
// this one, which is exactly the point: the validation below is unavoidable.
//
// ── SSRF ───────────────────────────────────────────────────────────────────
// validateWebhookUrl runs HERE on write as well as at dispatch time. Dispatch-
// time validation alone would mean a developer saves a bad URL, sees "saved",
// and then silently never receives anything. Validating on write turns that
// into an error they can act on. Both layers stay: this one is UX, the dispatch
// one is the security boundary that survives a future bug in this route.
// ============================================================================

// SMS deliberately excluded: its webhook feature lives entirely on
// sms_accounts.webhook_url via the separate /api/sms/webhook-config route
// (a different trigger shape — campaign-reconcile, not order-completion; see
// lib/api-webhook.ts's header comment). Accepting keyType:'sms' here would
// silently write to a column dispatchApiWebhook never reads for that key
// type — a confusing no-op, not a security issue, but worth closing off.
// WebhookConfigCard (the only UI that calls this route) never renders for
// 'sms' either, so this also matches what's actually reachable.
type KeyType = 'standard' | 'commission'
const VALID_KEY_TYPES: readonly KeyType[] = ['standard', 'commission']

export async function GET() {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
        if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const { data: keys, error } = await (supabase.from('api_keys') as any)
            .select('id, key_type, status, webhook_url, webhook_secret')
            .eq('user_id', authUser.id)

        if (error) {
            console.error('[ApiKeyWebhook] GET failed:', error.message)
            return NextResponse.json({ error: 'Could not load webhook settings' }, { status: 500 })
        }

        return NextResponse.json({
            webhooks: ((keys as any[]) || []).map(k => ({
                keyType: k.key_type,
                status: k.status,
                webhookUrl: k.webhook_url ?? null,
                // Boolean only. The secret is shown exactly once, in the PUT
                // response — re-exposing it on every GET would turn any XSS or
                // shoulder-surf into permanent signature forgery.
                hasSecret: !!k.webhook_secret,
            })),
        })
    } catch (e: any) {
        console.error('[ApiKeyWebhook] GET exception:', e?.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function PUT(request: NextRequest) {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
        if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // Scoped to the caller's own key already (no cross-account attack
        // surface), but nothing stopped a single user hammering this in a
        // loop — repeated writes each cost a DB round-trip plus a cache
        // invalidation. 10/min matches the money-path v2 write endpoints.
        const rl = consumeRateLimit(`api-keys-webhook-put:${authUser.id}`, 10, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ error: `Too many requests. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` }, { status: 429 })
        }

        let body: any
        try { body = await request.json() } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const keyType = body?.keyType as KeyType
        const webhookUrl = typeof body?.webhookUrl === 'string' ? body.webhookUrl.trim() : ''
        const rotateSecret = body?.rotateSecret === true

        if (!VALID_KEY_TYPES.includes(keyType)) {
            return NextResponse.json({ error: `keyType must be one of: ${VALID_KEY_TYPES.join(', ')}` }, { status: 400 })
        }
        if (!webhookUrl) {
            return NextResponse.json({ error: 'webhookUrl is required' }, { status: 400 })
        }
        if (webhookUrl.length > 500) {
            return NextResponse.json({ error: 'webhookUrl is too long (max 500 characters)' }, { status: 400 })
        }

        // SSRF gate — same function the dispatcher uses, so what saves here is
        // exactly what will be allowed to fire. Its `reason` is surfaced to the
        // developer verbatim: "blocked" with no explanation is a support ticket.
        const urlCheck = validateWebhookUrl(webhookUrl)
        if (!urlCheck.ok) {
            return NextResponse.json(
                { error: `That webhook URL is not allowed: ${urlCheck.reason}. Use a public HTTPS endpoint.` },
                { status: 400 }
            )
        }

        const supabase = createServerClient()

        // Scoped to the caller's own key. Service-role bypasses RLS, so this
        // .eq('user_id') IS the authorization check — not a convenience filter.
        const { data: keyRow } = await (supabase.from('api_keys') as any)
            .select('id, webhook_secret')
            .eq('user_id', authUser.id)
            .eq('key_type', keyType)
            .maybeSingle()

        if (!keyRow) {
            return NextResponse.json({ error: `You do not have a ${keyType} API key yet.` }, { status: 404 })
        }

        // Generate a secret on first setup, or when explicitly rotating. Kept
        // stable otherwise so changing a URL doesn't silently break every
        // signature check the developer has already deployed.
        const needsSecret = !keyRow.webhook_secret || rotateSecret
        const newSecret = needsSecret ? `whsec_${randomBytes(32).toString('hex')}` : null

        const update: Record<string, any> = { webhook_url: webhookUrl, updated_at: new Date().toISOString() }
        if (newSecret) update.webhook_secret = newSecret

        const { error: updateError } = await (supabase.from('api_keys') as any)
            .update(update)
            .eq('id', keyRow.id)
            .eq('user_id', authUser.id)

        if (updateError) {
            console.error('[ApiKeyWebhook] PUT failed:', updateError.message)
            return NextResponse.json({ error: 'Could not save webhook settings' }, { status: 500 })
        }

        // Without this the developer waits up to 60s wondering why nothing
        // arrives — dispatchApiWebhook caches per-key config, including the
        // "no webhook configured" negative result this write just invalidated.
        invalidateWebhookConfig(keyRow.id)

        return NextResponse.json({
            success: true,
            webhookUrl,
            // Returned ONCE. There is no endpoint that can read it back.
            signingSecret: newSecret,
            ...(newSecret
                ? { notice: 'Save this signing secret now — it is shown only once and cannot be retrieved later.' }
                : {}),
        })
    } catch (e: any) {
        console.error('[ApiKeyWebhook] PUT exception:', e?.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
        if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`api-keys-webhook-delete:${authUser.id}`, 10, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ error: `Too many requests. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` }, { status: 429 })
        }

        const keyType = new URL(request.url).searchParams.get('keyType') as KeyType
        if (!VALID_KEY_TYPES.includes(keyType)) {
            return NextResponse.json({ error: `keyType must be one of: ${VALID_KEY_TYPES.join(', ')}` }, { status: 400 })
        }

        const supabase = createServerClient()
        const { data: keyRow } = await (supabase.from('api_keys') as any)
            .select('id')
            .eq('user_id', authUser.id)
            .eq('key_type', keyType)
            .maybeSingle()

        if (!keyRow) {
            return NextResponse.json({ error: `You do not have a ${keyType} API key yet.` }, { status: 404 })
        }

        // Clear the secret alongside the URL. Leaving a stale secret behind
        // would silently resurrect the old signing key if the webhook is later
        // re-enabled, against a URL the developer may have since changed hands.
        const { error } = await (supabase.from('api_keys') as any)
            .update({ webhook_url: null, webhook_secret: null, updated_at: new Date().toISOString() })
            .eq('id', keyRow.id)
            .eq('user_id', authUser.id)

        if (error) {
            console.error('[ApiKeyWebhook] DELETE failed:', error.message)
            return NextResponse.json({ error: 'Could not disable the webhook' }, { status: 500 })
        }

        invalidateWebhookConfig(keyRow.id)
        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[ApiKeyWebhook] DELETE exception:', e?.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
