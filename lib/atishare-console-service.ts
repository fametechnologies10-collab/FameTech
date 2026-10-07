// AT-iShare Console (SPFastIT) fulfillment service.
// Vendor docs: docs/reference/atishare-console-spfastit-api.md
// Design:      docs/superpowers/specs/2026-08-21-atishare-console-supplier-design.md
//
// NOT to be confused with lib/at-ishare-service.ts, which is the CodeCraft integration
// that happens to fulfil AT-iShare-network orders. This file is the SPFastIT console,
// where we hold our own MB balance and push transfers to beneficiaries.
//
// Deliberately absent, and must not be added by analogy with other suppliers:
//   - No bundle-mapping cache. This API takes a raw MB integer; bundle_mb = GB * 1000.
//   - No `ambiguous` failure mode. client_reference gives deterministic recovery:
//     replaying an identical request returns the existing transaction (duplicate: true)
//     rather than creating a second one, so a dropped connection is fully recoverable.
//
// Task 5 wrote everything below as pure helpers only — no fetch, no API key, no circuit
// breaker, no clock reads. Task 6 appends the HTTP transport layer (callConsole, sendBundle,
// checkOrderStatus, fetchConsoleBalance, and the circuit breaker) further down this same file.

const ATISHARE_CONSOLE_API_KEY = process.env.ATISHARE_CONSOLE_API_KEY || ''
const ATISHARE_CONSOLE_BASE_URL = process.env.ATISHARE_CONSOLE_BASE_URL || 'https://console.spfastit.com/api'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
// Only `sendBundle` participates in this breaker. `checkOrderStatus` and
// `fetchConsoleBalance` deliberately do NOT. (`lib/bundleportal-service.ts` used to be the
// supplier this compared against — its own `checkOrderStatus` both gated on and recorded into
// its breaker — but that action was removed entirely when Bundle Portal moved to a v2 webhook,
// see `app/api/webhooks/bundleportal/route.ts`.) Re-read this reasoning before changing either
// supplier's read/breaker wiring:
//   - If read failures could OPEN the breaker, a flaky read endpoint would fast-fail
//     `sendBundle` and halt new dispatches — the same self-inflicted-outage shape that
//     took another supplier in this codebase offline, just reached through the read path.
//   - If the breaker GATED reads, we could not reconcile already-dispatched,
//     possibly-delivered orders during an outage — exactly when their fate matters most.
// The breaker protects the money-moving write path; reads stay available for
// reconciliation. A genuine full-API outage still opens it via `sendBundle`'s own
// transport faults, so protection is not lost.
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

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
    return true // half-open allows one probe
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
        console.log('[AtiShareConsole] Circuit breaker OPENED')
    }
}

export type ConsoleOrderStatus =
    | 'queued' | 'processing' | 'pending_retry'
    | 'completed' | 'failed' | 'failed_blocked' | 'billed_failure'

/**
 * Builds the client_reference sent to SPFastIT.
 *
 * `attemptNo` MUST come from `orders.retry_count`, which is written ONLY by the
 * claim_order_retry RPC. That is what makes this safe:
 *   - the re-fulfillment cron re-dispatches a pending order without touching
 *     retry_count, so it replays the SAME reference and SPFastIT returns the existing
 *     transaction instead of creating (and charging for) a second one;
 *   - a deliberate admin retry increments it, producing a NEW reference — necessary
 *     because replaying the old one would just return the same failed transaction.
 *
 * Never key this on a timestamp, a random value, or any counter the cron can advance:
 * that would mint a brand-new paid console order on every cron pass.
 */
export function buildClientReference(orderId: string, attemptNo?: number): string {
    const n = Number(attemptNo)
    const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    return `${orderId}-r${safe}`
}

/** Their system uses 1000MB = 1GB — decimal, never 1024. */
export function gbToMb(gb: number): number {
    return Math.round(gb * 1000)
}

/** Parses our size strings ("1GB", "2.5GB") to MB. Returns null rather than guessing. */
export function sizeToMb(size: string): number | null {
    const m = String(size ?? '').match(/(\d+(?:\.\d+)?)/)
    if (!m) return null
    const gb = Number(m[1])
    return Number.isFinite(gb) && gb > 0 ? gbToMb(gb) : null
}

/** Normalises to the 233… form SPFastIT echoes back. */
export function normalizeConsolePhone(phone: string): string {
    const digits = String(phone ?? '').replace(/\D/g, '')
    if (digits.startsWith('233')) return digits
    if (digits.startsWith('0')) return `233${digits.slice(1)}`
    return digits
}

/**
 * Their timestamps ("2026-07-21 21:45:30") carry NO timezone. A bare `new Date(s)`
 * resolves them against the PROCESS timezone, so the same string parses hours apart
 * under a different TZ. Vercel happens to default to UTC and Ghana is UTC+0, but
 * nothing in this repo pins TZ — so parse explicitly.
 */
export function parseConsoleTimestamp(raw: string): Date | null {
    const s = String(raw ?? '').trim()
    if (!s) return null
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)
    const iso = hasZone ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Maps a console order_status to our order status.
 * An UNKNOWN status maps to 'processing', never a terminal state — a status we do not
 * recognise must never be turned into a false success or a false failure.
 */
export function mapConsoleStatus(status: string): 'processing' | 'completed' | 'failed' {
    switch (status) {
        case 'completed': return 'completed'
        case 'failed':
        case 'failed_blocked':
        case 'billed_failure': return 'failed'
        default: return 'processing'
    }
}

/**
 * NONE of the console's terminal failures trip the circuit breaker.
 *
 * `failed_blocked` in particular is a routine, per-order recipient condition. The exact
 * analogue on another supplier (HendyLinks' HTTP 403, "not a verified beneficiary") was
 * misclassified as an instability signal and five in a row opened the breaker, turning a
 * normal rejection into a supplier-wide self-inflicted outage. Only transport faults
 * (handled at the call site) count toward the breaker.
 */
export function classifyConsoleFailure(status: string): { terminal: boolean; tripsBreaker: boolean } {
    const mapped = mapConsoleStatus(status)
    return { terminal: mapped !== 'processing', tripsBreaker: false }
}

/**
 * This supplier serves AT-iShare only. Enforced here, at the boundary, and not merely
 * via the admin network toggle: if a misconfiguration ever routed an MTN order here the
 * console would accept the bundle_mb and send AirtelTigo data to an MTN number — money
 * spent, customer unserved.
 */
export function assertAtIShareNetwork(network: string): boolean {
    return network === 'AT-iShare'
}

// ─── Transport layer ────────────────────────────────────────────────────────────

export interface ConsoleSendResult {
    success: boolean
    transactionId?: string
    duplicate?: boolean
    error?: string
    /** True only for transport faults — the ONLY failures that count toward the breaker. */
    transportFault?: boolean
    apiResponse?: any
}

export interface ConsoleStatusResult {
    success: boolean
    orderStatus?: ConsoleOrderStatus
    responseMessage?: string
    completedAt?: Date | null
    error?: string
    apiResponse?: any
}

export interface ConsoleBalance {
    success: boolean
    walletMb?: number
    reservedMb?: number
    availableMb?: number
    error?: string
}

/**
 * Form-encoded POST transport. Every exported endpoint routes through here.
 *
 * SECURITY: the API key travels in the request BODY. Never log `params` or the raw body
 * on any path — that would write the credential into logs.
 *
 * This API signals errors as HTTP 200 with `status: "error"` in the body, so `response.ok`
 * is NOT a usable success signal. Callers must read `body.status`.
 */
async function callConsole(
    endpoint: 'send.php' | 'check_order_status.php' | 'check_balance.php',
    params: Record<string, string>
): Promise<{ ok: boolean; body: any; transportFault: boolean }> {
    try {
        const form = new URLSearchParams({ api_key: ATISHARE_CONSOLE_API_KEY, ...params })
        const res = await fetch(`${ATISHARE_CONSOLE_BASE_URL}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        })
        const text = await res.text()
        let body: any
        try {
            body = JSON.parse(text)
        } catch {
            // A non-JSON body is a transport/infrastructure fault, not a business answer.
            return { ok: false, body: { status: 'error', message: 'Non-JSON response' }, transportFault: true }
        }
        return { ok: body?.status === 'success', body, transportFault: false }
    } catch (error: any) {
        console.error(`[AtiShareConsole] ${endpoint} transport error:`, error?.message || error)
        return { ok: false, body: null, transportFault: true }
    }
}

/**
 * Queues a bundle request. A `duplicate: true` response is a SUCCESSFUL RECOVERY of an
 * existing transaction, not an error — it is exactly what makes a dropped connection
 * safe to retry (vendor docs, Recommended Integration Flow step 4).
 */
export async function sendBundle(input: {
    phone: string
    bundleMb: number
    clientReference: string
}): Promise<ConsoleSendResult> {
    if (!ATISHARE_CONSOLE_API_KEY) {
        return { success: false, error: 'ATISHARE_CONSOLE_API_KEY is not configured' }
    }
    if (!checkCircuit()) {
        return { success: false, error: 'Service temporarily unavailable', transportFault: false }
    }

    const { ok, body, transportFault } = await callConsole('send.php', {
        phone: normalizeConsolePhone(input.phone),
        bundle_mb: String(input.bundleMb),
        client_reference: input.clientReference,
    })

    if (transportFault) {
        recordFailure()
        return { success: false, error: 'Failed to reach AT-iShare Console', transportFault: true }
    }

    if (!ok) {
        // A business rejection: the console answered correctly and declined. Never trips
        // the breaker. A reference conflict is PERMANENT (our reference derives from the
        // order id, so it should be unreachable) and must alert rather than be retried.
        recordSuccess()
        return { success: false, error: body?.message || 'Console rejected the request', apiResponse: body }
    }

    recordSuccess()
    return {
        success: true,
        transactionId: body?.transaction_id,
        duplicate: body?.duplicate === true,
        apiResponse: body,
    }
}

export async function checkOrderStatus(transactionId: string): Promise<ConsoleStatusResult> {
    if (!ATISHARE_CONSOLE_API_KEY) {
        return { success: false, error: 'ATISHARE_CONSOLE_API_KEY is not configured' }
    }

    const { ok, body, transportFault } = await callConsole('check_order_status.php', {
        transaction_id: transactionId,
    })

    if (transportFault) return { success: false, error: 'Failed to reach AT-iShare Console' }
    if (!ok) return { success: false, error: body?.message || 'Status lookup failed', apiResponse: body }

    return {
        success: true,
        orderStatus: body?.order_status as ConsoleOrderStatus,
        responseMessage: body?.response_message ?? undefined,
        completedAt: parseConsoleTimestamp(body?.completed_at ?? ''),
        apiResponse: body,
    }
}

/**
 * Returns the console's DATA balance in MB — this supplier is not denominated in currency.
 * `availableMb` is the operative number: queued and processing requests reserve part of
 * the wallet, so `walletMb` overstates what can actually be spent.
 */
export async function fetchConsoleBalance(): Promise<ConsoleBalance> {
    if (!ATISHARE_CONSOLE_API_KEY) {
        return { success: false, error: 'ATISHARE_CONSOLE_API_KEY is not configured' }
    }

    const { ok, body, transportFault } = await callConsole('check_balance.php', {})
    if (transportFault) return { success: false, error: 'Failed to reach AT-iShare Console' }
    if (!ok) return { success: false, error: body?.message || 'Balance lookup failed' }

    const walletMb = Number(body?.wallet_balance_mb)
    const reservedMb = Number(body?.reserved_queue_mb)
    const availableMb = Number(body?.available_mb)
    if ([walletMb, reservedMb, availableMb].some(v => Number.isNaN(v))) {
        return { success: false, error: `Unparseable balance: ${JSON.stringify(body)}` }
    }
    return { success: true, walletMb, reservedMb, availableMb }
}
