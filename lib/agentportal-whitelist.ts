// ─── AgentPortal MTN whitelist verification ─────────────────────────────────────
//
// AgentPortal gates MTN delivery behind a per-account whitelist: only enabled numbers can
// receive data. Their verify endpoint reports allowed true/false AND auto-submits every
// `allowed: false` number to MTN for enabling (no fixed turnaround, no automatic retry on
// their side).
//
// That auto-submit side effect is why this module is strict about what it will forward:
// every number is normalized and prefix-checked against MTN's own ranges BEFORE it can
// reach AgentPortal. A non-MTN or malformed entry is rejected locally and never sent — it
// would otherwise be pushed to MTN as a whitelist request for a number that can never be
// whitelisted on the MTN network.
//
// This endpoint moves no money. It is read-mostly (the only write is the whitelist
// submission on MTN's side), so there is no wallet/refund path here by design.

const AGENTPORTAL_API_KEY = process.env.AGENTPORTAL_API_KEY || ''
const AGENTPORTAL_API_BASE_URL = process.env.AGENTPORTAL_API_BASE_URL || 'https://api.agentportalgh.com'

/** AgentPortal's documented ceiling for one POST body. */
export const MAX_MSISDNS_PER_REQUEST = 1000

/**
 * Longest raw entry we will even attempt to clean. A Ghanaian MSISDN is at most
 * "+233 24 100 0001" style — well under this. Anything longer is not a truncated phone
 * number, it is someone probing with a payload, so it is rejected without processing.
 */
const MAX_RAW_ENTRY_LENGTH = 24

/** MTN Ghana prefixes, mirroring lib/phone-validation.ts's NETWORK_PREFIXES.MTN. */
const MTN_PREFIXES: ReadonlySet<string> = new Set(['024', '025', '053', '054', '055', '059'])

const REQUEST_TIMEOUT_MS = 20000

export interface WhitelistResult {
    /** Echo of what the caller submitted, after our normalization. */
    input: string
    /** AgentPortal's own normalized form (falls back to ours when absent). */
    normalized: string
    allowed: boolean
}

export interface InvalidEntry {
    input: string
    reason: string
}

export interface NormalizeResult {
    /** Deduped, normalized, MTN-only numbers safe to forward to AgentPortal. */
    valid: string[]
    /** Everything rejected locally, with a human-readable reason. Never forwarded. */
    invalid: InvalidEntry[]
}

/**
 * Trims a raw entry to something safe to display back to the user.
 *
 * Callers echo `invalid[].input` into the UI, so this bounds length and strips control
 * characters. It does NOT strip `<`/`&` — React escapes on render, and the API response is
 * JSON, so escaping here would corrupt the echo instead of protecting anything.
 */
function safeEcho(raw: string): string {
    // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
    return raw.replace(/[\x00-\x1F\x7F]/g, '').slice(0, MAX_RAW_ENTRY_LENGTH)
}

/**
 * Normalizes ONE raw entry to a 10-digit MTN MSISDN, or explains why it cannot be.
 *
 * Accepts local (0241000001), international (+233241000001 / 233241000001) and
 * loosely-spaced/dashed forms. Everything else is rejected.
 */
export function normalizeMtnMsisdn(raw: unknown): { ok: true; msisdn: string } | { ok: false; input: string; reason: string } {
    if (typeof raw !== 'string') {
        return { ok: false, input: '', reason: 'Not a text value' }
    }

    const trimmed = raw.trim()
    if (!trimmed) {
        return { ok: false, input: '', reason: 'Empty' }
    }

    const echo = safeEcho(trimmed)

    if (trimmed.length > MAX_RAW_ENTRY_LENGTH) {
        return { ok: false, input: echo, reason: 'Too long to be a phone number' }
    }

    // Only digits, literal spaces, dashes, dots, parentheses and a leading + are plausible in
    // a typed or pasted phone number. Anything else (letters, quotes, braces, control chars)
    // means the entry is not a phone number at all — reject rather than silently strip it, so
    // a payload can never be quietly reduced into a valid-looking number.
    //
    // The space here is deliberately a literal space, NOT \s: \s matches newlines, which
    // would let a two-line paste such as "024100\n0001" collapse into the perfectly valid
    // "0241000001" — a number the user never typed. Line splitting belongs to the caller.
    if (!/^\+?[\d ()\-.]+$/.test(trimmed)) {
        return { ok: false, input: echo, reason: 'Contains invalid characters' }
    }

    let cleaned = trimmed.replace(/\D/g, '')

    if (cleaned.startsWith('233')) {
        cleaned = '0' + cleaned.slice(3)
    } else if (cleaned.length === 9 && !cleaned.startsWith('0')) {
        // "241000001" — a local number typed without its leading zero.
        cleaned = '0' + cleaned
    }

    if (cleaned.length !== 10) {
        return { ok: false, input: echo, reason: 'Must be 10 digits' }
    }
    if (!cleaned.startsWith('0')) {
        return { ok: false, input: echo, reason: 'Must start with 0' }
    }
    if (!MTN_PREFIXES.has(cleaned.slice(0, 3))) {
        return { ok: false, input: echo, reason: 'Not an MTN number' }
    }

    return { ok: true, msisdn: cleaned }
}

/**
 * Normalizes a whole batch, deduping valid numbers while preserving first-seen order.
 *
 * A duplicate is dropped silently rather than reported as invalid — pasting the same number
 * twice is a user typo, not an error worth surfacing, and forwarding it twice would be a
 * pointless duplicate whitelist submission.
 */
export function normalizeMtnBatch(rawList: unknown[]): NormalizeResult {
    const valid: string[] = []
    const invalid: InvalidEntry[] = []
    const seen = new Set<string>()

    for (const raw of rawList) {
        const result = normalizeMtnMsisdn(raw)
        if (!result.ok) {
            invalid.push({ input: result.input, reason: result.reason })
            continue
        }
        if (seen.has(result.msisdn)) continue
        seen.add(result.msisdn)
        valid.push(result.msisdn)
    }

    return { valid, invalid }
}

export interface VerifyResponse {
    results: WhitelistResult[]
    allowed_count: number
    total: number
    /** Set on transport/API failure. When present, `results` is empty and nothing was submitted. */
    error?: string
}

/**
 * Coerces AgentPortal's verify response into our shape, dropping anything unrecognizable.
 *
 * Handles BOTH shapes their API actually returns (verified live, 2026-07-26 — their docs
 * show only the first, which is why this is checked rather than assumed):
 *
 *   bulk POST  -> { network, results: [{ input, normalized, allowed }], allowed_count, total }
 *   single GET -> { network, msisdn, normalized, allowed }        ← flat, NO results array
 *
 * Their response is untrusted input like any other upstream: `allowed` is coerced to a
 * strict boolean so a truthy string ("false") can never read as allowed, and callers
 * recompute allowed_count/total from the rows actually kept rather than trusting their
 * counters — a mismatch would otherwise show the user a count that contradicts the list
 * right below it.
 *
 * Exported for scripts/test-agentportal-whitelist.ts.
 */
export function parseResults(payload: unknown, fallbackMsisdns: string[]): WhitelistResult[] {
    if (!payload || typeof payload !== 'object') return []

    const record = payload as Record<string, unknown>
    const rows = Array.isArray(record.results)
        ? record.results
        // Flat single-number shape: treat the payload itself as one row. Gated on `allowed`
        // being a real boolean so an unrelated/error payload is not read as a result.
        : (typeof record.allowed === 'boolean' ? [record] : [])

    const results: WhitelistResult[] = []
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, unknown> | null
        if (!row || typeof row !== 'object') continue

        // `input` on bulk rows, `msisdn` on the flat single row, and finally what we sent.
        const input =
            typeof row.input === 'string' ? row.input
            : typeof row.msisdn === 'string' ? row.msisdn
            : (fallbackMsisdns[i] ?? '')
        const normalized = typeof row.normalized === 'string' && row.normalized ? row.normalized : input
        if (!input && !normalized) continue

        results.push({
            input: safeEcho(input),
            normalized: safeEcho(normalized),
            allowed: row.allowed === true,
        })
    }
    return results
}

async function callVerify(url: string, init: RequestInit, msisdns: string[]): Promise<VerifyResponse> {
    const empty = { results: [] as WhitelistResult[], allowed_count: 0, total: 0 }

    try {
        const response = await fetch(url, {
            ...init,
            headers: { 'X-API-Key': AGENTPORTAL_API_KEY, ...(init.headers || {}) },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        if (!response.ok) {
            console.error(`[MtnWhitelist] Verify failed: HTTP ${response.status}`)
            return { ...empty, error: `Whitelist service returned an error (${response.status})` }
        }

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[MtnWhitelist] Verify returned non-JSON (HTTP ${response.status})`)
            return { ...empty, error: 'Whitelist service returned an unexpected response' }
        }

        const results = parseResults(await response.json(), msisdns)
        return {
            results,
            allowed_count: results.filter(r => r.allowed).length,
            total: results.length,
        }
    } catch (err: unknown) {
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        console.error('[MtnWhitelist] Verify exception:', err instanceof Error ? err.message : err)
        return { ...empty, error: isTimeout ? 'Whitelist check timed out. Please try again.' : 'Could not reach the whitelist service' }
    }
}

/**
 * Verifies already-normalized MTN numbers against AgentPortal's whitelist.
 *
 * Always uses the bulk POST endpoint, even for a single number. AgentPortal also exposes a
 * single-number GET, but it returns a DIFFERENT (flat) response shape than the POST — see
 * parseResults. One verified code path is worth more than the marginal saving of the GET:
 * two shapes to keep in sync is exactly how a silent "nothing was checked" bug gets in.
 * parseResults still understands the flat shape as a safety net.
 *
 * Callers MUST pass output from normalizeMtnBatch — this function does not re-validate, and
 * every `allowed: false` number it forwards gets auto-submitted to MTN for enabling.
 *
 * Never throws: transport/API failures come back as `.error` with an empty result set.
 */
export async function verifyMtnWhitelist(msisdns: string[]): Promise<VerifyResponse> {
    if (!AGENTPORTAL_API_KEY) {
        return { results: [], allowed_count: 0, total: 0, error: 'Whitelist checking is not configured' }
    }
    if (msisdns.length === 0) {
        return { results: [], allowed_count: 0, total: 0 }
    }
    if (msisdns.length > MAX_MSISDNS_PER_REQUEST) {
        // Defence in depth — the route caps this too. Refuse rather than silently truncate,
        // because a silent truncation would report "all checked" for numbers never sent.
        return { results: [], allowed_count: 0, total: 0, error: `Cannot check more than ${MAX_MSISDNS_PER_REQUEST} numbers at once` }
    }

    return callVerify(
        `${AGENTPORTAL_API_BASE_URL}/api/mtn-whitelist/verify`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msisdns }),
        },
        msisdns
    )
}
