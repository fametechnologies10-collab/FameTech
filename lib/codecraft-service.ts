import { createServerClient } from '@/lib/supabase'

// CodeCraft Fulfillment Service — Mirrors lib/fulfillment-service.ts architecture exactly
import type { OrderToFulfill, BulkOrderResult } from '@/lib/fulfillment-service'

const CODECRAFT_API_KEY = process.env.CODECRAFT_API_KEY || ''
const CODECRAFT_API_BASE_URL = 'https://api.codecraftnetwork.com/api'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
// Independent from DataKazina — same closed/open/half-open pattern
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

// Status codes CodeCraft uses for a deliberate per-order business decision, not a system
// error: 100 low balance, 101 out of stock, 102 agent not found, 103 price not found,
// 422 number not verified, 555 network not found. These arrive as either the HTTP status
// itself or the JSON body's `status` field depending on endpoint — never open the circuit
// for these, since CodeCraft is reachable and working correctly when it returns them.
const BUSINESS_REJECTION_CODES = new Set([100, 101, 102, 103, 422, 555])

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

// ─── Bundle Cache ─────────────────────────────────────────────────────────────
// Structure: { regular: { [network]: [{ gig: number, amount: string }] }, bigtime: { [network]: [...] } }
interface BundleEntry { gig: number; amount: string }
interface BundleMap {
    regular: Record<string, BundleEntry[]>
    bigtime: Record<string, BundleEntry[]>
}

let bundleMappingCache: BundleMap = { regular: {}, bigtime: {} }
let lastBundleFetch: number | null = null
const BUNDLE_CACHE_DURATION = 3600000 // 1 hour
const BUNDLE_MAP_KEY = 'codecraft_bundle_map'

// ─── STRICT Bundle Routing Rules ──────────────────────────────────────────────
// MTN 1–9 GB   → Regular → /initiate.php
// MTN 10–100 GB → BigTime → /special.php
// AT 1–15 GB   → Regular → /initiate.php
// AT 20+ GB    → BigTime → /special.php
// TELECEL all  → Regular → /initiate.php
function resolveEndpointAndType(
    network: string,
    gigVolume: number
): { endpoint: string; packageType: 'regular' | 'bigtime' } {
    const baseName = network.startsWith('AT') ? 'AT' : network

    if (baseName === 'MTN') {
        return { endpoint: `${CODECRAFT_API_BASE_URL}/initiate.php`, packageType: 'regular' }
    }

    if (baseName === 'AT') {
        if (gigVolume >= 20) return { endpoint: `${CODECRAFT_API_BASE_URL}/special.php`, packageType: 'bigtime' }
        return { endpoint: `${CODECRAFT_API_BASE_URL}/initiate.php`, packageType: 'regular' }
    }

    // TELECEL — always Regular
    return { endpoint: `${CODECRAFT_API_BASE_URL}/initiate.php`, packageType: 'regular' }
}

// Map internal network name to CodeCraft network string
function resolveNetworkName(network: string): string {
    if (network === 'AT-iShare' || network === 'AT-BigTime') return 'AT'
    if (network === 'Telecel') return 'TELECEL'
    return network // MTN passes through unchanged
}

// ─── Circuit Breaker Helpers ──────────────────────────────────────────────────
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
    return true // half-open allows one attempt
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
        console.log('[CodeCraft] Circuit breaker OPENED')
    }
}

// ─── Bundle Mapping Cache (Two-Tier: Memory + Supabase) ───────────────────────
/**
 * Fetch available packages from CodeCraft and cache in memory + Supabase.
 * Fallback to stale cache on failure. 1-hour TTL.
 */
export async function fetchAllBundleMappings(): Promise<BundleMap> {
    const now = Date.now()

    // 1. Memory Cache Check (fastest path — same container)
    const hasMemCache =
        Object.keys(bundleMappingCache.regular).length > 0 ||
        Object.keys(bundleMappingCache.bigtime).length > 0
    if (hasMemCache && lastBundleFetch && now - lastBundleFetch < BUNDLE_CACHE_DURATION) {
        return bundleMappingCache
    }

    const supabase = createServerClient()

    try {
        // 2. Persistent Cache Check (Supabase — cross-instance)
        const { data: storedSettings } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', BUNDLE_MAP_KEY)
            .maybeSingle()

        let storedMap: any = null
        if (storedSettings?.value) {
            try {
                storedMap = typeof storedSettings.value === 'string'
                    ? JSON.parse(storedSettings.value)
                    : storedSettings.value
            } catch (e) {
                console.error('[CodeCraft] Failed to parse stored bundle map')
            }
        }

        // Use stored map if fresh (< 1 hour)
        if (storedMap?.mappings && storedMap?.fetched_at) {
            const fetchedAt = new Date(storedMap.fetched_at).getTime()
            if (now - fetchedAt < BUNDLE_CACHE_DURATION) {
                console.log('[CodeCraft] Using fresh persistent cache from Supabase')
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = fetchedAt
                return bundleMappingCache
            }
        }

        // 3. API Fetch (slow path)
        console.log('[CodeCraft] Persistent cache stale or missing. Fetching from API...')
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/packages.php`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
        })

        // If API error, fallback to STALE persistent cache
        if (!response.ok) {
            console.warn(`[CodeCraft] API Error ${response.status}. Falling back to stale persistent cache.`)
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now // Temporarily treat as fresh to avoid tight loops
                return bundleMappingCache
            }
            throw new Error(`Failed to fetch packages and no cache available (Status: ${response.status})`)
        }

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[CodeCraft] Non-JSON response (HTTP ${response.status}) from /packages.php:`, rawText.slice(0, 300))
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now
                return bundleMappingCache
            }
            throw new Error(`Supplier returned unexpected response format (HTTP ${response.status})`)
        }

        // Build the new map from regular_packages and bigtime_packages arrays
        // { regular: { MTN: [{gig:1,amount:'4.50'}, ...], AT: [...] }, bigtime: {...} }
        const newMappings: BundleMap = { regular: {}, bigtime: {} }

        const regularPkgs: any[] = data?.data?.data?.regular_packages || data?.data?.regular_packages || []
        const bigtimePkgs: any[] = data?.data?.data?.bigtime_packages || data?.data?.bigtime_packages || []

        for (const pkg of regularPkgs) {
            if (!pkg.network || pkg.package === undefined) continue
            if (!newMappings.regular[pkg.network]) newMappings.regular[pkg.network] = []
            newMappings.regular[pkg.network].push({ gig: Number(pkg.package), amount: String(pkg.amount) })
        }

        for (const pkg of bigtimePkgs) {
            if (!pkg.network || pkg.package === undefined) continue
            if (!newMappings.bigtime[pkg.network]) newMappings.bigtime[pkg.network] = []
            newMappings.bigtime[pkg.network].push({ gig: Number(pkg.package), amount: String(pkg.amount) })
        }

        // 4. Update both caches
        bundleMappingCache = newMappings
        lastBundleFetch = now

        await (supabase.from('admin_settings') as any).upsert({
            key: BUNDLE_MAP_KEY,
            value: {
                mappings: newMappings,
                fetched_at: new Date().toISOString(),
            },
        }, { onConflict: 'key' })

        console.log('[CodeCraft] Persistent bundle cache updated successfully')
        return newMappings

    } catch (error) {
        console.error('[CodeCraft] Error in fetchAllBundleMappings:', error)
        return bundleMappingCache // Return whatever we have (may be empty on cold start)
    }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via CodeCraft API.
 * Mirrors the signature of fulfillment-service.ts fulfillOrder().
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    // Accepted for call-site parity with the other supplier services. CodeCraft's request
    // body sends no reference field at all (see requestBody below), so this is intentionally
    // inert — do not "fix" it later by wiring it into a request field.
    dispatchKey: string = orderId
): Promise<FulfillmentResponse> {

    if (!checkCircuit()) {
        console.warn(`[CodeCraft] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)' }
    }

    if (!CODECRAFT_API_KEY) {
        return { success: false, error: 'CodeCraft API key not configured' }
    }

    try {
        // ── Extract numeric GB volume from size string ──────────────────────
        const sizeMatch = dataSize.match(/[\d.]+/)
        if (!sizeMatch) {
            console.log(`[CodeCraft] Skip: Could not extract numeric volume from "${dataSize}"`)
            return { success: false, error: `Invalid data size format: ${dataSize}` }
        }

        const gigVolume = Number(sizeMatch[0])
        if (isNaN(gigVolume) || gigVolume <= 0) {
            return { success: false, error: `Invalid GB volume parsed from: ${dataSize}` }
        }

        // ── Strict Routing ──────────────────────────────────────────────────
        const { endpoint, packageType } = resolveEndpointAndType(network, gigVolume)
        const codecraftNetwork = resolveNetworkName(network)

        console.log(`[CodeCraft] Order ${orderId} | ${network} → ${codecraftNetwork} | ${gigVolume}GB | Type: ${packageType} | Endpoint: ${endpoint}`)

        // ── Bundle Map Validation ───────────────────────────────────────────
        const bundleMap = await fetchAllBundleMappings()
        const packageList = bundleMap[packageType][codecraftNetwork] || []

        const matchedBundle = packageList.find(b => b.gig === gigVolume)
        if (!matchedBundle) {
            const available = packageList.map(b => `${b.gig}GB`).join(', ') || 'none'
            console.log(`[CodeCraft] Skip: No ${packageType} ${gigVolume}GB package for ${codecraftNetwork}. Available: ${available}`)
            return { success: false, error: `No ${packageType} package found for ${gigVolume}GB on ${codecraftNetwork}` }
        }

        // ── Phone Normalization ─────────────────────────────────────────────
        let normalizedPhone = phoneNumber
        if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3)
        else if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone

        const requestBody = {
            recipient_number: normalizedPhone,
            gig: String(gigVolume),       // CodeCraft uses actual GB number directly
            network: codecraftNetwork,
        }

        console.log(`[CodeCraft] Request payload: network=${requestBody.network} gig=${requestBody.gig} recipient=***${normalizedPhone.slice(-4)}`)

        // ── HTTP Fetch with 3-retry logic ───────────────────────────────────
        let response: Response | null = null
        let attempt = 0
        const maxAttempts = 3
        let lastError: Error | null = null

        while (attempt < maxAttempts) {
            attempt++
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'x-api-key': CODECRAFT_API_KEY,
                    },
                    body: JSON.stringify(requestBody),
                })

                // Rate limiting — do not retry, return so caller can queue
                if (response.status === 429) {
                    console.warn(`[CodeCraft] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true }
                }

                break // Successful HTTP connection — handle response outside loop

            } catch (err: any) {
                lastError = err
                console.error(`[CodeCraft] Fetch error on attempt ${attempt}:`, err.message)
                if (attempt < maxAttempts) {
                    const delay = 2000 * attempt // 2s, 4s
                    console.log(`[CodeCraft] Retrying in ${delay}ms...`)
                    await new Promise(res => setTimeout(res, delay))
                }
            }
        }

        if (!response) {
            console.error(`[CodeCraft] All ${maxAttempts} fetch attempts failed for order ${orderId}.`)
            recordFailure()
            return { success: false, error: lastError?.message || 'Persistent network error connecting to CodeCraft' }
        }

        // ── Attempt JSON Parse ──────────────────────────────────────────────
        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[CodeCraft] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response format (HTTP ${response.status})` }
        }
        console.log(`[CodeCraft] Full API response (HTTP ${response.status}):`, JSON.stringify(data))

        // ── Resilient Success Detection ─────────────────────────────────────
        // CodeCraft may return status as number 200, string '200', or string 'success'
        // reference_id is always at top level — never nested
        // 100 = low balance, 101 = out of stock, 500 = system error,
        // 102 = agent not found, 103 = price not found, 555 = network not found
        // ALL non-success → keep order pending
        const isSuccess = response.ok &&
            (data.status === 200 || data.status === 'success' || data.status === '200') &&
            data.reference_id
        if (isSuccess) {
            recordSuccess()
            return {
                success: true,
                reference: data.reference_id,
                transactionId: data.reference_id,
                apiResponse: data,
            }
        }

        // Any failure: log reason code but NEVER mark order as failed
        const reasonCode = data.status
        const reasonMsg = data.message || 'Unknown error'
        console.warn(`[CodeCraft] Order ${orderId} not fulfilled. Code: ${reasonCode} — ${reasonMsg}. Order kept pending.`)

        // A business rejection (bad number, out of stock, low balance, etc.) means CodeCraft
        // is reachable and working correctly — it just declined this specific order. That must
        // not count toward the circuit breaker, or a run of routine rejections (e.g. several
        // unverified numbers in one refulfill batch) trips the breaker and blocks every other
        // order, verified numbers included. Only count it as a failure if CodeCraft returned
        // something outside this known set — that's a sign the integration itself is broken.
        if (!BUSINESS_REJECTION_CODES.has(Number(reasonCode))) {
            recordFailure()
        }

        return {
            success: false,
            error: `[${reasonCode}] ${reasonMsg}`,
            apiResponse: data,
        }

    } catch (error: any) {
        recordFailure()
        console.error(`[CodeCraft] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception' }
    }
}

// ─── Order Status Check ────────────────────────────────────────────────────────
/**
 * Check the status of an existing CodeCraft order.
 * response_regular.php / response_big_time.php were retired by CodeCraft (confirmed 404
 * live) — replaced by POST /response.php, which takes just reference_id (no regular/bigtime
 * split) and wants the API key in the JSON body as `agent_api`, not the x-api-key header.
 * Response shape: { status: "success", order_details: { order_status, ... } } on success,
 * { status: "error", message: "..." } for a business response (unknown reference, etc.) —
 * the latter means CodeCraft answered fine, it just has nothing to report, so it must not
 * open the circuit.
 */
export async function checkOrderStatus(referenceId: string): Promise<StatusResponse> {

    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable (circuit open)' }
    if (!CODECRAFT_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }

    try {
        // Auth for this endpoint is the `agent_api` body field, not the x-api-key header
        // every other CodeCraft endpoint uses — omit the header here so the key isn't
        // duplicated across two places in the outgoing request.
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/response.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ reference_id: referenceId, agent_api: CODECRAFT_API_KEY }),
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[CodeCraft Status] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, status: 'pending', message: `Unexpected response format (HTTP ${response.status})` }
        }

        if (response.ok && data.status === 'success') {
            recordSuccess()
            return {
                success: true,
                status: mapOrderStatus(data.order_details?.order_status),
                message: data.message,
                data: data.order_details,
            }
        }

        // A structured { status: "error" } business response means CodeCraft is reachable
        // and answered correctly — do not open the circuit over it (see fulfillOrder above
        // for the same principle applied to placement rejections).
        if (!(response.ok && data.status === 'error')) {
            recordFailure()
        }
        return { success: false, status: 'pending', message: data.message || 'Failed to check status' }

    } catch (error) {
        recordFailure()
        return { success: false, status: 'pending', message: 'Connection error during status check' }
    }
}

function mapOrderStatus(orderStatus: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const normalized = (orderStatus || '').trim().toLowerCase()
    const COMPLETED_STATUSES = ['delivered', 'success', 'completed', 'crediting successful', 'credited']
    const FAILED_STATUSES = ['failed', 'rejected', 'reversed', 'cancelled']
    if (COMPLETED_STATUSES.includes(normalized)) return 'completed'
    if (FAILED_STATUSES.includes(normalized)) return 'failed'
    return 'processing'
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live CodeCraft wallet balance.
 * Response: { status: 200, message: "Successful", data: { wallet: 10.00 } }
 * Success detection mirrors fulfillOrder — CodeCraft returns status as number 200,
 * string '200', or string 'success' depending on endpoint.
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    try {
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/wallet.php`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error('[CodeCraft Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Unexpected response format (HTTP ${response.status})` }
        }
        console.log('[CodeCraft Balance] API Response:', JSON.stringify(data))

        const isSuccess = response.ok &&
            (data.status === 200 || data.status === 'success' || data.status === '200')

        if (isSuccess) {
            // Never coerce a missing/unparseable wallet to 0 — a real 0 balance and a
            // shape change must not look the same to the admin panel.
            const wallet = data.data?.wallet ?? data.wallet
            if (wallet === undefined || wallet === null) {
                console.error('[CodeCraft Balance] Balance missing from response:', JSON.stringify(data))
                return { success: false, error: 'Balance missing from supplier response' }
            }
            const balance = parseFloat(wallet)
            if (Number.isNaN(balance)) {
                console.error('[CodeCraft Balance] Unparseable balance value:', JSON.stringify(wallet))
                return { success: false, error: `Unparseable balance value: ${JSON.stringify(wallet)}` }
            }
            return { success: true, balance, currency: 'GHS' }
        }

        return { success: false, error: data.message || data.error || 'Failed to fetch balance' }

    } catch (error: any) {
        console.error('[CodeCraft Balance] Error:', error)
        return { success: false, error: error.message }
    }
}

/**
 * Fulfill multiple orders via CodeCraft by running concurrent single fulfillOrder calls.
 * CodeCraft has no bulk endpoint — concurrency of 5 is safe and avoids rate limiting.
 * Processes orders in chunks: all orders in a chunk start simultaneously, the next
 * chunk starts only after the current chunk fully resolves.
 */
export async function fulfillOrdersConcurrent(
    orders: OrderToFulfill[],
    concurrency = 5
): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []

    const results: BulkOrderResult[] = new Array(orders.length)

    for (let i = 0; i < orders.length; i += concurrency) {
        const chunk = orders.slice(i, i + concurrency)

        const settled = await Promise.allSettled(
            chunk.map(order =>
                fulfillOrder(order.network, order.phone_number, order.size, order.id)
            )
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
                    error: outcome.reason?.message ?? 'Unexpected exception in CodeCraft fulfillOrder',
                }
            }
        })
    }

    return results
}
