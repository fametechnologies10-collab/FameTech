// lib/api-webhook.ts
// Generalized fire-and-forget order-webhook dispatcher for the developer API
// v2 — same mechanics as lib/sms-webhook.ts's dispatchCampaignWebhook, but
// keyed on api_keys.webhook_url/webhook_secret (one pair per key row, so
// standard and commission keys are independently configurable) instead of
// sms_accounts. SMS itself is NOT migrated to this — its existing webhook
// stays on sms_accounts, a different trigger shape (campaign-reconcile cron,
// not order-completion). See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §7.
//
// Call this from INSIDE each product's own terminal-state-setting code
// (dispatchAirtimeFulfillment, purchaseWithWallet, the AFA status-update
// path, dispatchUtilityCore) — not only from the new v2 route handlers —
// so a webhook fires no matter which trigger finalized the order (the
// initial API call, a retry cron, or an admin action).
import { createHmac } from 'crypto'
import { LRUCache } from 'lru-cache'

export function signWebhookPayload(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
}

// ─── Per-key webhook config cache ───────────────────────────────────────────
//
// dispatchApiWebhook is called from inside every terminal-state transition, and
// several of those run in sequential loops of up to 50: the admin bulk route
// (MAX_BULK = 50) and app/api/cron/hubtel-commission-reconcile, which has FOUR
// such loops in one invocation. Without this cache that is up to 200 api_keys
// SELECTs per cron run whose answer is almost always "no webhook configured" —
// today it is ALWAYS that, since 0 of 39 keys have a webhook_url and, after the
// api_keys write-grant lockdown (20260824_lock_api_keys_writes.sql), no route
// can set one until the Phase 3 config UI lands.
//
// Caching the NEGATIVE result is the whole point: an unconfigured key costs one
// query per minute instead of one per order.
//
// 60s TTL, matching the validated-key cache in lib/api-auth.ts, so a newly
// configured webhook starts firing within a minute. Module-level, so each
// serverless instance keeps its own — no cross-instance leakage of the secret.
interface CachedWebhookConfig {
    webhook_url: string | null
    webhook_secret: string | null
}

const webhookConfigCache = new LRUCache<string, CachedWebhookConfig>({
    max: 5_000,
    ttl: 60_000,
})

/**
 * Exported for tests and for the Phase 3 config UI: after writing a new
 * webhook_url the caller should invalidate, otherwise the developer sees up to
 * 60s of "saved but nothing arrives" and reasonably concludes it is broken.
 */
export function invalidateWebhookConfig(apiKeyId: string): void {
    webhookConfigCache.delete(apiKeyId)
}

export interface ApiWebhookParams {
    apiKeyId: string
    event: string
    product: 'data' | 'airtime' | 'resultschecker' | 'afa' | 'utilities'
    reference: string
    status: string
    detail?: Record<string, any>
}

/**
 * True if `hostname` (already lowercased, WHATWG URL.hostname — IPv6 literals
 * keep their brackets, e.g. "[::1]") is an IP literal, v4 or v6. Covers the
 * IPv4-mapped IPv6 form (`::ffff:169.254.169.254`) since that's plain hex +
 * colons + dots once the brackets are stripped.
 */
function isIpLiteralHost(hostname: string): boolean {
    const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(unbracketed)) {
        return unbracketed.split('.').every(octet => Number(octet) <= 255)
    }
    return unbracketed.includes(':') && /^[0-9a-f:.]+$/i.test(unbracketed)
}

/**
 * SSRF guard for api_keys.webhook_url. Required because the column is
 * directly writable by any authenticated user from the browser today (the
 * UPDATE RLS policies on api_keys reuse USING as WITH CHECK, so only user_id
 * is protected — see C1 in phase2a-final-review.md) — this cannot be a
 * "trust the DB" check, it has to run on every dispatch.
 *
 * DNS-rebinding (a hostname that resolves to a public IP at some other time
 * but an internal one at request time) is explicitly OUT OF SCOPE — a
 * resolve-and-check here would add a DNS round-trip to a money path and isn't
 * reliably portable across the runtimes this file can run under. The
 * literal/hostname checks below are the intended scope; locking down the
 * api_keys UPDATE grant (C1) is the primary control.
 */
export function validateWebhookUrl(url: string): { ok: true } | { ok: false; reason: string } {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return { ok: false, reason: 'not a valid URL' }
    }

    if (parsed.protocol !== 'https:') {
        return { ok: false, reason: `scheme must be https, got "${parsed.protocol || 'unknown'}"` }
    }
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'credentials in the URL are not allowed' }
    }

    // Trailing dots are stripped FIRST. A trailing dot is the fully-qualified
    // form of a name and resolves identically — "localhost." is localhost — but
    // it makes every check below miss: the equality test fails, the suffix tests
    // fail, and `includes('.')` reports true so the bare-hostname check passes
    // it as if it were a real domain. Found by probing this function directly;
    // both "https://localhost./x" and "https://internal./x" got through before.
    //
    // (Encoded IPv4 forms — 2130706433, 0x7f000001, 017700000001, 127.1 — need
    // no special handling: the WHATWG URL parser normalises them all to dotted
    // quad before we see them, so isIpLiteralHost catches them.)
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '')

    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return { ok: false, reason: `disallowed hostname "${hostname}"` }
    }
    if (isIpLiteralHost(hostname)) {
        return { ok: false, reason: `IP-literal host "${hostname}" is not allowed` }
    }
    if (!hostname.includes('.')) {
        // Bare hostname (no dot) — resolves to internal services on many
        // networks (Docker/K8s DNS, /etc/hosts, split-horizon DNS).
        return { ok: false, reason: `bare hostname "${hostname}" is not allowed` }
    }

    return { ok: true }
}

/**
 * Fire-and-forget. Never throws, never blocks the caller. No-ops silently if
 * the key has no webhook configured, or if the configured URL fails the SSRF
 * guard. One retry on non-2xx/network failure.
 */
export async function dispatchApiWebhook(supabase: any, params: ApiWebhookParams): Promise<void> {
    try {
        let keyRow = webhookConfigCache.get(params.apiKeyId)
        if (!keyRow) {
            const { data, error } = await supabase
                .from('api_keys')
                .select('webhook_url, webhook_secret')
                .eq('id', params.apiKeyId)
                .maybeSingle()
            // Only cache on a clean read. Caching a transient DB error as "no
            // webhook" would silently suppress deliveries for the whole TTL.
            if (error) return
            keyRow = { webhook_url: data?.webhook_url ?? null, webhook_secret: data?.webhook_secret ?? null }
            webhookConfigCache.set(params.apiKeyId, keyRow)
        }

        if (!keyRow.webhook_url || !keyRow.webhook_secret) return

        const urlCheck = validateWebhookUrl(keyRow.webhook_url)
        if (!urlCheck.ok) {
            console.warn(`[API Webhook] blocked webhook_url for api_key ${params.apiKeyId}: ${urlCheck.reason}`)
            return
        }

        const payload = JSON.stringify({
            event: params.event,
            product: params.product,
            reference: params.reference,
            status: params.status,
            timestamp: new Date().toISOString(),
            ...(params.detail ? { detail: params.detail } : {}),
        })
        const signature = signWebhookPayload(keyRow.webhook_secret, payload)

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await fetch(keyRow.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-KFT-Signature': signature },
                    body: payload,
                    // Refuse to follow redirects: validateWebhookUrl only vets the URL we
                    // were given, so an allowed public host could otherwise 302 us onto an
                    // internal one and defeat the guard above.
                    redirect: 'error',
                    signal: AbortSignal.timeout(5000),
                })
                if (res.ok) return
            } catch {
                // fall through to retry / give up
            }
        }
        console.error(`[API Webhook] delivery failed for ${params.product} order ${params.reference} after retry`)
    } catch (e: any) {
        console.error('[API Webhook] dispatch error:', e?.message)
    }
}
