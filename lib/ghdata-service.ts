import { createServerClient } from '@/lib/supabase'

const GHDATA_API_KEY = process.env.GHDATA_API_KEY || ''
const GHDATA_API_BASE_URL = process.env.GHDATA_API_BASE_URL || 'https://eazyghdata.com/api/agent/v1'

// ── Circuit Breaker ──────────────────────────────────────────────────────────
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
    return true // half-open
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (failureCount >= FAILURE_THRESHOLD || circuitState === 'half-open') {
        circuitState = 'open'
        console.log('[GhData] Circuit breaker opened')
    }
}

// ── Shared Response Types ────────────────────────────────────────────────────
export interface GhDataFulfillmentResponse {
    success: boolean
    ghdataOrderId?: string
    ghdataShortId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
}

export interface GhDataStatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

export interface OrderToFulfill {
    id: string
    phone_number: string
    network: string
    size: string
    shop_order_id: string | null
    reference_code: string
    price: number
}

export interface BulkOrderResult {
    orderId: string
    success: boolean
    ghdataOrderId?: string
    ghdataShortId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
}

// ── Package Cache ────────────────────────────────────────────────────────────
let packageCache: Record<string, Record<string, string>> = {}
let lastPackageFetch: number | null = null
const PACKAGE_CACHE_DURATION = 3600000
const PACKAGE_CACHE_KEY = 'ghdata_package_map'

export async function fetchGhDataPackages(): Promise<Record<string, Record<string, string>>> {
    const now = Date.now()

    if (Object.keys(packageCache).length > 0 && lastPackageFetch && (now - lastPackageFetch) < PACKAGE_CACHE_DURATION) {
        return packageCache
    }

    const supabase = createServerClient()

    try {
        const { data: storedSettings } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', PACKAGE_CACHE_KEY)
            .maybeSingle()

        let storedMap: any = null
        if (storedSettings?.value) {
            try {
                storedMap = typeof storedSettings.value === 'string'
                    ? JSON.parse(storedSettings.value)
                    : storedSettings.value
            } catch (e) {
                console.error('[GhData] Failed to parse stored package map')
            }
        }

        if (storedMap?.mappings && storedMap?.fetched_at) {
            const fetchedAt = new Date(storedMap.fetched_at).getTime()
            if (now - fetchedAt < PACKAGE_CACHE_DURATION) {
                console.log('[GhData] Using fresh persistent cache from Supabase')
                packageCache = storedMap.mappings
                lastPackageFetch = fetchedAt
                return packageCache
            }
        }

        console.log('[GhData] Persistent cache stale or missing. Fetching packages from API...')
        const response = await fetch(`${GHDATA_API_BASE_URL}/packages`, {
            method: 'GET',
            headers: { 'X-API-Key': GHDATA_API_KEY },
        })

        if (!response.ok) {
            console.warn(`[GhData] Package API Error ${response.status}. Falling back to stale cache.`)
            if (storedMap?.mappings) {
                packageCache = storedMap.mappings
                lastPackageFetch = now
                return packageCache
            }
            throw new Error(`Failed to fetch packages (Status: ${response.status})`)
        }

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[GhData] Non-JSON response (HTTP ${response.status})`)
            if (storedMap?.mappings) {
                packageCache = storedMap.mappings
                lastPackageFetch = now
                return packageCache
            }
            throw new Error(`GhData returned unexpected response format (HTTP ${response.status})`)
        }

        const data = await response.json()
        const newMappings: Record<string, Record<string, string>> = {}

        if (Array.isArray(data.packages)) {
            for (const pkg of data.packages) {
                if (!pkg.network || !pkg.name || !pkg.id) continue
                if (!newMappings[pkg.network]) newMappings[pkg.network] = {}
                newMappings[pkg.network][String(pkg.name)] = String(pkg.id)
            }
        }

        packageCache = newMappings
        lastPackageFetch = now

        await (supabase.from('admin_settings') as any).upsert({
            key: PACKAGE_CACHE_KEY,
            value: { mappings: newMappings, fetched_at: new Date().toISOString() }
        }, { onConflict: 'key' })

        console.log('[GhData] Package cache updated successfully')
        return newMappings
    } catch (error) {
        console.error('[GhData] Error in fetchGhDataPackages:', error)
        return packageCache
    }
}

function resolvePackageName(dataSize: string): string | null {
    const match = dataSize.match(/[\d.]+/)
    if (!match) return null
    const num = parseFloat(match[0])
    if (isNaN(num)) return null
    return Number.isInteger(num) ? String(num) : String(Math.round(num))
}

function normalizePhone(phone: string): string {
    if (phone.startsWith('233')) return '0' + phone.slice(3)
    if (!phone.startsWith('0')) return '0' + phone
    return phone
}

// ── Single Order Fulfillment ─────────────────────────────────────────────────
export async function fulfillGhDataOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    dispatchKey: string = orderId
): Promise<GhDataFulfillmentResponse> {
    if (!checkCircuit()) return { success: false, error: 'GhData service temporarily unavailable (circuit open)' }
    if (!GHDATA_API_KEY) return { success: false, error: 'GHDATA_API_KEY not configured' }

    try {
        const packageName = resolvePackageName(dataSize)
        if (!packageName) {
            return { success: false, error: `Invalid data size format: ${dataSize}` }
        }

        const normalizedPhone = normalizePhone(phoneNumber)

        const packages = await fetchGhDataPackages()
        const packageId = packages[network]?.[packageName]

        const requestBody: Record<string, string> = packageId
            ? { package_id: packageId, phone_number: normalizedPhone }
            : { package_name: packageName, network, phone_number: normalizedPhone }

        console.log(`[GhData] Order ${orderId} | Network: ${network} | Size: ${dataSize} (name: ${packageName}) | Phone: ${normalizedPhone} | Using ${packageId ? 'package_id' : 'package_name+network'}`)

        const response = await fetch(`${GHDATA_API_BASE_URL}/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': GHDATA_API_KEY,
                'Idempotency-Key': dispatchKey,
            },
            body: JSON.stringify(requestBody),
        })

        if (response.status === 429) {
            console.warn(`[GhData] Rate limited (HTTP 429) for order ${orderId}`)
            return { success: false, error: 'GhData Rate Limited (429)', isRateLimited: true }
        }

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error(`[GhData] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `GhData returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log(`[GhData] Full API response (HTTP ${response.status}):`, JSON.stringify(data))

        if (response.ok && data.success) {
            recordSuccess()
            return {
                success: true,
                ghdataOrderId: data.order_id,
                ghdataShortId: data.short_id,
                apiResponse: data,
            }
        }

        recordFailure()
        return {
            success: false,
            error: data.error || data.message || 'GhData fulfillment failed',
            apiResponse: data,
        }
    } catch (error: any) {
        recordFailure()
        return { success: false, error: error.message || 'Connection error to GhData' }
    }
}

// ── Sequential Single-Order Fulfillment (used by refulfillment cron) ─────────
// GhData bulk endpoint does not process orders faster — each order uses the
// single /order endpoint so the supplier can track and deliver them individually.
export async function fulfillGhDataOrdersSequential(orders: OrderToFulfill[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []
    const results: BulkOrderResult[] = []
    for (const order of orders) {
        const r = await fulfillGhDataOrder(order.network, order.phone_number, order.size, order.id)
        results.push({
            orderId: order.id,
            success: r.success,
            ghdataOrderId: r.ghdataOrderId,
            ghdataShortId: r.ghdataShortId,
            error: r.error,
            apiResponse: r.apiResponse,
            isRateLimited: r.isRateLimited,
        })
    }
    return results
}

// ── Native Bulk Order Fulfillment ─────────────────────────────────────────────
export async function fulfillGhDataOrdersBulk(orders: OrderToFulfill[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []
    if (!GHDATA_API_KEY) {
        return orders.map(o => ({ orderId: o.id, success: false, error: 'GHDATA_API_KEY not configured' }))
    }
    if (!checkCircuit()) {
        return orders.map(o => ({ orderId: o.id, success: false, error: 'GhData service temporarily unavailable (circuit open)' }))
    }

    const CHUNK_SIZE = 500
    const allResults: BulkOrderResult[] = []

    for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
        const chunk = orders.slice(i, i + CHUNK_SIZE)

        // Resolve package cache once per chunk — same lookup as single-order path
        const packages = await fetchGhDataPackages()

        const validOrders: typeof chunk = []
        for (const order of chunk) {
            const packageName = resolvePackageName(order.size)
            if (!packageName) {
                allResults.push({ orderId: order.id, success: false, error: `Invalid data size format: ${order.size}` })
            } else {
                validOrders.push(order)
            }
        }

        if (validOrders.length === 0) continue

        // GhData bulk API only accepts package_id — no package_name fallback
        const payloadOrders: { package_id: string; phone_number: string; _orderId: string }[] = []
        for (const order of validOrders) {
            const packageName = resolvePackageName(order.size)!
            const packageId = packages[order.network]?.[packageName]
            if (!packageId) {
                allResults.push({ orderId: order.id, success: false, error: `No package_id found for ${order.network} ${order.size} — refresh package cache` })
            } else {
                payloadOrders.push({ package_id: packageId, phone_number: normalizePhone(order.phone_number), _orderId: order.id })
            }
        }

        if (payloadOrders.length === 0) continue

        const bulkPayload = payloadOrders.map(({ package_id, phone_number }) => ({ package_id, phone_number }))

        console.log(`[GhData Bulk] Sending ${validOrders.length} orders to /bulk-order`)

        try {
            const response = await fetch(`${GHDATA_API_BASE_URL}/bulk-order`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': GHDATA_API_KEY,
                },
                body: JSON.stringify({ orders: bulkPayload }),
            })

            if (response.status === 429) {
                console.warn(`[GhData Bulk] Rate limited (HTTP 429)`)
                payloadOrders.forEach(o => allResults.push({ orderId: o._orderId, success: false, error: 'GhData Rate Limited (429)', isRateLimited: true }))
                continue
            }

            const contentType = response.headers.get('content-type') || ''
            if (!contentType.includes('application/json')) {
                const rawText = await response.text()
                console.error(`[GhData Bulk] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
                recordFailure()
                payloadOrders.forEach(o => allResults.push({ orderId: o._orderId, success: false, error: `GhData returned unexpected response (HTTP ${response.status})` }))
                continue
            }

            const data = await response.json()
            console.log(`[GhData Bulk] Response:`, JSON.stringify(data).slice(0, 500))

            if (!response.ok || !data.success) {
                recordFailure()
                const errMsg = data.error || data.message || 'GhData bulk order failed'
                payloadOrders.forEach(o => allResults.push({ orderId: o._orderId, success: false, error: errMsg, apiResponse: data }))
                continue
            }

            recordSuccess()

            const results: any[] = Array.isArray(data.results) ? data.results : []
            payloadOrders.forEach((order, idx) => {
                const result = results.find((r: any) => r.index === idx)
                if (result?.success) {
                    allResults.push({
                        orderId: order._orderId,
                        success: true,
                        ghdataOrderId: result.order_id,
                        ghdataShortId: result.short_id,
                        apiResponse: result,
                    })
                } else {
                    allResults.push({
                        orderId: order._orderId,
                        success: false,
                        error: result?.error || 'Order failed in bulk response',
                        apiResponse: result,
                    })
                }
            })
        } catch (error: any) {
            recordFailure()
            console.error('[GhData Bulk] Exception:', error.message)
            payloadOrders.forEach(o => allResults.push({ orderId: o._orderId, success: false, error: error.message || 'Bulk order exception' }))
        }
    }

    return allResults
}

// ── Status Check ─────────────────────────────────────────────────────────────
export async function checkGhDataOrderStatus(ghdataOrderId: string): Promise<GhDataStatusResponse> {
    if (!GHDATA_API_KEY) return { success: false, status: 'pending', message: 'GHDATA_API_KEY not configured' }

    try {
        const response = await fetch(`${GHDATA_API_BASE_URL}/orders?id=${encodeURIComponent(ghdataOrderId)}`, {
            method: 'GET',
            headers: { 'X-API-Key': GHDATA_API_KEY },
        })

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[GhData Status] Non-JSON response (HTTP ${response.status})`)
            return { success: false, status: 'pending', message: `Unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log(`[GhData Status] Raw response for ${ghdataOrderId}:`, JSON.stringify(data).slice(0, 500))

        if (response.ok && data.success) {
            const orders: any[] = Array.isArray(data.orders) ? data.orders : []
            const order = orders[0]
            const statusStr = (order?.status || '').toLowerCase()

            let mappedStatus: 'pending' | 'processing' | 'completed' | 'failed' = 'processing'
            if (['completed', 'success', 'delivered'].includes(statusStr)) mappedStatus = 'completed'
            else if (['failed', 'error', 'rejected'].includes(statusStr)) mappedStatus = 'failed'
            else if (['pending', 'queued'].includes(statusStr)) mappedStatus = 'processing'

            return { success: true, status: mappedStatus, data: order }
        }

        return { success: false, status: 'pending', message: data.error || data.message || 'Failed to check status' }
    } catch (error: any) {
        return { success: false, status: 'pending', message: error.message || 'Connection error' }
    }
}

// ── Balance ───────────────────────────────────────────────────────────────────
export async function fetchGhDataBalance(): Promise<{ success: boolean; balance?: number; currency?: string; tier?: string; name?: string; error?: string }> {
    if (!GHDATA_API_KEY) return { success: false, error: 'GHDATA_API_KEY not configured' }

    try {
        const response = await fetch(`${GHDATA_API_BASE_URL}/balance`, {
            method: 'GET',
            headers: { 'X-API-Key': GHDATA_API_KEY },
        })

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error('[GhData Balance] Non-JSON response:', rawText.slice(0, 300))
            return { success: false, error: `GhData returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log('[GhData Balance] API Response:', JSON.stringify(data))

        if (response.ok && data.success) {
            return {
                success: true,
                balance: parseFloat(data.balance) || 0,
                currency: 'GHS',
                tier: data.tier,
                name: data.name,
            }
        }

        return { success: false, error: data.error || data.message || 'Failed to fetch GhData balance' }
    } catch (error: any) {
        console.error('[GhData Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
