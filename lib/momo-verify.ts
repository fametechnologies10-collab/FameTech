/**
 * Multi-provider MoMo account name resolution for Ghana numbers.
 *
 * Providers supported:
 *   • Moolre  — native Ghana gateway, fastest for local numbers
 *   • Paystack — reliable fallback with broad Ghana MoMo coverage
 *   • Hubtel  — slot reserved; wire in when docs are available
 *
 * Single lookup  : tries providers in sequence until one succeeds
 * Bulk lookup    : distributes phones across all providers in parallel,
 *                  effectively multiplying the cap (100 × N providers)
 */

// ─── Network metadata ─────────────────────────────────────────────────────────

const NETWORK_META: Record<string, { label: string; paystackCode: string; moolreChannel: number }> = {
    '024': { label: 'MTN',     paystackCode: 'MTN', moolreChannel: 1 },
    '025': { label: 'MTN',     paystackCode: 'MTN', moolreChannel: 1 },
    '053': { label: 'MTN',     paystackCode: 'MTN', moolreChannel: 1 },
    '054': { label: 'MTN',     paystackCode: 'MTN', moolreChannel: 1 },
    '055': { label: 'MTN',     paystackCode: 'MTN', moolreChannel: 1 },
    '059': { label: 'MTN',     paystackCode: 'MTN', moolreChannel: 1 },
    // Paystack's Ghana mobile-money code for Telecel (ex-Vodafone) is VOD — confirmed
    // against GET /bank?currency=GHS&type=mobile_money (2026-09-28). 'VDF' was rejected
    // with "Unknown bank code: VDF", so the Paystack fallback never worked for Telecel.
    '020': { label: 'TELECEL', paystackCode: 'VOD', moolreChannel: 6 },
    '050': { label: 'TELECEL', paystackCode: 'VOD', moolreChannel: 6 },
    '026': { label: 'AT',      paystackCode: 'ATL', moolreChannel: 7 },
    '027': { label: 'AT',      paystackCode: 'ATL', moolreChannel: 7 },
    '056': { label: 'AT',      paystackCode: 'ATL', moolreChannel: 7 },
    '057': { label: 'AT',      paystackCode: 'ATL', moolreChannel: 7 },
}

export type NameResolveResult = {
    firstName: string
    lastName:  string
    fullName:  string
    provider:  'paystack' | 'moolre' | 'hubtel'
    network:   string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// No fetch here previously carried a timeout — on Vercel a Serverless Function
// can be frozen the instant it returns a response, so a hanging provider call
// made after the response (e.g. the payer name-resolution kicked off by a
// refund SMS) could wedge forever and never complete. A few seconds is ample
// for a name-lookup call; on timeout these resolvers already return null,
// same as any other failure.
const PROVIDER_TIMEOUT_MS = 5000
// Moolre's name enquiry measured 1.3–5.5 s (2026-09-28); at 5 s roughly 1 lookup in 4
// was cut off before the answer arrived. Still bounded, just with realistic headroom.
const MOOLRE_TIMEOUT_MS = 8000

function toLocal(normalizedPhone: string): string {
    return '0' + normalizedPhone.slice(3)
}

function getMeta(normalizedPhone: string) {
    const prefix = toLocal(normalizedPhone).substring(0, 3)
    return NETWORK_META[prefix] ?? null
}

function splitName(fullName: string): { firstName: string; lastName: string } {
    const parts = fullName.trim().split(/\s+/)
    return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}

// ─── Paystack ─────────────────────────────────────────────────────────────────

async function resolveViaPaystack(normalizedPhone: string): Promise<NameResolveResult | null> {
    const key  = process.env.PAYSTACK_SECRET_KEY
    const meta = getMeta(normalizedPhone)
    if (!key || !meta) return null

    try {
        const res  = await fetch(
            `https://api.paystack.co/bank/resolve?account_number=${toLocal(normalizedPhone)}&bank_code=${meta.paystackCode}`,
            { headers: { Authorization: `Bearer ${key}`, 'Cache-Control': 'no-store' }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }
        )
        const data: any = await res.json().catch(() => ({}))
        if (data.status === true && data.data?.account_name) {
            const fullName = data.data.account_name as string
            return { ...splitName(fullName), fullName, provider: 'paystack', network: meta.label }
        }
        return null
    } catch {
        return null
    }
}

// ─── Moolre ───────────────────────────────────────────────────────────────────

async function resolveViaMoolre(normalizedPhone: string): Promise<NameResolveResult | null> {
    const apiUser  = process.env.MOOLRE_TRANSFER_API_USER
    const apiKey   = process.env.MOOLRE_TRANSFER_API_KEY
    const acctNum  = process.env.MOOLRE_ACCOUNT_NUMBER
    const meta     = getMeta(normalizedPhone)
    if (!apiUser || !apiKey || !acctNum || !meta) return null

    try {
        const rawBody = await fetch('https://api.moolre.com/open/transact/validate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/json',
                'X-API-USER':   apiUser,
                'X-API-KEY':    apiKey,
            },
            body: JSON.stringify({
                type:          1,
                receiver:      toLocal(normalizedPhone),
                channel:       meta.moolreChannel,
                currency:      'GHS',
                accountnumber: acctNum,
            }),
            signal: AbortSignal.timeout(MOOLRE_TIMEOUT_MS),
        }).then(r => r.text())

        // Moolre's PHP backend sometimes prepends a var_dump line before JSON
        let data: any = null
        try { data = JSON.parse(rawBody) } catch {
            const i = rawBody.indexOf('{'), j = rawBody.lastIndexOf('}')
            if (i !== -1 && j > i) try { data = JSON.parse(rawBody.slice(i, j + 1)) } catch { /* */ }
        }

        if (data && String(data.status) === '1' && data.data) {
            const fullName = String(data.data)
            return { ...splitName(fullName), fullName, provider: 'moolre', network: meta.label }
        }
        return null
    } catch {
        return null
    }
}

// ─── Hubtel (reserved) ────────────────────────────────────────────────────────
// async function resolveViaHubtel(normalizedPhone: string): Promise<NameResolveResult | null> {
//     // TODO: implement when Hubtel name-enquiry endpoint docs are available
//     return null
// }

// ─── Provider registry ────────────────────────────────────────────────────────
// Order matters for single lookups — first entry is tried first.
// Moolre is listed first because it connects directly to Ghanaian networks.
// Paystack is the fallback with broad coverage.
type Resolver = (phone: string) => Promise<NameResolveResult | null>

const PROVIDERS: { name: string; fn: Resolver }[] = [
    { name: 'moolre',   fn: resolveViaMoolre   },
    { name: 'paystack', fn: resolveViaPaystack  },
    // { name: 'hubtel', fn: resolveViaHubtel }, // uncomment when ready
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Try each available provider in sequence until one returns a name.
 * Best for single contact adds or the verify endpoint.
 */
export async function resolveNameSingle(
    normalizedPhone: string
): Promise<NameResolveResult | null> {
    for (const { fn } of PROVIDERS) {
        const result = await fn(normalizedPhone)
        if (result) return result
    }
    // Moolre's failures are intermittent — measured 2026-09-28, the same numbers flipped
    // between resolving and not across runs minutes apart. Once every provider has had a
    // go, one retry of the primary recovers most of them. Only runs on a full miss, and
    // no caller is on the USSD hot path (all are owner/admin-triggered API routes).
    return await PROVIDERS[0].fn(normalizedPhone)
}

/**
 * Bulk name enrichment distributed across all providers in parallel.
 *
 * The phones array is split into N chunks (one per provider) and all chunks
 * run simultaneously, so total capacity = capPerProvider × N providers.
 * Right now: 100 × 2 = 200 per upload. Adding Hubtel makes it 300.
 *
 * Returns a Map of normalizedPhone → NameResolveResult.
 */
export async function resolveNamesBulk(
    normalizedPhones: string[],
    capPerProvider = 100
): Promise<Map<string, NameResolveResult>> {
    const results     = new Map<string, NameResolveResult>()
    const totalCap    = PROVIDERS.length * capPerProvider
    const phones      = normalizedPhones.slice(0, totalCap)

    // Split phones into equally-sized chunks, one chunk per provider
    await Promise.allSettled(
        PROVIDERS.map(async ({ fn }, idx) => {
            const chunk = phones.slice(idx * capPerProvider, (idx + 1) * capPerProvider)
            for (const phone of chunk) {
                try {
                    const result = await fn(phone)
                    if (result) results.set(phone, result)
                } catch { /* skip individual failures */ }
            }
        })
    )

    return results
}

/** How many phones can be enriched in one bulk call with current providers. */
export const BULK_ENRICH_TOTAL_CAP = PROVIDERS.length * 100

export { getMeta as getNetworkMeta }
