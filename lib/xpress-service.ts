// Xpress Fulfillment Service — mirrors lib/codecraft-service.ts architecture
import type { OrderToFulfill, BulkOrderResult } from '@/lib/fulfillment-service'

const XPRESS_API_KEY = process.env.XPRESS_KEY || ''
const XPRESS_API_BASE_URL = 'https://labppmcqsdeuollwcgwu.supabase.co/functions/v1/agent-api'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
}

// ─── Network Mapping ──────────────────────────────────────────────────────────
// Maps internal network names → Xpress service strings
function resolveService(network: string): string | null {
    if (network === 'MTN') return 'mtn'
    if (network === 'Telecel') return 'telecel'
    if (network === 'AT-iShare' || network === 'AT-BigTime') return 'airteltigo'
    return null
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
        console.log('[Xpress] Circuit breaker OPENED')
    }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via Xpress API.
 * Mirrors the signature of fulfillment-service.ts fulfillOrder().
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    // Accepted for call-site parity with the other supplier services but intentionally
    // unused here — see the `reference: orderId` comment below for why.
    dispatchKey: string = orderId
): Promise<FulfillmentResponse> {
    if (!checkCircuit()) {
        console.warn(`[Xpress] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)' }
    }

    if (!XPRESS_API_KEY) {
        return { success: false, error: 'Xpress API key not configured' }
    }

    const service = resolveService(network)
    if (!service) {
        console.log(`[Xpress] Skip: Unsupported network ${network}`)
        return { success: false, error: `Unsupported network: ${network}` }
    }

    const sizeMatch = dataSize.match(/[\d.]+/)
    if (!sizeMatch) {
        console.log(`[Xpress] Skip: Could not extract numeric volume from "${dataSize}"`)
        return { success: false, error: `Invalid data size format: ${dataSize}` }
    }

    const dataGb = Number(sizeMatch[0])
    if (isNaN(dataGb) || dataGb <= 0) {
        return { success: false, error: `Invalid GB volume parsed from: ${dataSize}` }
    }

    // Normalize phone number to local format (0XXXXXXXXX)
    let msisdn = phoneNumber
    if (msisdn.startsWith('233')) msisdn = '0' + msisdn.slice(3)
    else if (!msisdn.startsWith('0')) msisdn = '0' + msisdn

    // `reference` MUST be the plain order id, not `dispatchKey` — Xpress echoes this field
    // back verbatim on the order.completed webhook, and app/api/webhooks/xpress/route.ts
    // resolves it straight into `.eq('id', internalOrderId)`. A composite dispatchKey
    // (e.g. "<uuid>:<attempt_no>") is not a valid UUID literal and breaks that lookup.
    const requestBody = {
        service,
        items: [{ msisdn, data_gb: dataGb, reference: orderId }],
    }

    console.log(`[Xpress] Order ${orderId} | ${network} → ${service} | ${dataGb}GB | Phone: ${msisdn}`)
    console.log(`[Xpress] Request payload:`, JSON.stringify(requestBody))

    try {
        const response = await fetch(`${XPRESS_API_BASE_URL}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': XPRESS_API_KEY,
            },
            body: JSON.stringify(requestBody),
        })

        if (response.status === 429) {
            console.warn(`[Xpress] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
            return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true }
        }

        let data: any
        try {
            data = await response.json()
        } catch {
            const rawText = await response.text().catch(() => '')
            console.error(`[Xpress] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        console.log(`[Xpress] Full API response (HTTP ${response.status}):`, JSON.stringify(data))

        if (response.ok && data.order_id) {
            recordSuccess()
            return {
                success: true,
                reference: data.order_id,
                transactionId: data.order_id,
                apiResponse: data,
            }
        }

        recordFailure()
        return {
            success: false,
            error: data.error || 'Fulfillment failed',
            apiResponse: data,
        }
    } catch (error: any) {
        recordFailure()
        console.error(`[Xpress] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Connection error' }
    }
}

// ─── Order Status Check ────────────────────────────────────────────────────────
/**
 * Fetch a single Xpress order and return its item list.
 * Used by the sync route to poll delivery status.
 */
export async function checkOrderStatus(xpressOrderId: string): Promise<{
    success: boolean
    items?: Array<{ reference: string; status: string; msisdn: string; data_gb: number; price?: number }>
    orderStatus?: string
    error?: string
}> {
    if (!XPRESS_API_KEY) return { success: false, error: 'Xpress API key not configured' }

    try {
        const response = await fetch(`${XPRESS_API_BASE_URL}/orders/${xpressOrderId}`, {
            method: 'GET',
            headers: { 'X-API-Key': XPRESS_API_KEY },
        })

        let data: any
        try {
            data = await response.json()
        } catch {
            return { success: false, error: `Non-JSON response (HTTP ${response.status})` }
        }

        if (response.ok && Array.isArray(data.items)) {
            return { success: true, items: data.items, orderStatus: data.status }
        }

        return { success: false, error: data.error || `HTTP ${response.status}` }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live Xpress wallet balance.
 * Response: { balance_ghs: 481.00, updated_at: "..." }
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    try {
        const response = await fetch(`${XPRESS_API_BASE_URL}/wallet`, {
            method: 'GET',
            headers: { 'X-API-Key': XPRESS_API_KEY },
        })

        let data: any
        try {
            data = await response.json()
        } catch {
            const rawText = await response.text().catch(() => '')
            console.error('[Xpress Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Unexpected response format (HTTP ${response.status})` }
        }

        console.log('[Xpress Balance] API Response:', JSON.stringify(data))

        if (response.ok && data.balance_ghs !== undefined) {
            return { success: true, balance: parseFloat(data.balance_ghs) || 0, currency: 'GHS' }
        }

        return { success: false, error: data.error || 'Failed to fetch balance' }
    } catch (error: any) {
        console.error('[Xpress Balance] Error:', error)
        return { success: false, error: error.message }
    }
}

/**
 * Fulfill multiple orders via Xpress bulk API.
 * Orders are grouped by resolved service name (network) because the Xpress
 * /orders endpoint accepts only one `service` per call. One HTTP request
 * is made per network group. On success the whole group is marked processing;
 * on failure the whole group is reverted to pending.
 */
export async function fulfillOrdersBulk(orders: OrderToFulfill[]): Promise<BulkOrderResult[]> {
    if (!checkCircuit()) {
        return orders.map(o => ({
            orderId: o.id,
            success: false,
            error: 'Service temporarily unavailable (circuit open)',
        }))
    }

    if (!XPRESS_API_KEY) {
        return orders.map(o => ({ orderId: o.id, success: false, error: 'Xpress API key not configured' }))
    }

    if (orders.length === 0) return []

    const results: BulkOrderResult[] = []

    // ── Group by service (network) ───────────────────────────────────────────
    const serviceGroups = new Map<string, OrderToFulfill[]>()
    for (const order of orders) {
        const service = resolveService(order.network)
        if (!service) {
            results.push({ orderId: order.id, success: false, error: `Unsupported network: ${order.network}` })
            continue
        }
        if (!serviceGroups.has(service)) serviceGroups.set(service, [])
        serviceGroups.get(service)!.push(order)
    }

    // ── One API call per service group ───────────────────────────────────────
    for (const [service, groupOrders] of serviceGroups) {
        if (!checkCircuit()) {
            groupOrders.forEach(o =>
                results.push({ orderId: o.id, success: false, error: 'Service temporarily unavailable (circuit open)' })
            )
            continue
        }

        // Validate size before building items — push failures for invalid sizes now
        const validGroupOrders: typeof groupOrders = []
        for (const order of groupOrders) {
            const sizeMatch = order.size.match(/[\d.]+/)
            const dataGb = sizeMatch ? Number(sizeMatch[0]) : 0
            if (!sizeMatch || dataGb <= 0) {
                results.push({ orderId: order.id, success: false, error: `Invalid data size: ${order.size}` })
            } else {
                validGroupOrders.push(order)
            }
        }

        if (validGroupOrders.length === 0) continue

        const items = validGroupOrders.map(order => {
            const sizeMatch = order.size.match(/[\d.]+/)!
            const dataGb = Number(sizeMatch[0])

            let msisdn = order.phone_number
            if (msisdn.startsWith('233')) msisdn = '0' + msisdn.slice(3)
            else if (!msisdn.startsWith('0')) msisdn = '0' + msisdn

            return { msisdn, data_gb: dataGb, reference: order.id }
        })

        console.log(`[Xpress Bulk] Dispatching ${items.length} order(s) for service "${service}"`)

        try {
            const response = await fetch(`${XPRESS_API_BASE_URL}/orders`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': XPRESS_API_KEY,
                },
                body: JSON.stringify({ service, items }),
            })

            if (response.status === 429) {
                console.warn(`[Xpress Bulk] Rate limited for service "${service}"`)
                recordFailure()
                validGroupOrders.forEach(o =>
                    results.push({ orderId: o.id, success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true })
                )
                continue
            }

            let data: any
            try {
                data = await response.json()
            } catch {
                await response.text().catch(() => '')
                console.error(`[Xpress Bulk] Non-JSON response (HTTP ${response.status}) for "${service}"`)
                recordFailure()
                validGroupOrders.forEach(o =>
                    results.push({ orderId: o.id, success: false, error: `Non-JSON response (HTTP ${response.status})` })
                )
                continue
            }

            console.log(`[Xpress Bulk] Response for "${service}" (HTTP ${response.status}): order_id=${data.order_id || 'none'}`)

            if (response.ok && data.order_id) {
                recordSuccess()
                validGroupOrders.forEach(o =>
                    results.push({
                        orderId: o.id,
                        success: true,
                        reference: data.order_id,
                        transactionId: data.order_id,
                        apiResponse: data,
                    })
                )
            } else {
                recordFailure()
                const errorMsg = data.error || data.message || `Batch failed for service "${service}"`
                validGroupOrders.forEach(o =>
                    results.push({ orderId: o.id, success: false, error: errorMsg, apiResponse: data })
                )
            }

        } catch (error: any) {
            recordFailure()
            console.error(`[Xpress Bulk] Exception for service "${service}":`, error.message)
            validGroupOrders.forEach(o =>
                results.push({ orderId: o.id, success: false, error: error.message || 'Connection error' })
            )
        }
    }

    return results
}
