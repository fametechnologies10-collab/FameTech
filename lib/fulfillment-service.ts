import { createServerClient } from '@/lib/supabase'
import { buildDataPackageRequestBody, resolveDataKazinaNetworkId, isDuplicateReferenceRejection } from '@/lib/datakazina-request'

// Universal Fulfillment Service with DataKazina API Integration

const DATAKAZINA_API_KEY = process.env.DATAKAZINA_API_KEY || ''
const DATAKAZINA_API_BASE_URL = process.env.DATAKAZINA_API_BASE_URL || 'https://reseller.dakazinabusinessconsult.com/api/v1'

// Circuit breaker state
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    // Set when DataKazina rejected the placement as a DUPLICATE incoming_api_ref — see
    // isDuplicateReferenceRejection below. Semantically identical to the flag
    // lib/hendylinks-service.ts and lib/agentportal-service.ts set: the supplier may
    // already have accepted, charged and delivered this order, so callers must NOT revert
    // it to 'pending' and re-dispatch. Read by lib/fulfillment-trigger.ts and step 11 of
    // lib/refulfillment-service.ts.
    ambiguous?: boolean
    // DataKazina's OWN order identifier ("ORDER-1066677" / "BULK-6A84DB55E13DE"). Persisted
    // to orders.dakazina_order_code so their webhook can be matched on it when it quotes
    // their code instead of our reference.
    supplierOrderCode?: string
    // The exact incoming_api_ref put on the wire for this dispatch (order id, plus a
    // "-r<retry_count>" suffix on a deliberate retry). Persisted to orders.dakazina_reference.
    sentApiRef?: string
}

export interface OrderToFulfill {
    id: string
    phone_number: string
    network: string
    size: string
    shop_order_id: string | null
    reference_code: string
    price: number
    // orders.retry_count. Optional so existing constructors of this shape keep compiling;
    // absent is treated as 0, which reproduces the original DataKazina reference exactly.
    // Only DataKazina reads it today (to build a retry-unique incoming_api_ref) — every
    // other supplier ignores it.
    retry_count?: number | null
}

export interface BulkOrderResult {
    orderId: string
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    // Mirrors FulfillmentResponse.ambiguous — see the comment there. Declared on the shared
    // bulk-result shape so step 11 of lib/refulfillment-service.ts can read it without a
    // cast for DataKazina, the way it already does for AgentPortal/HendyLinks.
    ambiguous?: boolean
    // Mirror FulfillmentResponse — the bulk path must persist both identifiers too.
    supplierOrderCode?: string
    sentApiRef?: string
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

// DataKazina network IDs
const NETWORK_IDS: Record<string, number> = {
    'MTN': 3,
    'Telecel': 2,
    'AT-iShare': 1,
    'AT-BigTime': 4,
}

// Cache for bundle mappings (will be populated from API or Supabase)
// Structure: { [networkId]: { [volume]: packageId } }
let bundleMappingCache: Record<number, Record<string, number>> = {}
let lastBundleFetch: number | null = null
const BUNDLE_CACHE_DURATION = 3600000 // 1 hour

// Express-flag cache — avoids a DB read per order during bulk/refulfill runs.
// TTL is per-container instance: after an admin flip, warm containers may lag up
// to ~60s before they re-read, while fresh cold starts pick up the change at once.
let mtnExpressCache: { value: boolean; at: number } | null = null
const EXPRESS_CACHE_DURATION = 60000 // 60s per container instance

/**
 * Read the admin switch for MTN express delivery. Cached 60s per container.
 *
 * Uses the service-role client (same as fetchAllBundleMappings above) on purpose:
 * the fulfillment hot path runs from webhooks/cron with NO user session, and
 * admin_settings is RLS-restricted to admins — an anon/RLS client would read null
 * here and silently disable express even when an admin enabled it.
 *
 * admin_settings.value is JSONB storing a JSON string ("true"/"false"), matching
 * the existing kill-switches' coerceBool write + '"false"'::jsonb seed, so accept
 * both the string 'true' and a native boolean true. On any error, fall back to the
 * last-known value, else false (normal delivery) — fail-closed.
 */
export async function isMtnExpressEnabled(): Promise<boolean> {
    const now = Date.now()
    if (mtnExpressCache && (now - mtnExpressCache.at) < EXPRESS_CACHE_DURATION) {
        return mtnExpressCache.value
    }
    try {
        const supabase = createServerClient()
        const { data } = await (supabase.from('admin_settings') as any)
            .select('value')
            .eq('key', 'mtn_express_delivery_enabled')
            .maybeSingle()
        const enabled = data?.value === true || data?.value === 'true'
        mtnExpressCache = { value: enabled, at: now }
        return enabled
    } catch (e) {
        console.error('[DataKazina] Failed to read mtn_express_delivery_enabled:', e)
        return mtnExpressCache?.value ?? false
    }
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
        console.log('[DataKazina] Circuit breaker opened')
    }
}

/**
 * Fetch available data packages from DataKazina and build bundle mapping for all networks.
 * Uses Supabase as a persistent shared cache to prevent 429s during cold starts.
 */
export async function fetchAllBundleMappings(): Promise<Record<number, Record<string, number>>> {
    const now = Date.now()
    const BUNDLE_MAP_KEY = 'datakazina_bundle_map'

    // 1. Memory Cache Check (Fastest Path - same container)
    if (Object.keys(bundleMappingCache).length > 0 && lastBundleFetch && (now - lastBundleFetch) < BUNDLE_CACHE_DURATION) {
        return bundleMappingCache
    }

    const supabase = createServerClient()

    try {
        // 2. Persistent Cache Check (Supabase - cross-instance)
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
                console.error('[DataKazina] Failed to parse stored bundle map')
            }
        }

        // Use stored map if fresh (< 1 hour)
        if (storedMap?.mappings && storedMap?.fetched_at) {
            const fetchedAt = new Date(storedMap.fetched_at).getTime()
            if (now - fetchedAt < BUNDLE_CACHE_DURATION) {
                console.log('[DataKazina] Using fresh persistent cache from Supabase')
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = fetchedAt
                return bundleMappingCache
            }
        }

        // 3. API Fetch (Slow Path)
        console.log('[DataKazina] Persistent cache stale or missing. Fetching from API...')
        const response = await fetch(`${DATAKAZINA_API_BASE_URL}/fetch-data-packages`, {
            method: 'GET',
            headers: { 'x-api-key': DATAKAZINA_API_KEY },
        })

        // If 429 or other API error, fallback to STALE persistent cache
        if (!response.ok) {
            console.warn(`[DataKazina] API Error ${response.status}. Falling back to stale persistent cache.`)
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now // Temporarily treat as fresh to prevent immediate loops
                return bundleMappingCache
            }
            throw new Error(`Failed to fetch packages and no cache available (Status: ${response.status})`)
        }

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[DataKazina] Non-JSON response (HTTP ${response.status}) from fetch-data-packages.`)
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now
                return bundleMappingCache
            }
            throw new Error(`Supplier returned unexpected response format (HTTP ${response.status})`)
        }

        const data = await response.json()
        const newMappings: Record<number, Record<string, number>> = {}

        if (Array.isArray(data)) {
            data.forEach((pkg: any) => {
                if (!newMappings[pkg.network_id]) newMappings[pkg.network_id] = {}
                newMappings[pkg.network_id][pkg.volumeGB] = pkg.id
            })
        }

        // 4. Update Both Caches
        bundleMappingCache = newMappings
        lastBundleFetch = now

        await (supabase.from('admin_settings') as any).upsert({
            key: BUNDLE_MAP_KEY,
            value: {
                mappings: newMappings,
                fetched_at: new Date().toISOString()
            }
        }, { onConflict: 'key' })

        console.log('[DataKazina] Persistent bundle cache updated successfully')
        return newMappings
    } catch (error) {
        console.error('[DataKazina] Error in fetchAllBundleMappings:', error)
        return bundleMappingCache
    }
}

/**
 * Main fulfillment function for any network
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    // Accepted for call-site parity with the other supplier services but intentionally
    // unused here — buildDataPackageRequestBody() derives incoming_api_ref from orderId +
    // attemptNo, not dispatchKey. See lib/datakazina-request.ts for why.
    dispatchKey: string = orderId,
    // orders.retry_count at dispatch time. Makes an admin retry of a FAILED order send a new
    // incoming_api_ref so DataKazina no longer rejects it as a duplicate, while leaving cron
    // re-dispatch (which never touches retry_count) on the same reference and therefore still
    // protected by their duplicate guard. See buildIncomingApiRef. Defaults to 0 = old shape.
    attemptNo: number = 0
): Promise<FulfillmentResponse> {
    // const { isPhoneFlagged } = await import('@/lib/security')
    // if (isPhoneFlagged(phoneNumber)) {
    //     console.warn(`[Fulfillment Security] Blocked fulfillment for flagged phone: ${phoneNumber}`)
    //     return { success: false, error: 'Security block: Suspicious activity detected' }
    // }

    if (!checkCircuit()) return { success: false, error: 'Service temporarily unavailable' }
    if (!DATAKAZINA_API_KEY) return { success: false, error: 'API key not configured' }

    try {
        const mappings = await fetchAllBundleMappings()
        const normalNetworkId = NETWORK_IDS[network]

        if (!normalNetworkId) {
            console.log(`[DataKazina] Skip: Unsupported network ${network}`)
            return { success: false, error: `Unsupported network: ${network}` }
        }

        // MTN Express routes via the express product line (network_id 6) instead of
        // the normal MTN lane (3). It carries a SUBSET of volumes — if the ordered
        // size isn't offered there, validation below fails and the order stays
        // pending (admin-chosen behavior), never silently delivered as normal.
        const expressEnabled = await isMtnExpressEnabled()
        const networkId = resolveDataKazinaNetworkId(network, normalNetworkId, expressEnabled)
        const usingExpress = networkId !== normalNetworkId

        const networkMappings = mappings[networkId]
        if (!networkMappings) {
            console.log(`[DataKazina] Skip: No mappings found for network ${network} (ID: ${networkId}${usingExpress ? ', express' : ''})`)
            return {
                success: false,
                error: usingExpress
                    ? `MTN Express lane (network_id ${networkId}) has no package catalog`
                    : `No packages found for network: ${network}`,
            }
        }

        // --- SIZE NORMALIZATION ---
        // Try exact match first, then normalized numeric match
        let bundleId = networkMappings[dataSize]

        if (!bundleId) {
            const numericSize = dataSize.replace(/[^0-9]/g, '')
            bundleId = networkMappings[numericSize] || networkMappings[numericSize + 'GB'] || networkMappings[numericSize + ' GB']

            if (bundleId) {
                console.log(`[DataKazina] Normalized size "${dataSize}" to "${numericSize}" (Found ID: ${bundleId})`)
            }
        }

        if (!bundleId) {
            console.log(`[DataKazina] Skip: Unsupported size "${dataSize}" for ${network}${usingExpress ? ' (express lane)' : ''}. Available: ${Object.keys(networkMappings).join(', ')}`)
            return {
                success: false,
                error: usingExpress
                    ? `MTN Express: ${dataSize} is not offered on the express lane (network_id ${networkId}) — order kept pending.`
                    : `Unsupported data size: ${dataSize} for ${network}.`,
            }
        }

        // Extract volume value to send as the actual shared_bundle (as requested by supplier)
        const sizeMatch = dataSize.match(/[\d.]+/)
        const volumeValue = sizeMatch ? sizeMatch[0] : null

        if (!volumeValue || isNaN(Number(volumeValue))) {
            console.log(`[DataKazina] Skip: Could not extract numeric volume from "${dataSize}"`)
            return { success: false, error: `Invalid data size format: ${dataSize}. Number expected.` }
        }

        const volumeNumber = Number(volumeValue)

        console.log(`[DataKazina] Fulfillment Start: Order ${orderId} | Network: ${network} (${networkId}${usingExpress ? ' EXPRESS' : ''}) | Package: ${dataSize} (ID: ${bundleId}, Vol: ${volumeNumber})`)
        // ---------------------------

        // Normalize phone number
        let normalizedPhone = phoneNumber
        if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3)
        else if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone

        const deliveryMode = usingExpress ? 'express' : 'normal'
        const requestBody = buildDataPackageRequestBody({
            normalizedPhone,
            networkId,
            volumeNumber,
            orderId,
            attemptNo,
        })
        // The exact reference we put on the wire. Persisted by callers into
        // orders.dakazina_reference so the webhook can match on it — see the success return
        // below, which no longer falls back to the bare orderId (that would silently drop the
        // "-r<n>" retry suffix and leave a retried order unmatchable).
        const sentApiRef = String(requestBody.incoming_api_ref)

        console.log(`[DataKazina] Delivery mode: ${deliveryMode} | Request payload:`, JSON.stringify(requestBody))

        let response: Response | null = null;
        let attempt = 0;
        const maxAttempts = 3;
        let lastError: Error | null = null;

        while (attempt < maxAttempts) {
            attempt++;
            try {
                response = await fetch(`${DATAKAZINA_API_BASE_URL}/buy-data-package`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'x-api-key': DATAKAZINA_API_KEY,
                    },
                    body: JSON.stringify(requestBody),
                });

                // Handle WAF 429 Too Many Requests (Cloudflare/Nginx limits)
                if (response.status === 429) {
                    console.warn(`[DataKazina Fulfillment] Rate limited (HTTP 429). Queueing order...`);
                    // IMPORTANT: Do not retry here. Immediately return so the caller can queue it asynchronously.
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true };
                }

                // If we get here and it's not a 429, we break out of the retry loop.
                // We'll handle the response (success or failure) outside the loop.
                break;

            } catch (err: any) {
                lastError = err;
                console.error(`[DataKazina Fulfillment] Network/Fetch error on attempt ${attempt}:`, err.message);

                if (attempt < maxAttempts) {
                    // Wait a bit before retrying network failures
                    const delay = 2000 * attempt; // Exponential-ish backoff: 2s, 4s
                    console.log(`[DataKazina Fulfillment] Retrying in ${delay}ms...`);
                    await new Promise(res => setTimeout(res, delay));
                }
            }
        }

        if (!response) {
            // All attempts failed due to network errors
            console.error(`[DataKazina Fulfillment] All ${maxAttempts} fetch attempts failed.`);
            recordFailure();
            return { success: false, error: lastError?.message || 'Persistent network error connecting to supplier' };
        }

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error(`[DataKazina Fulfillment] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log(`[DataKazina] Full API response (HTTP ${response.status}):`, JSON.stringify(data))

        // Ensure we catch false positives where success is true but it's an error message
        const isFalsePositive = data.success && data.message &&
            (data.message.toLowerCase().includes('not available') ||
                data.message.toLowerCase().includes('failed') ||
                data.message.toLowerCase().includes('error'))

        if (response.ok && data.success && !isFalsePositive) {
            recordSuccess()
            const responseData = Array.isArray(data.data) ? data.data[0] : data.data
            // DataKazina's own identifier for this order (their "ORDER-1066677" / "BULK-..."
            // code). Stored ALONGSIDE our reference — not instead of it — because their
            // webhook may quote either one, and we cannot control which. See
            // app/api/webhooks/dakazina/route.ts, which now matches on either.
            const supplierOrderCode = responseData?.order_code
                ?? responseData?.orderCode
                ?? responseData?.order_id
                ?? null
            return {
                success: true,
                // Fall back to the reference we ACTUALLY SENT, never the bare orderId — on a
                // retry those differ, and using orderId here would persist a reference that
                // was never on the wire, so the webhook could never match it.
                reference: responseData?.reference || sentApiRef,
                transactionId: responseData?.transaction_code || responseData?.transaction_id,
                supplierOrderCode: supplierOrderCode ? String(supplierOrderCode) : undefined,
                sentApiRef,
                apiResponse: { ...data, delivery_mode: deliveryMode },
            }
        }

        // ── Duplicate incoming_api_ref ────────────────────────────────────────────
        // DataKazina already holds an order under this exact reference, which (because
        // buildDataPackageRequestBody always sends the plain order id) means THIS order was
        // already submitted to them at some point — and may already have been delivered and
        // charged. Confirmed live 2026-08-20 on an order whose tracking history showed a
        // successful DataKazina dispatch days earlier; the duplicate guard was the only thing
        // standing between it and a second delivery.
        //
        // Two things must NOT happen here, both of which the generic failure path below did:
        //   1. recordFailure() — this is a correct business answer, not instability. These
        //      rejections repeat every cron run for as long as the order stays pending, so
        //      counting them was enough on its own to open the breaker and fast-fail every
        //      UNRELATED DataKazina order (the "Service temporarily unavailable" storms in
        //      mtn_fulfillment_tracking are this).
        //   2. a plain `success:false` — that reverts the order to 'pending', so the next cron
        //      run re-dispatches it forever, and (worse) leaves it eligible to be routed to a
        //      DIFFERENT supplier by the fallback engine, which knows nothing about
        //      DataKazina's reference and WILL deliver it a second time.
        // `ambiguous: true` is the existing codebase contract for exactly this ("may already
        // be accepted/charged — do not revert, do not retry, alert a human"), so callers in
        // lib/fulfillment-trigger.ts and step 11 of lib/refulfillment-service.ts already
        // handle it correctly with no change needed there.
        if (isDuplicateReferenceRejection(response.status, data)) {
            console.error(`[DataKazina] DUPLICATE-REFERENCE: order ${orderId} was already submitted to DataKazina under this reference — it may already have been delivered and charged. NOT retry-eligible, NOT breaker-worthy; left for manual reconciliation.`)
            return {
                success: false,
                ambiguous: true,
                error: `Already submitted to DataKazina under this order reference (duplicate) — the earlier submission may already have been delivered. Reconcile manually before retrying.`,
                // Deliberately NO delivery_mode/_httpStatus-style rejection marker that any
                // fallback classifier keys off — an ambiguous order must never be routed to a
                // second supplier.
                apiResponse: { ...data, duplicate_reference: true },
            }
        }

        recordFailure()
        return {
            success: false,
            error: data.message || data.error || 'Fulfillment failed',
            apiResponse: { ...data, delivery_mode: deliveryMode },
        }
    } catch (error: any) {
        recordFailure()
        return { success: false, error: error.message || 'Connection error' }
    }
}

export async function checkOrderStatus(transactionId: string): Promise<StatusResponse> {
    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable' }
    if (!DATAKAZINA_API_KEY) return { success: false, status: 'pending', message: 'API not configured' }

    try {
        const response = await fetch(`${DATAKAZINA_API_BASE_URL}/fetch-single-transaction`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': DATAKAZINA_API_KEY,
            },
            body: JSON.stringify({ transaction_id: transactionId }),
        })

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[DataKazina Status] Non-JSON response (HTTP ${response.status})`)
            recordFailure()
            return { success: false, status: 'pending', message: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()

        if (response.ok && data.success) {
            recordSuccess()
            return {
                success: true,
                status: mapStatus(data.data?.status),
                message: data.message,
                data: data.data,
            }
        }

        recordFailure()
        return { success: false, status: 'pending', message: data.message || 'Failed to check status' }
    } catch (error) {
        recordFailure()
        return { success: false, status: 'pending', message: 'Connection error' }
    }
}

function mapStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const s = (status || '').toLowerCase()
    if (['success', 'completed', 'delivered'].includes(s)) return 'completed'
    if (['failed', 'error', 'rejected'].includes(s)) return 'failed'
    return 'processing'
}

export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    try {
        // Note: API key is required even though the docs example shows empty headers
        const response = await fetch(`${DATAKAZINA_API_BASE_URL}/check-console-balance`, {
            method: 'GET',
            headers: { 'x-api-key': DATAKAZINA_API_KEY },
        })

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error('[DataKazina Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log('[DataKazina Balance] API Response:', JSON.stringify(data))

        if (response.ok) {
            let balance = 0
            let currency = 'GHS'

            // DataKazina actual response: { "Wallet Balance": "444.10", ... }
            if (data['Wallet Balance'] !== undefined) {
                balance = parseFloat(data['Wallet Balance']) || 0
            }
            // Structure 1: { success: true, data: { balance, currency } }
            else if (data.data?.balance !== undefined) {
                balance = parseFloat(data.data.balance) || 0
                currency = data.data.currency || 'GHS'
            }
            // Structure 2: { balance, currency } directly
            else if (data.balance !== undefined) {
                balance = parseFloat(data.balance) || 0
                currency = data.currency || 'GHS'
            }
            // Structure 3: { data: balance_value }
            else if (typeof data.data === 'number') {
                balance = parseFloat(data.data) || 0
            }

            return { success: true, balance, currency }
        }

        return { success: false, error: data.message || data.error || 'Failed to fetch balance' }
    } catch (error: any) {
        console.error('[DataKazina Balance] Error:', error)
        return { success: false, error: error.message }
    }
}

/**
 * Fulfill multiple DataKazina orders concurrently using the single /buy-data-package endpoint.
 * The bulk /buy-bulk-data-packages endpoint is not available; this mirrors the CodeCraft
 * concurrent pattern — 5 orders at a time — while keeping the same BulkOrderResult interface
 * so refulfillment-service.ts needs no changes.
 */
// `orders[].retry_count` is threaded into each dispatch as attemptNo so a deliberate retry
// gets a fresh incoming_api_ref — see buildIncomingApiRef in lib/datakazina-request.ts. It is
// optional on OrderToFulfill and absent means 0, i.e. the pre-existing reference shape.
export async function fulfillOrdersBulk(orders: OrderToFulfill[], concurrency = 5): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []

    console.log(`[DataKazina Bulk] Dispatching ${orders.length} order(s) via single endpoint (concurrency=${concurrency})`)

    const results: BulkOrderResult[] = new Array(orders.length)

    for (let i = 0; i < orders.length; i += concurrency) {
        const chunk = orders.slice(i, i + concurrency)
        const settled = await Promise.allSettled(
            chunk.map(order => fulfillOrder(order.network, order.phone_number, order.size, order.id, order.id, order.retry_count ?? 0))
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
                    // MUST be forwarded — a duplicate-reference rejection surfaces here, and
                    // dropping the flag would let step 11 of lib/refulfillment-service.ts
                    // revert an already-submitted order to 'pending' and re-dispatch it.
                    ambiguous: r.ambiguous,
                    supplierOrderCode: r.supplierOrderCode,
                    sentApiRef: r.sentApiRef,
                }
            } else {
                results[i + j] = {
                    orderId: order.id,
                    success: false,
                    error: outcome.reason?.message ?? 'Unexpected exception in DataKazina fulfillOrder',
                }
            }
        })
    }

    return results
}
