// Bundle Portal Fulfillment Service — mirrors lib/codecraft-service.ts architecture, adapted
// for Bundle Portal's single action-based endpoint. See docs/reference/bundleportal-developer-api.md.

import type { OrderToFulfill, BulkOrderResult } from '@/lib/fulfillment-service'

const BUNDLEPORTAL_API_KEY = process.env.BUNDLEPORTAL_API_KEY || ''
const BUNDLEPORTAL_API_BASE_URL = process.env.BUNDLEPORTAL_API_BASE_URL || 'https://api.bundleportal.com/v1'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

// Bundle Portal's documented `code` values for a deliberate business decision (the supplier
// answered correctly, it just declined this order) — never opens the circuit. HTTP 402
// (balance too low) is also a business rejection but carries NO `code` field at all — it is
// classified by HTTP status alone in isBusinessRejection() below, not through this set.
export const BUSINESS_REJECTION_CODES: ReadonlySet<string> = new Set([
    'not_allowlisted',
    'pending_order',
    'network_locked',
    'channel_locked',
    'role_locked',
    'paused',
    'unavailable',
    'validation',
    // v2: account suspended is an account-state condition, not a transient
    // integration failure — mirrors how role_locked is already classified.
    'suspended',
    // v2 sandbox-confirmed 2026-09-28 (place_order against a recipient ending 3333): the
    // supplier correctly rejected a bad recipient number — a customer typo, not our
    // integration failing. Never trip the breaker for it.
    'invalid_recipient',
])

/**
 * Classifies a failed Bundle Portal response as a business rejection (supplier answered
 * correctly, it just declined this specific request) vs a genuine integration/system
 * failure. Business rejections must never trip the circuit breaker.
 *
 * HTTP 402 (balance too low, docs/reference/bundleportal-developer-api.md) is a documented
 * business condition but the docs only describe it as an HTTP status + message shape — no
 * `code` field is ever present on it. Matching on `code` alone would leave 402 with
 * `code === undefined`, fail the `BUSINESS_REJECTION_CODES.has(code)` check, and incorrectly
 * count a routine "wallet needs topping up" response toward the 5-strike threshold. So 402 is
 * special-cased by HTTP status, independent of whatever (if anything) is in `code`.
 */
export function isBusinessRejection(httpStatus: number, code?: string): boolean {
    if (httpStatus === 402) return true
    return !!code && BUSINESS_REJECTION_CODES.has(code)
}

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
        console.log('[BundlePortal] Circuit breaker OPENED')
    }
}

// ─── Bundle Catalog Cache (Two-Tier: Memory + Supabase) ────────────────────────
export interface BundleEntry { id: number; network: string; size_gb: number; price: number; validity: string }

let bundleCatalogCache: BundleEntry[] = []
let lastBundleFetch: number | null = null
const BUNDLE_CACHE_DURATION = 3600000 // 1 hour
const BUNDLE_MAP_KEY = 'bundleportal_bundle_map'

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
}

/**
 * Maps our internal network name to Bundle Portal's `network` field.
 * AT-BigTime is explicitly NOT supported (Bundle Portal's docs never confirm it) — returns
 * null rather than guessing a mapping that could silently misroute an order.
 */
export function resolveBundlePortalNetwork(network: string): 'mtn' | 'telecel' | 'airteltigo' | null {
    if (network === 'MTN') return 'mtn'
    if (network === 'Telecel') return 'telecel'
    if (network === 'AT-iShare') return 'airteltigo'
    return null
}

/**
 * Single-endpoint, action-based transport helper. Every exported function in this module
 * routes through here. Returns the parsed JSON body plus the HTTP status; never throws for a
 * non-2xx response (business rejections are valid, well-formed JSON) — only network/parse
 * failures throw, caught by callers.
 */
async function callBundlePortal(action: string, body: Record<string, unknown> = {}): Promise<{ httpStatus: number; data: any }> {
    const response = await fetch(BUNDLEPORTAL_API_BASE_URL, {
        method: 'POST',
        headers: {
            'x-api-key': BUNDLEPORTAL_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, ...body }),
    })

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
        const rawText = await response.text()
        console.error(`[BundlePortal] Non-JSON response (HTTP ${response.status}) for action=${action}:`, rawText.slice(0, 300))
        throw new Error(`Bundle Portal returned an unexpected response format (HTTP ${response.status})`)
    }

    const data = await response.json()
    return { httpStatus: response.status, data }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    dispatchKey: string = orderId
): Promise<FulfillmentResponse> {
    if (!checkCircuit()) {
        console.warn(`[BundlePortal] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)' }
    }

    // Ruling P-1: validation gates (network, size) run BEFORE the API-key config guard, so a
    // malformed/unsupported request is reported precisely even when the key is unset — see
    // lib/agentportal-service.ts:127-139 for the precedent this mirrors.
    const bpNetwork = resolveBundlePortalNetwork(network)
    if (!bpNetwork) {
        console.log(`[BundlePortal] Skip: unsupported network "${network}" (AT-BigTime is not offered by Bundle Portal)`)
        return { success: false, error: `Bundle Portal does not support network: ${network}` }
    }

    const sizeMatch = dataSize.match(/[\d.]+/)
    if (!sizeMatch) {
        return { success: false, error: `Invalid data size format: ${dataSize}` }
    }
    const packageSize = Number(sizeMatch[0])
    if (!Number.isInteger(packageSize) || packageSize <= 0) {
        return { success: false, error: `Bundle Portal package_size must be a whole GB number, got: ${dataSize}` }
    }

    if (!BUNDLEPORTAL_API_KEY) {
        return { success: false, error: 'Bundle Portal is not configured' }
    }

    // Validate against the cached catalog when available — fails OPEN: an empty/stale cache
    // (config missing, cache fetch error) never blocks an order Bundle Portal's own
    // place_order validation would otherwise accept; it only short-circuits a call we can
    // already prove would fail with a KNOWN, non-empty catalog for this network.
    const catalog = await fetchBundlePortalBundles(bpNetwork)
    if (catalog.length > 0 && !catalog.some(b => b.size_gb === packageSize)) {
        const available = catalog.map(b => `${b.size_gb}GB`).join(', ')
        console.log(`[BundlePortal] Skip: no ${packageSize}GB bundle for ${bpNetwork}. Available: ${available}`)
        return { success: false, error: `No ${packageSize}GB package found for ${bpNetwork} on Bundle Portal` }
    }

    let normalizedPhone = phoneNumber
    if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3)
    else if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone

    let attempt = 0
    const maxAttempts = 3
    let lastError: Error | null = null

    while (attempt < maxAttempts) {
        attempt++
        try {
            const { httpStatus, data } = await callBundlePortal('place_order', {
                network: bpNetwork,
                recipient: normalizedPhone,
                package_size: packageSize,
                // order_id is Bundle Portal's idempotency key — always send it (dispatchKey,
                // never dropped), or a retry after a lost reply becomes a brand-new order and
                // double-charges the wallet.
                order_id: dispatchKey,
            })

            if (httpStatus === 429 || (httpStatus === 503 && data?.code === 'order_capacity_busy')) {
                console.warn(`[BundlePortal] Rate limited (HTTP ${httpStatus}, code=${data?.code}). Order ${orderId} kept pending.`)
                return { success: false, error: data?.message || data?.error || 'Supplier rate limited', isRateLimited: true, apiResponse: data }
            }

            if (data?.success === true) {
                const reference = data.data?.reference
                if (!reference) {
                    // Bundle Portal answered correctly (success:true) but gave us nothing to
                    // track the order by. Treating this as a success would advance the order to
                    // 'processing' with bundleportal_reference IS NULL — both sync routes filter
                    // on that column being non-null, and there is no webhook, so the order would
                    // be stranded forever with no alert. Classify as a failure instead: this
                    // reverts the order to 'pending' via the caller's normal failure path, and a
                    // same-order_id retry recovers it safely through Bundle Portal's idempotency
                    // (duplicate:true, no double charge). Deliberately NOT recordFailure() —
                    // Bundle Portal answered correctly, this is not a circuit-breaker-worthy
                    // integration failure.
                    console.error(`[BundlePortal] Order ${orderId} succeeded with no reference in response — treating as failure so it can be safely retried. HTTP ${httpStatus}.`)
                    return {
                        success: false,
                        error: 'Bundle Portal accepted the order but returned no reference',
                        apiResponse: data,
                    }
                }
                recordSuccess()
                return {
                    success: true,
                    reference,
                    transactionId: reference,
                    apiResponse: data,
                }
            }

            // Business rejection: Bundle Portal answered correctly, it just declined.
            const code = typeof data?.code === 'string' ? data.code : undefined
            console.warn(`[BundlePortal] Order ${orderId} not fulfilled. HTTP ${httpStatus} code=${code} — ${data?.message || data?.error}. Order kept pending.`)
            if (!isBusinessRejection(httpStatus, code)) {
                recordFailure()
            }
            return {
                success: false,
                error: data?.message || data?.error || 'Bundle Portal declined the order',
                apiResponse: data,
            }
        } catch (err: any) {
            lastError = err
            console.error(`[BundlePortal] Fetch error on attempt ${attempt} for order ${orderId}:`, err.message)
            if (attempt < maxAttempts) {
                const delay = 2000 * attempt // 2s, 4s
                await new Promise(res => setTimeout(res, delay))
            }
        }
    }

    recordFailure()
    return { success: false, error: lastError?.message || 'Persistent network error connecting to Bundle Portal' }
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    if (!BUNDLEPORTAL_API_KEY) return { success: false, error: 'Bundle Portal is not configured' }

    try {
        const { data } = await callBundlePortal('check_balance')

        if (data?.success !== true) {
            return { success: false, error: data?.message || data?.error || 'Failed to fetch balance' }
        }

        const rawBalance = data.data?.wallet_balance
        if (rawBalance === undefined || rawBalance === null) {
            return { success: false, error: 'Balance missing from supplier response' }
        }
        const balance = Number(rawBalance)
        if (Number.isNaN(balance)) {
            return { success: false, error: `Unparseable balance value: ${JSON.stringify(rawBalance)}` }
        }
        return { success: true, balance, currency: data.data?.currency || 'GHS' }
    } catch (error: any) {
        console.error('[BundlePortal Balance] Error:', error)
        return { success: false, error: error.message }
    }
}

/**
 * Fetches Bundle Portal's package catalog (get_bundles) and caches it in memory + Supabase,
 * same two-tier pattern as lib/codecraft-service.ts's fetchAllBundleMappings. Used to validate
 * a requested package_size against what Bundle Portal actually sells before spending an API
 * call on a doomed place_order. Fails OPEN on any error (returns stale cache, or an empty
 * array as a last resort) — a cache outage must never block an order Bundle Portal's own
 * place_order validation would otherwise accept.
 */
export async function fetchBundlePortalBundles(network?: string): Promise<BundleEntry[]> {
    const now = Date.now()

    if (bundleCatalogCache.length > 0 && lastBundleFetch && now - lastBundleFetch < BUNDLE_CACHE_DURATION) {
        return network ? bundleCatalogCache.filter(b => b.network === network) : bundleCatalogCache
    }

    if (!BUNDLEPORTAL_API_KEY) return []

    try {
        // createServerClient() non-null-asserts its env vars and can throw on a misconfigured
        // environment — this MUST stay inside the try, not before it, or a throw here escapes
        // this function uncaught and rejects fulfillOrder's promise instead of returning the
        // failed-open response the docstring above promises.
        const { createServerClient } = await import('@/lib/supabase')
        const supabase = createServerClient()

        const { data: storedSettings } = await (supabase.from('admin_settings') as any)
            .select('value')
            .eq('key', BUNDLE_MAP_KEY)
            .maybeSingle()

        let storedMap: any = null
        if (storedSettings?.value) {
            storedMap = typeof storedSettings.value === 'string' ? JSON.parse(storedSettings.value) : storedSettings.value
        }

        if (storedMap?.bundles && storedMap?.fetched_at) {
            const fetchedAt = new Date(storedMap.fetched_at).getTime()
            if (now - fetchedAt < BUNDLE_CACHE_DURATION) {
                bundleCatalogCache = storedMap.bundles
                lastBundleFetch = fetchedAt
                return network ? bundleCatalogCache.filter(b => b.network === network) : bundleCatalogCache
            }
        }

        const { data } = await callBundlePortal('get_bundles')
        if (data?.success !== true || !Array.isArray(data.data?.bundles)) {
            if (storedMap?.bundles) {
                bundleCatalogCache = storedMap.bundles
                lastBundleFetch = now
                return network ? bundleCatalogCache.filter(b => b.network === network) : bundleCatalogCache
            }
            return bundleCatalogCache
        }

        const bundles: BundleEntry[] = data.data.bundles.map((b: any) => ({
            id: Number(b.id), network: String(b.network), size_gb: Number(b.size_gb), price: Number(b.price), validity: String(b.validity),
        }))

        bundleCatalogCache = bundles
        lastBundleFetch = now

        await (supabase.from('admin_settings') as any).upsert(
            { key: BUNDLE_MAP_KEY, value: { bundles, fetched_at: new Date().toISOString() } },
            { onConflict: 'key' }
        )

        return network ? bundles.filter(b => b.network === network) : bundles
    } catch (error) {
        console.error('[BundlePortal] Error in fetchBundlePortalBundles (failing open):', error)
        return network ? bundleCatalogCache.filter(b => b.network === network) : bundleCatalogCache
    }
}

/**
 * Fulfills multiple orders via concurrent single fulfillOrder calls. Bundle Portal has no
 * bulk endpoint, so this is the only path to dispatch many orders — unlike AgentPortal's
 * genuine 500-per-request bulk queue, every order here is its own place_order HTTP call.
 * Concurrency of 20 is a deliberate increase from the original 5 (2026-09-30, investigating
 * "Bundle Portal fulfillment is slow"): the v1-era published ceilings this used to cite (75
 * rps, 50 concurrent provider-bound orders) are no longer confirmed for v2
 * (docs/reference/bundleportal-developer-api.md), but the real backpressure signals
 * (429 / 503 order_capacity_busy, handled above without tripping the circuit breaker) already
 * protect against going too fast — so 20 stays comfortably under even the unconfirmed old
 * figures while being ~4x faster than before. Processes in chunks: all orders in a chunk
 * start simultaneously, the next chunk starts only after the current one fully resolves.
 */
export async function fulfillOrdersConcurrent(
    orders: OrderToFulfill[],
    concurrency = 20
): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []

    const results: BulkOrderResult[] = new Array(orders.length)

    for (let i = 0; i < orders.length; i += concurrency) {
        const chunk = orders.slice(i, i + concurrency)

        const settled = await Promise.allSettled(
            chunk.map(order => fulfillOrder(order.network, order.phone_number, order.size, order.id))
        )

        settled.forEach((outcome, j) => {
            const order = chunk[j]
            if (outcome.status === 'fulfilled') {
                const r = outcome.value
                results[i + j] = {
                    orderId: order.id,
                    success: r.success,
                    reference: r.reference,
                    transactionId: r.transactionId,
                    error: r.error,
                    apiResponse: r.apiResponse,
                    isRateLimited: r.isRateLimited,
                }
            } else {
                results[i + j] = {
                    orderId: order.id,
                    success: false,
                    error: outcome.reason?.message ?? 'Unexpected exception in Bundle Portal fulfillOrder',
                }
            }
        })
    }

    return results
}

// ─── Webhook Management (v2) ────────────────────────────────────────────────────
// Not called from the request-serving path — only from scripts/bundleportal-register-webhook.ts
// (a manually-run, one-off registration script) and any future admin tooling.

/**
 * Registers (or rotates, if one already exists) the webhook URL Bundle Portal delivers
 * order-outcome events to. The returned `webhookSecret` is shown ONCE and cannot be read
 * back — callers must store it immediately (env var, never DB/logs).
 */
export async function setBundlePortalWebhook(url: string): Promise<{
    success: boolean
    webhookUrl?: string
    webhookSecret?: string
    events?: string[]
    error?: string
}> {
    if (!BUNDLEPORTAL_API_KEY) return { success: false, error: 'Bundle Portal is not configured' }
    try {
        const { data } = await callBundlePortal('set_webhook', { webhook_url: url })
        if (data?.success !== true) {
            return { success: false, error: data?.message || data?.error || 'Failed to register webhook' }
        }
        return {
            success: true,
            webhookUrl: data.data?.webhook_url,
            webhookSecret: data.data?.webhook_secret,
            events: Array.isArray(data.data?.events) ? data.data.events : undefined,
        }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}

/** Returns the currently-registered webhook URL. Never returns the secret (Bundle Portal never re-sends it). */
export async function getBundlePortalWebhook(): Promise<{ success: boolean; webhookUrl?: string; error?: string }> {
    if (!BUNDLEPORTAL_API_KEY) return { success: false, error: 'Bundle Portal is not configured' }
    try {
        const { data } = await callBundlePortal('get_webhook')
        if (data?.success !== true) {
            return { success: false, error: data?.message || data?.error || 'Failed to fetch webhook' }
        }
        return { success: true, webhookUrl: data.data?.webhook_url }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}

/** Stops webhook delivery entirely. */
export async function deleteBundlePortalWebhook(): Promise<{ success: boolean; error?: string }> {
    if (!BUNDLEPORTAL_API_KEY) return { success: false, error: 'Bundle Portal is not configured' }
    try {
        const { data } = await callBundlePortal('delete_webhook')
        if (data?.success !== true) {
            return { success: false, error: data?.message || data?.error || 'Failed to delete webhook' }
        }
        return { success: true }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}
