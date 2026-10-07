// lib/bundleportal-whitelist.ts
// -----------------------------------------------------------------------------
// Bundle Portal's MTN whitelist check (`verify_number` action) — the second
// supplier in the dual-supplier merge (see lib/mtn-whitelist-merge.ts). It is free
// (no charge) but, like AgentPortal's verify, an allowed:false number is also
// submitted to MTN for registration (confirmed by the platform owner) — so every
// call here has that outward side effect. It only reads `allowed`, never
// `can_order`/`pending_order` (those reflect an in-flight order conflict, a
// separate, out-of-scope concern — see docs/superpowers/specs/
// 2026-09-28-mtn-dual-supplier-whitelist-design.md).
//
// Bundle Portal has NO bulk verify_number endpoint (single-number only), so a
// batch is fanned out with bounded concurrency, processed in sequential chunks of
// CONCURRENCY. For a large dashboard batch (hundreds of numbers) the chunk count adds up —
// combined with this project's blanket 60s function timeout (vercel.json), a slow run could
// previously exceed it and come back as a hard error instead of a result (investigated
// 2026-09-30, "Server 2 whitelist checks erroring on large batches"). CONCURRENCY was raised
// from 20 to shrink the number of sequential chunks; this hits Bundle Portal's READ-rate
// allowance specifically (separate from order placement per
// docs/reference/bundleportal-developer-api.md), and a 429 here is already handled by
// dropping just that number from the result rather than failing the batch — see verifyOne.
// `app/api/mtn-whitelist/verify/route.ts` also carries its own `maxDuration` override as a
// safety margin on top of this.
// -----------------------------------------------------------------------------

const BUNDLEPORTAL_API_KEY = process.env.BUNDLEPORTAL_API_KEY || ''
const BUNDLEPORTAL_API_BASE_URL = process.env.BUNDLEPORTAL_API_BASE_URL || 'https://api.bundleportal.com/v2'
const REQUEST_TIMEOUT_MS = 20000
const CONCURRENCY = 40

export interface BundlePortalWhitelistResult {
    /** Echo of what the caller submitted (already-normalized MTN MSISDN). */
    input: string
    normalized: string
    allowed: boolean
}

export interface BundlePortalVerifyResponse {
    results: BundlePortalWhitelistResult[]
    /** Set only on total configuration failure (no API key) — never on a per-number failure. */
    error?: string
}

/** Verifies ONE already-normalized MTN MSISDN. Never throws. */
async function verifyOne(msisdn: string): Promise<BundlePortalWhitelistResult | null> {
    try {
        const response = await fetch(BUNDLEPORTAL_API_BASE_URL, {
            method: 'POST',
            headers: { 'x-api-key': BUNDLEPORTAL_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify_number', network: 'mtn', recipient: msisdn }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[BundlePortalWhitelist] Non-JSON response (HTTP ${response.status}) for ${msisdn}`)
            return null
        }

        const data = await response.json()
        if (data?.success !== true || typeof data.data?.allowed !== 'boolean') {
            console.warn(`[BundlePortalWhitelist] verify_number failed for ${msisdn}: HTTP ${response.status} ${data?.message || data?.error || ''}`)
            return null
        }

        return { input: msisdn, normalized: msisdn, allowed: data.data.allowed === true }
    } catch (err: unknown) {
        console.error(`[BundlePortalWhitelist] verify_number exception for ${msisdn}:`, err instanceof Error ? err.message : err)
        return null
    }
}

/**
 * Verifies already-normalized MTN numbers against Bundle Portal's whitelist.
 *
 * Callers MUST pass output already validated by normalizeMtnMsisdn/normalizeMtnBatch (this
 * function does not re-validate). Never throws: a per-number failure is silently dropped from
 * `results` rather than guessed at — matches lib/agentportal-whitelist.ts's fail-open contract.
 * `error` is set ONLY when the whole call can't proceed at all (no API key configured).
 */
export async function verifyBundlePortalWhitelist(msisdns: string[]): Promise<BundlePortalVerifyResponse> {
    if (msisdns.length === 0) return { results: [] }
    if (!BUNDLEPORTAL_API_KEY) return { results: [], error: 'Whitelist checking is not configured' }

    const results: BundlePortalWhitelistResult[] = []
    for (let i = 0; i < msisdns.length; i += CONCURRENCY) {
        const chunk = msisdns.slice(i, i + CONCURRENCY)
        const settled = await Promise.all(chunk.map(verifyOne))
        for (const r of settled) if (r) results.push(r)
    }

    return { results }
}
