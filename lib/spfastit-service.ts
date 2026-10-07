// SPFastIT Supplier API (full wallet account) fulfillment service – Telecel only.
// Vendor docs: docs/reference/spfastit-supplier-api.md
// Design:      docs/superpowers/specs/2026-09-25-spfastit-telecel-supplier-design.md
//
// NOT to be confused with lib/atishare-console-service.ts, which is a DIFFERENT SPFastIT
// product (the "Console") reachable at console.spfastit.com/api, AT-iShare-only, MB-
// denominated, form-encoded, no webhooks. This file is the full reseller/wallet account at
// spfastit.com/wp-json/custom-api/v1, JSON-encoded, cash-denominated, Telecel-only (this
// codebase deliberately never sends network:"mtn" even though the vendor supports it –
// MTN pricing was checked live and rejected as not competitive).
//
// Deliberately absent, and must not be added by analogy with other suppliers:
//   - No fallback wiring in either direction (see the design spec's scope decisions).
//   - No `ambiguous` handling for anything except a genuine transport fault on Place Order –
//     this supplier's duplicate-reference behavior is UNTESTED, so a transport fault (where
//     we can't tell if SPFastIT received the request) is the only ambiguous case; a definite
//     HTTP/business rejection is never ambiguous.

import { getSiteUrl } from '@/lib/site-url'

const SPFASTIT_API_KEY = process.env.SPFASTIT_API_KEY || ''
const SPFASTIT_BASE_URL = process.env.SPFASTIT_BASE_URL || 'https://spfastit.com/wp-json/custom-api/v1'

/**
 * Parses our size strings ("10GB") to MB. Deliberately NOT restricted to a hardcoded allowlist
 * of sizes SPFastIT has confirmed supporting — a prior version of this function rejected any
 * size outside a live-verified set (10/15/.../100 GB), which meant a size the admin re-enables
 * in the catalog (e.g. 5GB, after SPFastIT told us they restore it "when stock is available")
 * would silently fail on OUR side before ever reaching the vendor, even once they genuinely
 * support it again. Per an explicit platform-owner decision (2026-09-27): this function's job
 * is only to convert the size to the units SPFastIT's API expects (1000 MB = 1 GB, confirmed
 * live, never 1024) — whether a given size is actually sellable is SPFastIT's call to make via
 * their own business-rejection response (handled generically by callSpfastit/placeOrder as a
 * non-success JSON body, never trips the circuit breaker), not something this function
 * pre-emptively blocks. The only local guard left is basic parse sanity (a real, finite,
 * positive GB figure) — not a business judgement about which sizes exist.
 */
export function sizeToMb(size: string): number | null {
    const m = String(size ?? '').match(/^(\d+(?:\.\d+)?)\s*GB$/i)
    if (!m) return null
    const gb = Number(m[1])
    if (!Number.isFinite(gb) || gb <= 0) return null
    return Math.round(gb * 1000)
}

/**
 * This supplier serves Telecel only in this codebase, even though its API also accepts
 * network:"mtn" – MTN pricing was checked live and rejected as not competitive. Enforced
 * here, at the boundary, not merely via the admin network toggle: a misconfiguration must
 * never be able to route an MTN order here.
 */
export function assertTelecelNetwork(network: string): boolean {
    return network === 'Telecel'
}

/**
 * Builds the reference sent to SPFastIT. `attemptNo` MUST come from `orders.retry_count`,
 * written ONLY by the claim_order_retry RPC – this supplier's repeated-reference behavior on
 * Place Order is UNTESTED (see the design spec §7/§9), so this is a defensive default that is
 * safe regardless of which way that resolves:
 *   - the re-fulfillment cron re-dispatches a pending order without touching retry_count, so
 *     it replays the SAME reference every pass;
 *   - a deliberate admin retry increments retry_count, producing a NEW reference.
 * Never key this on a timestamp or a cron-advanced counter.
 */
export function buildSpfastitReference(orderId: string, attemptNo?: number): string {
    const n = Number(attemptNo)
    const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    return `${orderId}-r${safe}`
}

/**
 * Recovers our order id from a reference we generated ourselves (buildSpfastitReference's
 * exact format). Unlike DataKazina's extractOrderIdCandidates, this does not need to guess at
 * multiple shapes – we fully control the format, so a single anchored regex is correct.
 */
export function extractOrderIdFromReference(reference: string): string | null {
    const m = String(reference ?? '').match(/^([0-9a-f-]{36})-r\d+$/i)
    return m ? m[1] : null
}

/**
 * Recovers the attempt number (the `-r<n>` suffix) from a reference we generated ourselves
 * (buildSpfastitReference's exact format). Used by the webhook's stale-attempt guard: a
 * late/redelivered event for an OLD attempt (e.g. `-r0`) must never be allowed to clobber a
 * NEWER attempt (`-r1`) that has since superseded it on the order. Returns null for anything
 * that isn't a reference in our own format — never guess a number for unrecognized input.
 */
export function extractAttemptNoFromReference(reference: string): number | null {
    const m = String(reference ?? '').match(/^[0-9a-f-]{36}-r(\d+)$/i)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
}

/**
 * Maps SPFastIT's status to our order status. Three DIFFERENT spellings of the same
 * "not yet served" state are now confirmed to exist and are all tolerated:
 *   - "not-served" (lowercase, hyphenated) – the LIVE `order_status` field on a real Place
 *     Order response, verified 2026-09-26 (see docs/reference/spfastit-supplier-api.md,
 *     "Live production findings"). This is the one that actually matters.
 *   - "Not Served" (space, title case) – admin-reported dashboard wording, never confirmed
 *     as a literal API field value.
 *   - "initiated" – the vendor's own docs example for this same endpoint.
 * Before this fix, "not-served" fell through to the safe default (below) rather than being
 * explicitly recognised – it produced the correct 'processing' result only by luck of that
 * default, not by design. An unrecognized status still maps to 'processing', never a
 * terminal state – a status we don't recognise must never become a false success or failure.
 */
export function mapSpfastitStatus(raw: string): 'processing' | 'completed' | 'failed' {
    const s = String(raw ?? '').trim().toLowerCase()
    if (s === 'served' || s === 'completed') return 'completed'
    if (s === 'failed') return 'failed'
    if (s === 'not served' || s === 'not-served' || s === 'initiated' || s.startsWith('wip')) return 'processing'
    return 'processing'
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────────────────────
// Only `placeOrder` participates – matches the AT-iShare Console's reasoning exactly (see
// that file's own comment): gating reads (checkOrderStatus/fetchSupplierBalance) on the
// breaker would block reconciliation of already-dispatched orders during exactly the outage
// when their fate matters most, and letting read failures open the breaker would fast-fail
// new dispatches over a flaky read endpoint alone.
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000

function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        const now = Date.now()
        if (lastFailureTime && now - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (failureCount >= FAILURE_THRESHOLD) {
        circuitState = 'open'
        console.log('[Spfastit] Circuit breaker OPENED')
    }
}

export interface SpfastitSendResult {
    success: boolean
    orderId?: number
    error?: string
    /** True only for transport faults – the ONLY failures that count toward the breaker
     *  and the only ones classified `ambiguous` by callers (see design spec §7). */
    transportFault?: boolean
    apiResponse?: any
}

export interface SpfastitStatusResult {
    success: boolean
    orderStatus?: string
    error?: string
    apiResponse?: any
}

export interface SpfastitBalanceResult {
    success: boolean
    balance?: number
    currency?: string
    error?: string
}

/**
 * JSON-body POST transport. No documented HTTP status codes for errors anywhere in the
 * vendor's docs – treated conservatively: a non-2xx OR a JSON body with status !== "success"
 * is a business-style rejection (never trips the breaker); a network exception or a
 * non-JSON body is a transport fault (does trip the breaker, and is what callers use to
 * decide `ambiguous`).
 *
 * SECURITY: api_key travels in the JSON body. Never log `body` or the raw request on any
 * path – that would write the credential into logs.
 */
async function callSpfastit(
    endpoint: 'place-order' | 'status' | 'balance' | 'prices',
    body: Record<string, unknown>
): Promise<{ ok: boolean; json: any; transportFault: boolean }> {
    try {
        const res = await fetch(`${SPFASTIT_BASE_URL}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: SPFASTIT_API_KEY, ...body }),
        })
        const text = await res.text()
        let json: any
        try {
            json = JSON.parse(text)
        } catch {
            return { ok: false, json: { status: 'error', message: 'Non-JSON response' }, transportFault: true }
        }
        const ok = res.ok && json?.status === 'success'
        return { ok, json, transportFault: false }
    } catch (error: any) {
        console.error(`[Spfastit] ${endpoint} transport error:`, error?.message || error)
        return { ok: false, json: null, transportFault: true }
    }
}

/**
 * Builds the webhook URL to register on Place Order, embedding our own generated secret
 * since SPFastIT signs nothing natively (design spec §10, mirrors the DataKazina webhook
 * fix). Returns undefined if SPFASTIT_WEBHOOK_SECRET is unset – Place Order still proceeds
 * without a webhook_url in that case; the cron poll backup (Task 8) is what makes that safe,
 * not a hard requirement at dispatch time.
 */
function buildWebhookUrl(): string | undefined {
    const secret = process.env.SPFASTIT_WEBHOOK_SECRET || ''
    if (!secret) return undefined
    return `${getSiteUrl()}/api/webhooks/spfastit?secret=${encodeURIComponent(secret)}`
}

/**
 * Places a Telecel order. Always sends network:"telecel" – this codebase never sends "mtn"
 * through this supplier (see the module header). Callers are responsible for calling
 * assertTelecelNetwork and sizeToMb themselves before this, exactly like the AT-iShare
 * Console's sendBundle callers do – kept as separate, individually-testable functions
 * rather than folded into one, per the design's isolation guidance.
 */
export async function placeOrder(input: {
    phone: string
    bundleMb: number
    reference: string
}): Promise<SpfastitSendResult> {
    if (!SPFASTIT_API_KEY) {
        return { success: false, error: 'SPFASTIT_API_KEY is not configured' }
    }
    if (!checkCircuit()) {
        return { success: false, error: 'Service temporarily unavailable', transportFault: false }
    }

    const webhookUrl = buildWebhookUrl()
    const { ok, json, transportFault } = await callSpfastit('place-order', {
        phone: input.phone,
        size_mb: input.bundleMb,
        network: 'telecel',
        reference: input.reference,
        ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    })

    if (transportFault) {
        recordFailure()
        return { success: false, error: 'Failed to reach SPFastIT', transportFault: true }
    }

    if (!ok) {
        // A business rejection: SPFastIT answered and declined. Never trips the breaker –
        // no documented rejection codes exist yet (design spec §11), so every non-success
        // answer is treated this way until real rejections are observed in production.
        recordSuccess()
        return { success: false, error: json?.message || 'SPFastIT rejected the request', apiResponse: json }
    }

    recordSuccess()
    return { success: true, orderId: json?.order_id, apiResponse: json }
}

/** Looks up an order by OUR reference – simpler than an order_id/reference dual path since
 *  we always know our own reference (buildSpfastitReference is deterministic per order). */
export async function checkOrderStatus(reference: string): Promise<SpfastitStatusResult> {
    if (!SPFASTIT_API_KEY) {
        return { success: false, error: 'SPFASTIT_API_KEY is not configured' }
    }
    const { ok, json, transportFault } = await callSpfastit('status', { reference })
    if (transportFault) return { success: false, error: 'Failed to reach SPFastIT' }
    if (!ok) return { success: false, error: json?.message || 'Status lookup failed', apiResponse: json }
    return { success: true, orderStatus: json?.order_status, apiResponse: json }
}

/** Cash balance (µ) – normalized to GHS at the call site (Task 10), not here, matching how
 *  every other cash-denominated supplier's fetchSupplierBalance is written in this codebase. */
export async function fetchSupplierBalance(): Promise<SpfastitBalanceResult> {
    if (!SPFASTIT_API_KEY) {
        return { success: false, error: 'SPFASTIT_API_KEY is not configured' }
    }
    const { ok, json, transportFault } = await callSpfastit('balance', {})
    if (transportFault) return { success: false, error: 'Failed to reach SPFastIT' }
    if (!ok) return { success: false, error: json?.message || 'Balance lookup failed' }
    const balance = Number(json?.balance)
    if (Number.isNaN(balance)) return { success: false, error: `Unparseable balance: ${JSON.stringify(json)}` }
    return { success: true, balance, currency: 'GHS' }
}
