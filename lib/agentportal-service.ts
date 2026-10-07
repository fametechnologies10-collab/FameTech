const AGENTPORTAL_API_KEY = process.env.AGENTPORTAL_API_KEY || ''
const AGENTPORTAL_API_BASE_URL = process.env.AGENTPORTAL_API_BASE_URL || 'https://api.agentportalgh.com'

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
        console.log('[AgentPortal] Circuit breaker opened')
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────
export type AgentPortalService = 'mtn' | 'telecel' | 'airteltigo'

export interface AgentPortalFulfillmentResponse {
    success: boolean
    error?: string
    apiResponse?: any
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
    error?: string
    apiResponse?: any
    reference?: string
    transactionId?: string
    // Set ONLY when the failure came from a transport-level exception (fetch threw —
    // network drop, timeout, DNS, etc.) rather than a definite HTTP/business rejection
    // from AgentPortal. In that case we genuinely do not know whether AgentPortal already
    // queued and charged the chunk before the connection dropped. AgentPortal has no
    // idempotency key, so callers (lib/refulfillment-service.ts) must NOT treat this the
    // same as a confirmed failure — reverting it to 'pending' would let the next retry
    // re-submit and risk paying + delivering twice.
    ambiguous?: boolean
}

// ── Network → service mapping ────────────────────────────────────────────────
// AT-iShare and AT-BigTime are two of our own network buckets, but AgentPortal has a
// single AirtelTigo service (1-200GB) — no iShare/BigTime split on their side.
export function resolveService(network: string): AgentPortalService | null {
    if (network === 'MTN') return 'mtn'
    if (network === 'Telecel') return 'telecel'
    if (network === 'AT-iShare' || network === 'AT-BigTime') return 'airteltigo'
    return null
}

// ── Bundle size window per service (whole GB only) ───────────────────────────
const SERVICE_WINDOWS: Record<AgentPortalService, { min: number; max: number }> = {
    mtn: { min: 1, max: 200 },
    telecel: { min: 10, max: 200 },
    airteltigo: { min: 1, max: 200 },
}

/**
 * Extracts the whole-GB size from our `size` string (e.g. "5GB"). Does NOT round — a
 * non-integer value returns null so callers reject the item rather than silently deliver a
 * different bundle size than what the customer paid for.
 */
export function parseWholeGb(sizeStr: string): number | null {
    const match = sizeStr.match(/[\d.]+/)
    if (!match) return null
    const num = parseFloat(match[0])
    if (isNaN(num) || !Number.isInteger(num)) return null
    return num
}

export function validateWindow(service: AgentPortalService, gb: number): string | null {
    const window = SERVICE_WINDOWS[service]
    if (gb < window.min || gb > window.max) {
        return `${service.toUpperCase()} only accepts bundles of ${window.min}-${window.max} GB via AgentPortal — got ${gb} GB`
    }
    return null
}

export function normalizePhone(phone: string): string {
    if (phone.startsWith('233')) return '0' + phone.slice(3)
    if (!phone.startsWith('0')) return '0' + phone
    return phone
}

export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    // Accepted for call-site parity with the other supplier services but intentionally
    // unused here — see the `reference: orderId` comment below for why.
    dispatchKey: string = orderId
): Promise<AgentPortalFulfillmentResponse> {
    const service = resolveService(network)
    if (!service) return { success: false, error: `AgentPortal does not support network: ${network}` }

    const gb = parseWholeGb(dataSize)
    if (gb === null) {
        return { success: false, error: `AgentPortal requires a whole-GB bundle size — got "${dataSize}"` }
    }

    const windowError = validateWindow(service, gb)
    if (windowError) return { success: false, error: windowError }

    if (!checkCircuit()) return { success: false, error: 'AgentPortal service temporarily unavailable (circuit open)' }
    if (!AGENTPORTAL_API_KEY) return { success: false, error: 'AGENTPORTAL_API_KEY not configured' }

    const normalizedPhone = normalizePhone(phoneNumber)

    try {
        const response = await fetch(`${AGENTPORTAL_API_BASE_URL}/api/queue/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': AGENTPORTAL_API_KEY,
            },
            // `reference` MUST be the plain order id, not `dispatchKey` — AgentPortal echoes
            // this field back verbatim on the order.completed webhook, and
            // app/api/webhooks/agentportal/route.ts resolves it straight into
            // `.eq('id', internalOrderId)`. A composite dispatchKey (e.g.
            // "<uuid>:<attempt_no>") is not a valid UUID literal and breaks that lookup.
            body: JSON.stringify({
                service,
                items: [{ msisdn: normalizedPhone, data_gb: gb, reference: orderId }],
            }),
        })

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error(`[AgentPortal] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `AgentPortal returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log(`[AgentPortal] Order ${orderId} | service: ${service} | ${gb}GB | HTTP ${response.status}:`, JSON.stringify(data))

        if (!response.ok) {
            recordFailure()
            return { success: false, error: data.error || `AgentPortal error (HTTP ${response.status})`, apiResponse: data }
        }

        if (Array.isArray(data.rejected) && data.rejected.length > 0 && data.added === 0) {
            // Whitelist gate (or similar per-item rejection) — not a supplier-side
            // failure, don't trip the circuit breaker for it.
            return { success: false, error: data.rejected[0].reason || 'Rejected by AgentPortal', apiResponse: data }
        }

        if (data.added !== 1) {
            recordFailure()
            return { success: false, error: 'AgentPortal did not accept the item', apiResponse: data }
        }

        recordSuccess()
        // Accepted and charged — NOT delivered yet. Final success/failure arrives via the
        // order.completed webhook (app/api/webhooks/agentportal/route.ts).
        return { success: true, apiResponse: data }
    } catch (error: any) {
        recordFailure()
        return { success: false, error: error.message || 'Connection error to AgentPortal' }
    }
}

export function partitionOrdersForSubmission(orders: OrderToFulfill[]): {
    valid: Partial<Record<AgentPortalService, { order: OrderToFulfill; gb: number }[]>>
    invalid: BulkOrderResult[]
} {
    const valid: Partial<Record<AgentPortalService, { order: OrderToFulfill; gb: number }[]>> = {}
    const invalid: BulkOrderResult[] = []

    for (const order of orders) {
        const service = resolveService(order.network)
        if (!service) {
            invalid.push({ orderId: order.id, success: false, error: `AgentPortal does not support network: ${order.network}` })
            continue
        }

        const gb = parseWholeGb(order.size)
        if (gb === null) {
            invalid.push({ orderId: order.id, success: false, error: `AgentPortal requires a whole-GB bundle size — got "${order.size}"` })
            continue
        }

        const windowError = validateWindow(service, gb)
        if (windowError) {
            invalid.push({ orderId: order.id, success: false, error: windowError })
            continue
        }

        if (!valid[service]) valid[service] = []
        valid[service]!.push({ order, gb })
    }

    return { valid, invalid }
}

const BULK_CHUNK_SIZE = 500

/**
 * Unlike GhData's forced-sequential bulk (their API doesn't actually batch), AgentPortal
 * genuinely accepts up to 1000 items/request. Orders are grouped by resolved `service`
 * first (a single request can't mix networks), pre-validated and filtered locally before
 * sending (one bad row must never poison an entire chunk's 400 response), then chunked at
 * 500/request — smaller than the API's 1000 max, to keep the "blast radius" of one
 * slow/retrying item smaller (the order.completed webhook for a whole chunk only fires once
 * every item in it is terminal).
 */
export async function fulfillOrdersBulk(orders: OrderToFulfill[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []
    if (!AGENTPORTAL_API_KEY) {
        return orders.map(o => ({ orderId: o.id, success: false, error: 'AGENTPORTAL_API_KEY not configured' }))
    }
    if (!checkCircuit()) {
        return orders.map(o => ({ orderId: o.id, success: false, error: 'AgentPortal service temporarily unavailable (circuit open)' }))
    }

    const { valid, invalid } = partitionOrdersForSubmission(orders)
    const allResults: BulkOrderResult[] = [...invalid]

    for (const service of Object.keys(valid) as AgentPortalService[]) {
        const items = valid[service]!

        for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE) {
            const chunk = items.slice(i, i + BULK_CHUNK_SIZE)

            try {
                const response = await fetch(`${AGENTPORTAL_API_BASE_URL}/api/queue/add`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': AGENTPORTAL_API_KEY,
                    },
                    body: JSON.stringify({
                        service,
                        items: chunk.map(({ order, gb }) => ({
                            msisdn: normalizePhone(order.phone_number),
                            data_gb: gb,
                            reference: order.id,
                        })),
                    }),
                })

                const contentType = response.headers.get('content-type') || ''
                if (!contentType.includes('application/json')) {
                    const rawText = await response.text()
                    console.error(`[AgentPortal Bulk] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
                    recordFailure()
                    chunk.forEach(({ order }) => allResults.push({ orderId: order.id, success: false, error: `AgentPortal returned unexpected response (HTTP ${response.status})` }))
                    continue
                }

                const data = await response.json()
                console.log(`[AgentPortal Bulk] service=${service} chunk=${chunk.length} HTTP ${response.status}:`, JSON.stringify(data).slice(0, 500))

                if (!response.ok) {
                    recordFailure()
                    chunk.forEach(({ order }) => allResults.push({ orderId: order.id, success: false, error: data.error || `AgentPortal error (HTTP ${response.status})`, apiResponse: data }))
                    continue
                }

                recordSuccess()

                const rejectedByMsisdn = new Map<string, string>()
                if (Array.isArray(data.rejected)) {
                    for (const r of data.rejected) {
                        rejectedByMsisdn.set(r.msisdn, r.reason || 'Rejected by AgentPortal')
                    }
                }

                // Sanity check: added + rejected should account for every item in the chunk.
                // If AgentPortal ever accepts fewer items than we sent without listing the
                // remainder in `rejected`, we deliberately do NOT flip those orders to
                // failed — a re-fulfillment retry could double-charge/double-deliver if the
                // order actually was queued on AgentPortal's side, which is worse than the
                // status quo. A later reconciliation job flags orders stuck in `processing`
                // instead. This just makes the discrepancy loud and greppable in prod logs.
                const addedCount = typeof data.added === 'number' && Number.isFinite(data.added) ? data.added : 0
                const rejectedCount = Array.isArray(data.rejected) ? data.rejected.length : 0
                const accountedCount = addedCount + rejectedCount
                if (accountedCount !== chunk.length) {
                    // We can't pinpoint exactly which item(s) are unaccounted for — that's
                    // the whole problem — so list every order ID in the affected chunk
                    // rather than a filtered subset that could end up empty (e.g. two
                    // orders sharing one msisdn both resolve via `rejectedByMsisdn` yet
                    // still trip this count check on the duplicate).
                    const chunkOrderIds = chunk.map(({ order }) => order.id)
                    console.error(
                        `[AgentPortal Bulk] DISCREPANCY: service=${service} chunkSize=${chunk.length} added=${data.added} rejectedCount=${rejectedCount} accounted=${accountedCount} — mismatch with items sent. Affected order IDs (some may be marked accepted without full corroboration): ${chunkOrderIds.join(', ')}`
                    )
                }

                for (const { order } of chunk) {
                    const normalizedPhone = normalizePhone(order.phone_number)
                    const rejectionReason = rejectedByMsisdn.get(normalizedPhone)
                    if (rejectionReason) {
                        // Rejection is per-number — every order sharing this msisdn in the
                        // chunk is equally rejected, no ambiguity even with duplicates.
                        allResults.push({ orderId: order.id, success: false, error: rejectionReason, apiResponse: data })
                    } else {
                        // Accepted and charged — NOT delivered yet. Final status arrives
                        // via the order.completed webhook.
                        allResults.push({ orderId: order.id, success: true, apiResponse: data })
                    }
                }
            } catch (error: any) {
                recordFailure()
                console.error('[AgentPortal Bulk] Exception:', error.message)
                // Ambiguous, not definite: the fetch itself threw (e.g. connection reset,
                // timeout) — we never even parsed a response, so AgentPortal may already have
                // accepted and charged this chunk server-side. Flag ambiguous:true so a
                // re-fulfillment retry doesn't blindly resubmit and double-charge/deliver.
                chunk.forEach(({ order }) => allResults.push({ orderId: order.id, success: false, error: error.message || 'Bulk order exception', ambiguous: true }))
            }
        }
    }

    return allResults
}

export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    if (!AGENTPORTAL_API_KEY) return { success: false, error: 'AGENTPORTAL_API_KEY not configured' }

    try {
        const response = await fetch(`${AGENTPORTAL_API_BASE_URL}/api/wallet/summary`, {
            method: 'GET',
            headers: { 'X-API-Key': AGENTPORTAL_API_KEY },
        })

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error('[AgentPortal Balance] Non-JSON response:', rawText.slice(0, 300))
            return { success: false, error: `AgentPortal returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()

        if (data === null || typeof data !== 'object') {
            console.error('[AgentPortal Balance] Non-object response body:', JSON.stringify(data))
            return { success: false, error: `AgentPortal returned an unexpected response body (HTTP ${response.status})` }
        }

        if (response.ok) {
            // Never coerce a missing/unparseable wallet to 0 — a real 0 balance and a
            // shape change must not look the same to the admin panel.
            if (data.balance === undefined || data.balance === null) {
                console.error('[AgentPortal Balance] Balance missing from response:', JSON.stringify(data))
                return { success: false, error: 'Balance missing from supplier response' }
            }
            const balance = parseFloat(data.balance)
            if (Number.isNaN(balance)) {
                console.error('[AgentPortal Balance] Unparseable balance value:', JSON.stringify(data.balance))
                return { success: false, error: `Unparseable balance value: ${JSON.stringify(data.balance)}` }
            }
            return { success: true, balance, currency: 'GHS' }
        }

        return { success: false, error: data.error || 'Failed to fetch AgentPortal balance' }
    } catch (error: any) {
        console.error('[AgentPortal Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
