/**
 * Multi-Provider SMS Service
 *
 * Supports Hubtel (primary), Moolre, and mNotify.
 * The active primary provider and fallback order are read from
 * admin_settings (keys: sms_primary_provider, sms_fallback_providers)
 * and cached for 5 minutes so the admin panel can switch live.
 */

export interface SMSOptions {
    recipient: string
    message: string
    sender?: string
}

export interface SMSResult {
    success: boolean
    messageId?: string
    batchId?: string
    error?: string
    provider?: string
}

export type SmsProvider = 'hubtel' | 'moolre' | 'mnotify'

// ─── Provider Endpoints ──────────────────────────────────────────────────────
const MOOLRE_BASE_URL     = 'https://api.moolre.com'
const MOOLRE_SMS_ENDPOINT = '/open/sms/send'
const MNOTIFY_BASE_URL    = 'https://api.mnotify.com/api/sms/quick'
const HUBTEL_SMS_BASE_URL = 'https://sms.hubtel.com/v1/messages'

// ─── In-memory provider routing cache (5 min TTL) ────────────────────────────
let _routingCache: { primary: SmsProvider; fallbacks: SmsProvider[]; ts: number } | null = null
const ROUTING_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export async function getRoutingConfig(): Promise<{ primary: SmsProvider; fallbacks: SmsProvider[] }> {
    // Return cached config if still fresh
    if (_routingCache && Date.now() - _routingCache.ts < ROUTING_CACHE_TTL) {
        return { primary: _routingCache.primary, fallbacks: _routingCache.fallbacks }
    }

    try {
        // Dynamic import to avoid bundling Supabase in every edge context
        const { createServerClient } = await import('@/lib/supabase')
        const supabase = createServerClient()
        const { data } = await (supabase as any)
            .from('admin_settings')
            .select('key, value')
            .in('key', ['sms_primary_provider', 'sms_fallback_providers'])

        const s: Record<string, string> = {}
        for (const row of (data || [])) s[row.key] = row.value

        const primary   = (s.sms_primary_provider as SmsProvider)   || 'hubtel'
        let fallbacks: SmsProvider[] = []
        try { fallbacks = JSON.parse(s.sms_fallback_providers || '[]') } catch { fallbacks = ['moolre', 'mnotify'] }
        // Remove primary from fallbacks in case admin misconfigured
        fallbacks = fallbacks.filter(p => p !== primary)

        _routingCache = { primary, fallbacks, ts: Date.now() }
        return { primary, fallbacks }
    } catch {
        // Fallback to env-based defaults if DB unreachable
        return { primary: 'hubtel', fallbacks: ['moolre', 'mnotify'] }
    }
}

/** Invalidate routing cache (call after provider settings are saved) */
export function invalidateSmsRoutingCache() {
    _routingCache = null
}

/**
 * Validate SMS configuration on module load
 */
function validateSMSConfig() {
    if (!process.env.HUBTEL_CLIENT_ID)    console.warn('[SMS Config] WARNING: HUBTEL_CLIENT_ID not set.')
    if (!process.env.HUBTEL_CLIENT_SECRET) console.warn('[SMS Config] WARNING: HUBTEL_CLIENT_SECRET not set.')
    if (!process.env.MOOLRE_API_KEY)       console.warn('[SMS Config] WARNING: MOOLRE_API_KEY not set.')
    if (!process.env.MNOTIFY_API_KEY)      console.warn('[SMS Config] WARNING: MNOTIFY_API_KEY not set.')
}

// Run validation when module loads
validateSMSConfig()

// ──────────────────────────────────────────────────────────────────────────────
// PHONE NORMALIZER
// ──────────────────────────────────────────────────────────────────────────────

// Lives in its own file (lib/phone-normalize.ts) with zero server-only
// imports, so client code (e.g. lib/phone-import.ts) can use it without
// transitively bundling this module's module-load side effects (provider
// endpoint constants, validateSMSConfig() console warnings naming
// suppliers). Re-exported here so every existing importer of
// normalizeGhanaPhone from '@/lib/sms-service' keeps working unchanged.
import { normalizeGhanaPhone } from './phone-normalize'
export { normalizeGhanaPhone }

// ──────────────────────────────────────────────────────────────────────────────
// HUBTEL PROVIDER
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Send a single SMS via Hubtel (POST JSON + Basic Auth)
 */
export async function sendHubtelSMS(options: SMSOptions): Promise<SMSResult> {
    const clientId     = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET
    const defaultSender = (process.env.HUBTEL_SENDER_ID || 'KINGFLEXY').substring(0, 11)

    if (!clientId || !clientSecret) {
        return { success: false, error: 'HUBTEL_CLIENT_ID / HUBTEL_CLIENT_SECRET not configured.' }
    }

    const normalizedPhone = normalizeGhanaPhone(options.recipient)
    if (!normalizedPhone) {
        return { success: false, error: `Invalid phone number: ${options.recipient}` }
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    try {
        const response = await fetch(`${HUBTEL_SMS_BASE_URL}/send`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'Authorization': `Basic ${basicAuth}`,
            },
            body: JSON.stringify({
                From:    options.sender || defaultSender,
                To:      normalizedPhone,
                Content: options.message,
            }),
        })

        const data: any = await response.json().catch(() => ({}))

        if ((response.status === 200 || response.status === 201) && (data.status === 0 || data.statusDescription?.toLowerCase().includes('success'))) {
            return { success: true, messageId: data.messageId, provider: 'hubtel' }
        }

        const err = data.statusDescription || `Hubtel error ${response.status}`
        console.error('[Hubtel SMS] ❌', err, data)
        return { success: false, error: err, provider: 'hubtel' }
    } catch (e: any) {
        console.error('[Hubtel SMS] ❌ Exception:', e.message)
        return { success: false, error: `Hubtel exception: ${e.message}`, provider: 'hubtel' }
    }
}

// Hubtel recommends ≤1,000 recipients per batch call
const HUBTEL_BATCH_CHUNK_SIZE = 1000

/**
 * Batch-send personalized SMS via Hubtel.
 * Each recipient can have a different message body (supports [FirstName] etc.)
 * Uses Hubtel's /batch/personalized/send endpoint.
 * Automatically chunks recipients into batches of 1,000 to stay within limits.
 */
export async function sendHubtelBatchSMS(
    recipients: Array<{ phone: string; message: string }>,
    senderOverride?: string
): Promise<{ batchId?: string; batchIds: string[]; sent: number; failed: number; errors: string[] }> {
    const clientId     = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET
    const defaultSender = (process.env.HUBTEL_SENDER_ID || 'KINGFLEXY').substring(0, 11)
    const From = (senderOverride || defaultSender).substring(0, 11)

    if (!clientId || !clientSecret) {
        return { sent: 0, failed: recipients.length, batchIds: [], errors: ['Hubtel credentials not configured'] }
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    // Normalize and filter all recipients upfront
    const valid: Array<{ To: string; Content: string }> = []
    const errors: string[] = []

    for (const r of recipients) {
        const phone = normalizeGhanaPhone(r.phone)
        if (!phone) { errors.push(`Invalid phone: ${r.phone}`); continue }
        valid.push({ To: phone, Content: r.message })
    }

    if (valid.length === 0) {
        return { sent: 0, failed: recipients.length, batchIds: [], errors }
    }

    // Chunk into groups of HUBTEL_BATCH_CHUNK_SIZE
    let totalSent = 0
    const batchIds: string[] = []

    for (let i = 0; i < valid.length; i += HUBTEL_BATCH_CHUNK_SIZE) {
        const chunk = valid.slice(i, i + HUBTEL_BATCH_CHUNK_SIZE)
        try {
            const response = await fetch(`${HUBTEL_SMS_BASE_URL}/batch/personalized/send`, {
                method: 'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Accept':        'application/json',
                    'Authorization': `Basic ${basicAuth}`,
                },
                body: JSON.stringify({ From, personalizedRecipients: chunk }),
            })

            const data: any = await response.json().catch(() => ({}))

            if ((response.status === 200 || response.status === 201) && data.status === 0) {
                if (data.batchId) batchIds.push(data.batchId)
                totalSent += (data.data || []).length
            } else {
                const errMsg = data.statusDescription || `Hubtel batch error ${response.status} (chunk ${Math.floor(i / HUBTEL_BATCH_CHUNK_SIZE) + 1})`
                errors.push(errMsg)
                console.error('[Hubtel Batch SMS] ❌ chunk failed:', errMsg)
            }
        } catch (e: any) {
            errors.push(`Hubtel chunk exception: ${e.message}`)
            console.error('[Hubtel Batch SMS] ❌ chunk exception:', e.message)
        }
    }

    return {
        batchId:  batchIds[0],
        batchIds,
        sent:     totalSent,
        failed:   (valid.length - totalSent) + errors.filter(e => e.startsWith('Invalid')).length,
        errors,
    }
}

/**
 * Batch-send an identical SMS to many recipients via Hubtel's simple batch endpoint.
 * Use this when the message body is the same for all recipients (no [FirstName] etc.)
 * Uses Hubtel's /batch/simple/send endpoint — more efficient than personalized.
 * Automatically chunks recipients into batches of 1,000.
 */
export async function sendHubtelSimpleBatchSMS(
    phones: string[],
    content: string,
    senderOverride?: string
): Promise<{ batchId?: string; batchIds: string[]; sent: number; failed: number; errors: string[] }> {
    const clientId     = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET
    const defaultSender = (process.env.HUBTEL_SENDER_ID || 'KINGFLEXY').substring(0, 11)
    const From = (senderOverride || defaultSender).substring(0, 11)

    if (!clientId || !clientSecret) {
        return { sent: 0, failed: phones.length, batchIds: [], errors: ['Hubtel credentials not configured'] }
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    // Normalize and filter all phones upfront
    const valid: string[] = []
    const errors: string[] = []

    for (const p of phones) {
        const phone = normalizeGhanaPhone(p)
        if (!phone) { errors.push(`Invalid phone: ${p}`); continue }
        valid.push(phone)
    }

    if (valid.length === 0) {
        return { sent: 0, failed: phones.length, batchIds: [], errors }
    }

    let totalSent = 0
    const batchIds: string[] = []

    for (let i = 0; i < valid.length; i += HUBTEL_BATCH_CHUNK_SIZE) {
        const chunk = valid.slice(i, i + HUBTEL_BATCH_CHUNK_SIZE)
        try {
            const response = await fetch(`${HUBTEL_SMS_BASE_URL}/batch/simple/send`, {
                method: 'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Accept':        'application/json',
                    'Authorization': `Basic ${basicAuth}`,
                },
                body: JSON.stringify({ From, Recipients: chunk, Content: content }),
            })

            const data: any = await response.json().catch(() => ({}))

            if ((response.status === 200 || response.status === 201) && data.status === 0) {
                if (data.batchId) batchIds.push(data.batchId)
                totalSent += (data.data || []).length
            } else {
                const errMsg = data.statusDescription || `Hubtel simple batch error ${response.status} (chunk ${Math.floor(i / HUBTEL_BATCH_CHUNK_SIZE) + 1})`
                errors.push(errMsg)
                console.error('[Hubtel Simple Batch SMS] ❌ chunk failed:', errMsg)
            }
        } catch (e: any) {
            errors.push(`Hubtel simple batch chunk exception: ${e.message}`)
            console.error('[Hubtel Simple Batch SMS] ❌ chunk exception:', e.message)
        }
    }

    return {
        batchId:  batchIds[0],
        batchIds,
        sent:     totalSent,
        failed:   (valid.length - totalSent) + errors.filter(e => e.startsWith('Invalid')).length,
        errors,
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// USER SMS PLATFORM — CAMPAIGN CHUNK SENDER (Hubtel-pinned)
// ──────────────────────────────────────────────────────────────────────────────

export interface CampaignRecipientResult {
    to: string
    messageId?: string
    networkId?: string
    rate?: number
}

export interface CampaignChunkResult {
    ok: boolean
    error?: string
    batchId?: string
    /** Per-recipient provider results (normalized 233… keys). May be sparse if
     *  Hubtel's response omits entries — the reconcile cron backstops those. */
    results: CampaignRecipientResult[]
}

/**
 * Send ONE campaign chunk (≤1,000 recipients, identical content) via Hubtel's
 * simple batch endpoint with RegisteredDelivery=true so delivery reports fire.
 *
 * Contract differences vs the admin-broadcast batch helpers above:
 *  - `sender` is REQUIRED. Campaign traffic must NEVER inherit the platform
 *    env default (a business-mode campaign falling back to KINGFLEXY would
 *    ship relaxed-filter content under the platform brand).
 *  - `phones` must already be normalized (233XXXXXXXXX) — the campaign
 *    pipeline normalizes once and persists sms_messages rows first.
 *  - Returns per-recipient MessageId/NetworkId/Rate for delivery tracking.
 *    (Field names parsed defensively pending Hubtel doc confirmation — G1.)
 *  - NO provider fallback: user-platform sends are Hubtel-pinned; Moolre/
 *    mNotify cannot resolve Hubtel sender IDs or delivery reports.
 */
export async function sendHubtelCampaignChunk(
    phones: string[],
    content: string,
    sender: string
): Promise<CampaignChunkResult> {
    const clientId     = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET

    if (!sender || !sender.trim()) {
        return { ok: false, error: 'SENDER_REQUIRED: campaign sends must carry an explicit sender ID', results: [] }
    }
    if (!clientId || !clientSecret) {
        return { ok: false, error: 'Hubtel credentials not configured', results: [] }
    }
    if (phones.length === 0) {
        return { ok: true, results: [] }
    }
    if (phones.length > HUBTEL_BATCH_CHUNK_SIZE) {
        return { ok: false, error: `Chunk exceeds ${HUBTEL_BATCH_CHUNK_SIZE} recipients`, results: [] }
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    try {
        const response = await fetch(`${HUBTEL_SMS_BASE_URL}/batch/simple/send`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'Authorization': `Basic ${basicAuth}`,
            },
            body: JSON.stringify({
                From: sender.trim().substring(0, 11),
                Recipients: phones,
                Content: content,
                RegisteredDelivery: true,
            }),
        })

        const data: any = await response.json().catch(() => ({}))

        if ((response.status === 200 || response.status === 201) && data.status === 0) {
            const entries: any[] = Array.isArray(data.data) ? data.data : []
            const results: CampaignRecipientResult[] = entries.map((e: any) => ({
                to: String(e.to ?? e.To ?? e.recipient ?? e.Recipient ?? ''),
                messageId: e.messageId ?? e.MessageId ?? e.id ?? undefined,
                networkId: e.networkId != null ? String(e.networkId) : (e.NetworkId != null ? String(e.NetworkId) : undefined),
                rate: typeof e.rate === 'number' ? e.rate : (typeof e.Rate === 'number' ? e.Rate : undefined),
            })).filter(r => r.to)
            return { ok: true, batchId: data.batchId, results }
        }

        const err = data.statusDescription || `Hubtel batch error ${response.status}`
        console.error('[SMS Campaign Chunk] ❌', err)
        return { ok: false, error: err, results: [] }
    } catch (e: any) {
        console.error('[SMS Campaign Chunk] ❌ Exception:', e.message)
        return { ok: false, error: `Hubtel exception: ${e.message}`, results: [] }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SHOP SMS — BATCH SENDER WITH DELIVERY TRACKING
// ──────────────────────────────────────────────────────────────────────────────

export interface ShopBatchRecipientResult {
    to: string
    messageId?: string
}

export interface ShopBatchResult {
    ok: boolean
    error?: string
    batchId?: string
    results: ShopBatchRecipientResult[]
}

/**
 * Pure response-parser, extracted so it's unit-testable without a network
 * call (see scripts/test-shop-sms-batch-response.ts). Mirrors the parsing
 * half of sendHubtelCampaignChunk.
 */
export function parseShopBatchResponse(data: any): ShopBatchResult {
    if (data?.status !== 0) {
        return { ok: false, error: data?.statusDescription || 'Hubtel batch error', results: [] }
    }
    const entries: any[] = Array.isArray(data.data) ? data.data : []
    const results: ShopBatchRecipientResult[] = entries
        .map((e: any) => ({
            to: String(e.to ?? e.To ?? e.recipient ?? e.Recipient ?? ''),
            messageId: e.messageId ?? e.MessageId ?? e.id ?? undefined,
        }))
        .filter(r => r.to)
    return { ok: true, batchId: data.batchId, results }
}

/**
 * Send ONE shop-SMS batch (≤1,000 recipients, identical content) via
 * Hubtel's simple batch endpoint with RegisteredDelivery=true, so delivery
 * reports fire and can be captured (see the DLR webhook and reconcile cron
 * generalization in Tasks 4-5).
 *
 * Hubtel-pinned by design — shop SMS gives up the Moolre/mNotify fallback
 * `sendSMS()` provides, in exchange for reliable delivery tracking (see
 * docs/superpowers/specs/2026-08-22-shop-sms-delivery-tracking-design.md §5,
 * §8). `sender` is REQUIRED — shop sends must never inherit the platform
 * env default.
 */
export async function sendHubtelShopBatchSMS(
    phones: string[],
    content: string,
    sender: string
): Promise<ShopBatchResult> {
    const clientId     = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET

    if (!sender || !sender.trim()) {
        return { ok: false, error: 'SENDER_REQUIRED: shop sends must carry an explicit sender ID', results: [] }
    }
    if (!clientId || !clientSecret) {
        return { ok: false, error: 'Hubtel credentials not configured', results: [] }
    }
    if (phones.length === 0) {
        return { ok: true, results: [] }
    }
    if (phones.length > HUBTEL_BATCH_CHUNK_SIZE) {
        return { ok: false, error: `Chunk exceeds ${HUBTEL_BATCH_CHUNK_SIZE} recipients`, results: [] }
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    try {
        const response = await fetch(`${HUBTEL_SMS_BASE_URL}/batch/simple/send`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'Authorization': `Basic ${basicAuth}`,
            },
            body: JSON.stringify({
                From: sender.trim().substring(0, 11),
                Recipients: phones,
                Content: content,
                RegisteredDelivery: true,
            }),
        })

        const data: any = await response.json().catch(() => ({}))
        const parsed = parseShopBatchResponse(data)
        if (!parsed.ok) console.error('[Shop SMS Batch] ❌', parsed.error)
        return parsed
    } catch (e: any) {
        console.error('[Shop SMS Batch] ❌ Exception:', e.message)
        return { ok: false, error: `Hubtel exception: ${e.message}`, results: [] }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// MOOLRE PROVIDER
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Send a single SMS via Moolre
 */
export async function sendMoolreSMS(options: SMSOptions): Promise<SMSResult> {
    const apiKey = process.env.MOOLRE_API_KEY
    const defaultSender = process.env.MOOLRE_SENDER_ID || 'GHDATA'

    if (!apiKey) {
        return { success: false, error: 'MOOLRE_API_KEY not configured.', provider: 'moolre' }
    }

    const normalizedPhone = normalizeGhanaPhone(options.recipient)
    if (!normalizedPhone) {
        return { success: false, error: `Invalid phone: ${options.recipient}`, provider: 'moolre' }
    }

    const reference = `SMS-${Date.now()}-${Math.random().toString(36).substring(7)}`
    const url = MOOLRE_BASE_URL + MOOLRE_SMS_ENDPOINT

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/json',
                'X-API-KEY':    apiKey,
                'X-API-VASKEY': apiKey,
            },
            body: JSON.stringify({
                type:     1,
                senderid: options.sender || defaultSender,
                messages: [{ recipient: normalizedPhone, message: options.message, ref: reference }],
            }),
        })

        const responseText = await response.text()
        let data: any
        try { data = JSON.parse(responseText) } catch {
            if (responseText.toLowerCase().includes('<html')) {
                return { success: false, error: 'Moolre: received HTML (bad endpoint?)', provider: 'moolre' }
            }
            return { success: false, error: `Moolre: bad JSON: ${responseText.substring(0, 80)}`, provider: 'moolre' }
        }

        const isSuccess =
            data.success === true ||
            data.status === 'success' ||
            data.status === 'sent' ||
            (response.status >= 200 && response.status < 300 && !data.error)

        if (isSuccess) return { success: true, messageId: data.message_id || data.id || 'sent', provider: 'moolre' }

        const errorMessage = data.message || data.error || data.msg || `Moolre error (${response.status})`
        console.error('[Moolre SMS] ❌', errorMessage)
        return { success: false, error: errorMessage, provider: 'moolre' }
    } catch (e: any) {
        console.error('[Moolre SMS] ❌ Exception:', e.message)
        return { success: false, error: `Moolre exception: ${e.message}`, provider: 'moolre' }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PRIMARY DISPATCHER (with auto-fallback)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Send a single SMS using the configured primary provider.
 * If the primary fails, it automatically retries each fallback in order.
 */
export async function sendSMS(options: SMSOptions): Promise<SMSResult> {
    let routing: { primary: SmsProvider; fallbacks: SmsProvider[] }
    try {
        routing = await getRoutingConfig()
    } catch {
        routing = { primary: 'hubtel', fallbacks: ['moolre', 'mnotify'] }
    }

    const order: SmsProvider[] = [routing.primary, ...routing.fallbacks]

    for (const provider of order) {
        let result: SMSResult
        if (provider === 'hubtel')  result = await sendHubtelSMS(options)
        else if (provider === 'moolre')  result = await sendMoolreSMS(options)
        else result = await sendMnotifySMS(options)

        if (result.success) return result

        console.warn(`[SMS Router] ${provider} failed: ${result.error} — trying next provider…`)
    }

    return { success: false, error: 'All SMS providers failed to deliver the message.' }
}

/**
 * Send a quick SMS via mNotify
 */
export async function sendMnotifySMS(options: SMSOptions): Promise<SMSResult> {
    const apiKey = process.env.MNOTIFY_API_KEY
    const defaultSender = process.env.MNOTIFY_SENDER_ID || 'KINGFLEXY'

    if (!apiKey) {
        const error = 'MNOTIFY_API_KEY not configured in environment variables.'
        console.error('[SMS Service] ERROR:', error)
        return { success: false, error }
    }

    try {
        let normalizedPhone = options.recipient
            .replace(/\s+/g, '')
            .replace(/-/g, '')
            .replace(/\+/g, '')

        if (normalizedPhone.startsWith('233')) {
            normalizedPhone = '0' + normalizedPhone.slice(3)
        }

        const url = `${MNOTIFY_BASE_URL}?key=${apiKey}`
        
        const payload = {
            recipient: [normalizedPhone],
            sender: options.sender || defaultSender,
            message: options.message,
            is_schedule: false,
            schedule_date: ''
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })

        const responseText = await response.text()
        let data: any
        try {
            data = JSON.parse(responseText)
        } catch (e) {
            console.error('[SMS Service] mNotify JSON parse error:', responseText)
            return { success: false, error: 'Invalid mNotify response' }
        }

        if (data.status === "success" || data.code === "2000") {
            return { success: true, messageId: data.summary?._id || 'mNotify_sent' }
        } else {
            console.error('[SMS Service] mNotify API Error:', data.message || data.error || responseText)
            return { success: false, error: data.message || data.error || 'mNotify API Error' }
        }
    } catch (error: any) {
        console.error('[SMS Service] mNotify Exception:', error.message)
        return { success: false, error: `System error: ${error.message}` }
    }
}

// ==========================================

// SPECIFIC SMS FUNCTIONS
// ==========================================

/**
 * Single source of truth for the order-success SMS template. Exported so
 * credit-metered callers (lib/sms-confirmation-sender.ts) can size segments
 * on the EXACT text this service will send — the two must never drift.
 */
export function buildOrderSuccessMessage(size: string): string {
    return `Your ${size} order has been confirmed and is now processing. Delivery expected very soon. Thank you for your order!`
}

/**
 * Send order success SMS to account holder
 */
export async function sendOrderSuccessSMS(
    accountHolderPhone: string,
    details: {
        network: string
        size: string
        price: number
        recipientNumber: string
        currentBalance: number
        sender?: string
    }
) {
    const message = buildOrderSuccessMessage(details.size)

    // ROUTE: Moolre (Temporary fallback)
    return sendSMS({
        recipient: details.recipientNumber,
        message,
        sender: details.sender
    })
}

/**
 * Send status update SMS
 */
export async function sendStatusUpdateSMS(
    phoneNumber: string,
    details: {
        referenceCode: string
        status: string
    }
) {
    // DISABLED AS REQUESTED
    /*
    const message = `Order Update: Your order ${details.referenceCode} is now ${details.status.toUpperCase()}. Check your dashboard for details.`

    return sendSMS({
        recipient: phoneNumber,
        message
    })
    */
    return { success: true, messageId: 'disabled', error: undefined } // Mock success to prevent errors
}

/**
 * Send wallet top-up success SMS
 */
export async function sendWalletTopupSuccessSMS(
    phoneNumber: string,
    details: {
        amount: number
        newBalance: number
    }
) {
    const message = `Your top-up was successful! GHS ${details.amount.toFixed(2)} has been added to your Flexy-Wallet. New balance: GHS ${details.newBalance.toFixed(2)}. Thank you!`

    // ROUTE: Moolre
    return sendSMS({
        recipient: phoneNumber,
        message
    })
}

/**
 * Send welcome SMS to new users
 * Optimized for MTN delivery - uses stealth keywords to bypass content filters
 */
export async function sendWelcomeSMS(
    phoneNumber: string,
    firstName: string
) {
    // DISABLED AS REQUESTED
    /*
    const message = `Hello! Welcome to KiNG FLEXY GH. All we do here is instant Delivery (PA-TU-PA) start ordering your package now. Chat us on WhatsApp:578065809`

    return sendSMS({
        recipient: phoneNumber,
        message
    })
    */
    return { success: true, messageId: 'disabled', error: undefined }
}
/**
 * Send Agent upgrade success SMS
 */
/**
 * Send Agent upgrade success SMS
 * Updated Template: "Congratulations! Your Agent membership has been upgraded until [Remaining_days]"
 */
export async function sendAgentUpgradeSuccessSMS(
    phoneNumber: string,
    firstName: string,
    planDays: string,
    remainingDays: number,
    expiryDate: string
) {
    const message = `Congratulations ${firstName}! Your Agent membership is now active for ${planDays}, giving you access to our lowest Agent prices. Login to start ordering!`

    // ROUTE: Moolre (Temporary fallback)
    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Send SMS notification when an agent upgrades to the permanent plan
 */
export async function sendPermanentAgentUpgradeSuccessSMS(
    phoneNumber: string
) {
    const message = `Congratulations! Your Agent membership is now PERMANENT, giving you lifetime access to our best Agent benefits and pricing. Thank you!`

    // ROUTE: Moolre (Temporary fallback)
    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Send Agent Extend/Renewal Success SMS
 * Template: "Congratulations! Your Agent membership has been extended until [Formatted_Date]"
 */
export async function sendAgentExtensionSuccessSMS(
    phoneNumber: string,
    expiryDate: string | Date
) {
    const date = new Date(expiryDate)
    const day = date.getDate()
    const month = date.toLocaleString('default', { month: 'long' })
    const year = date.getFullYear()

    const suffix = ["th", "st", "nd", "rd"][((day % 100) > 10 && (day % 100) < 20) ? 0 : (day % 10 < 4) ? day % 10 : 0]

    const formattedDate = `${month} ${day}${suffix}, ${year}`

    const message = `Your Agent membership has been successfully extended until ${formattedDate}. Thank you for staying with us!`

    // ROUTE: Moolre (Temporary fallback)
    return sendSMS({
        recipient: phoneNumber,
        message
    })
}

/**
 * Send Admin Alert for New Agent Order
 * Template: "NEW AGENT ORDER"
 */
export async function sendAdminAgentOrderAlert() {
    // DISABLED AS REQUESTED
    /*
    // Strictly use the requested number for agent orders: 0551617309
    const targetNumber = '0551617309'

    return sendSMS({
        recipient: targetNumber,
        message: 'NEW AGENT ORDER'
    })
    */
    return { success: true, messageId: 'disabled', error: undefined } // Mock success to prevent errors
}

/**
 * Send Dealer activation success SMS
 * Template mirrors agent activation — "activated for 6 months, expires [date]"
 */
export async function sendDealerActivationSuccessSMS(
    phoneNumber: string,
    firstName: string,
    expiryDate: string | Date
) {
    const date = new Date(expiryDate)
    const day = date.getDate()
    const month = date.toLocaleString('default', { month: 'long' })
    const year = date.getFullYear()
    const suffix = ['th', 'st', 'nd', 'rd'][((day % 100) > 10 && (day % 100) < 20) ? 0 : (day % 10 < 4) ? day % 10 : 0]
    const formattedDate = `${month} ${day}${suffix}, ${year}`

    const message = `Congratulations ${firstName}! Your Dealer membership is now active for 6 months, until ${formattedDate}. Login to start ordering!`

    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Send Dealer extension/renewal success SMS
 * Template mirrors agent extension — "extended until [date]"
 */
export async function sendDealerExtensionSuccessSMS(
    phoneNumber: string,
    expiryDate: string | Date
) {
    const date = new Date(expiryDate)
    const day = date.getDate()
    const month = date.toLocaleString('default', { month: 'long' })
    const year = date.getFullYear()
    const suffix = ['th', 'st', 'nd', 'rd'][((day % 100) > 10 && (day % 100) < 20) ? 0 : (day % 10 < 4) ? day % 10 : 0]
    const formattedDate = `${month} ${day}${suffix}, ${year}`

    const message = `Your Dealer membership has been successfully extended until ${formattedDate}. Thank you for staying with us!`

    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Send Agent renewal reminder SMS (less than 48 hours left)
 */
export async function sendAgentRenewalReminderSMS(
    phoneNumber: string,
    firstName: string
) {
    const message = `Hi ${firstName}, your Agent plan expires in under 48hrs. Enable Auto-Upgrade in Settings so your Flexy-Wallet covers renewal, or renew at kingflexygh.com`

    return sendSMS({
        recipient: phoneNumber,
        message
    })
}

/**
 * Send Dealer renewal reminder SMS (less than 48 hours left)
 */
export async function sendDealerRenewalReminderSMS(
    phoneNumber: string,
    firstName: string
) {
    const message = `Hi ${firstName}, your Dealer plan expires in under 48hrs. Enable Auto-Upgrade in Settings so your Flexy-Wallet covers renewal, or renew at kingflexygh.com`

    return sendSMS({
        recipient: phoneNumber,
        message
    })
}

/**
 * Send SMS notification when agent subscription expires
 */
export async function sendAgentExpiryNotificationSMS(
    phoneNumber: string,
    firstName: string
) {
    const message = `Hi ${firstName}, your Agent membership has expired. You can renew anytime from your dashboard to continue enjoying Agent prices. Thank you!`

    // ROUTE: Moolre
    return sendSMS({
        recipient: phoneNumber,
        message
    })
}

/**
 * Send SMS notification when an order is refunded
 */
export async function sendOrderRefundSMS(
    phoneNumber: string,
    recipientNumber: string,
    refundAmount: number,
    newBalance: number
) {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

/**
 * Refund of a shop (storefront/USSD) order settles to the SHOP OWNER's wallet, not the
 * guest's — so without this, the guest beneficiary has no way to know their order was
 * refunded at all. Tells them to message the seller directly to actually receive it, with
 * a 6hr WhatsApp escalation to us as a last resort. Kept at/under 160 chars, no emojis
 * (single SMS segment). `network` is accepted (and still required by the caller's gating
 * check in lib/refund-service.ts) but deliberately NOT interpolated into the text — the
 * SMS goes straight to the beneficiary, who already knows their own network.
 *
 * WORDING: leads with "Your {size} wasn't completed; refunded" — not "was refunded" — so
 * guests don't read the SMS as "money already in hand." Says "WhatsApp (not a call)
 * <number> to receive", never "Contact <number>": the old copy read as a number to dial,
 * and guests were calling sellers and WhatsApp'ing support instead, the exact opposite of
 * what we want. Naming the action before the number, and saying "not a call" right next to
 * it, is what stops the calls (2026-09-24: escalation window also tightened 24h -> 6h so
 * the "report it" path fires sooner for guests who never hear back from the seller).
 *
 * LENGTH: an SMS over 160 chars silently splits into two BILLED segments, on every
 * refund, forever — so wording is bounded, not free. Current worst realistic case —
 * Telecel + "GHS 500.00 Mashup Bundle" + a +233 number — is 153 chars.
 * scripts/test-refund-sms-copy.ts enforces the ceiling; run it before adding any word.
 */
export function buildShopGuestRefundMessage(details: {
    network: string
    size: string
    ownerPhone: string
}): string {
    return `Your ${details.size} wasn't completed; refunded. WhatsApp (not a call) ${details.ownerPhone} to receive. Not resolved in 6h? Report: WhatsApp 0578065809`
}

/**
 * AFA sibling of buildShopGuestRefundMessage — same WhatsApp-not-a-call wording,
 * same 160-char discipline, no size (an AFA order has none). See that function's
 * doc comment for the full rationale; nothing here deviates from it.
 */
export function buildAfaGuestRefundMessage(details: {
    ownerPhone: string
}): string {
    return `Your AFA registration wasn't completed; refunded. WhatsApp (not a call) ${details.ownerPhone} to receive. Not resolved in 6h? Report: WhatsApp 0578065809`
}

export async function sendShopGuestRefundSMS(
    recipientNumber: string,
    details: {
        network: string
        size: string
        ownerPhone: string
    }
) {
    const message = buildShopGuestRefundMessage(details)

    return sendSMS({
        recipient: recipientNumber,
        message,
    })
}

// ==========================================
// SHOP ALERT SMS FUNCTIONS
// ==========================================

/**
 * Alert 3 · Pricing Approved — SMS to shop owner
 */
export async function sendShopPricingApprovedSMS(
    phoneNumber: string,
    firstName: string
) {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

/**
 * Alert 4 · Pricing Rejected — SMS to shop owner
 */
export async function sendShopPricingRejectedSMS(
    phoneNumber: string,
    firstName: string,
    reason: string
) {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

/**
 * Alert 5 · Shop Profile Approved — SMS to shop owner
 */
export async function sendShopProfileApprovedSMS(
    phoneNumber: string,
    shopName: string
) {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

/**
 * Alert 6 · Shop Profile Rejected — SMS to shop owner
 */
export async function sendShopProfileRejectedSMS(
    phoneNumber: string,
    firstName: string,
    reason: string
) {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

/**
 * Alert 7 · Withdrawal Processed (Paid) — SMS to shop owner
 */
export async function sendShopWithdrawalProcessedSMS(
    phoneNumber: string,
    firstName: string,
    netAmount: number,
    network: string,
    momoNumber: string
) {
    const isBank = ['BANK', 'BANK TRANSFER', 'FIDELITY', 'ECOBANK', 'GCB'].includes(network.toUpperCase())
    const accountType = isBank ? 'Bank' : 'MoMo'

    const message = `Hi ${firstName}, your Net Payout of GHS ${netAmount.toFixed(2)} has been sent to your ${accountType} number ${momoNumber}. Thank you!`

    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Alert 7b · Withdrawal Rejected — SMS to shop owner
 */
export async function sendShopWithdrawalRejectedSMS(
    phoneNumber: string,
    firstName: string
) {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

// ==========================================
// AIRTIME FUNCTIONS
// ==========================================

/**
 * Send beneficiary confirmation SMS when airtime order is placed
 * Triggered immediately after successful wallet deduction
 */
export async function sendAirtimeBeneficiarySMS(
    beneficiaryPhone: string,
    airtimeAmount: number
): Promise<SMSResult> {
    // DISABLED AS REQUESTED
    return { success: true, messageId: 'disabled', error: undefined }
}

/**
 * Send admin alert when a new airtime or mashup order is placed (both shop and main site)
 * Sent only to admins, excluding sub-admins.
 * For mashup orders: title changes to "NEW MASHUP ORDER" and short preference code is appended
 * (B Focus / D Focus / V Focus) to avoid SMS carrier content filtering.
 */
export async function sendAdminAirtimeAlertSMS(
    adminPhones: string[],
    details: {
        source: string
        receiver: string
        amount: number | string
        network: string
        type?: 'airtime' | 'mashup'
        bundle_preference?: 'balanced' | 'data' | 'voice' | null
    }
): Promise<void> {
    const amountNum = typeof details.amount === 'string' ? parseFloat(details.amount) : details.amount;
    const isMashup = details.type === 'mashup'
    
    let networkInitial = details.network.charAt(0).toUpperCase()
    const netUpper = details.network.toUpperCase()
    if (netUpper.includes('MTN')) networkInitial = 'M'
    else if (netUpper.includes('TELECEL') || netUpper.includes('VODA')) networkInitial = 'T'
    else if (netUpper.includes('AIRTEL') || netUpper === 'AT') networkInitial = 'A'

    // Short preference abbreviation for mashup to avoid SMS flag/block
    let prefLine = ''
    if (isMashup && details.bundle_preference) {
        const prefMap: Record<string, string> = {
            balanced: 'B Focus',
            data: 'D Focus',
            voice: 'V Focus',
        }
        prefLine = `\nPref: ${prefMap[details.bundle_preference] || 'B Focus'}`
    }

    const orderLabel = isMashup ? 'NEW MASHUP ORDER' : 'NEW AIRTIME ORDER'

    const message = `${orderLabel}:\nSource : ${details.source}\nReceiver : ${details.receiver}\nAmount: GH ${amountNum.toFixed(2)}\nNet: ${networkInitial}${prefLine}`

    // Send to all provided admins in parallel
    const promises = adminPhones.map(phone => sendSMS({ recipient: phone, message }))
    await Promise.allSettled(promises)
}

/**
 * Send alert when a main site or shop airtime order is marked as completed
 */
export async function sendAirtimeCompletedSMS(
    beneficiaryPhone: string,
    details: {
        amount: number
        sender?: string
    }
): Promise<void> {
    const message = `Your airtime top-up of GHS ${details.amount.toFixed(2)} has been credited successfully. Dial *124# to check your balance. Thank you!`

    await sendSMS({
        recipient: beneficiaryPhone,
        message,
        sender: details.sender
    })
}

/**
 * Send alert when a main site or shop mashup order is marked as completed.
 * Uses the MTN Mashup shortcode *567*1*6# instead of the standard airtime *124#.
 */
export async function sendMashupCompletedSMS(
    beneficiaryPhone: string,
    details: {
        amount: number
        sender?: string
    }
): Promise<void> {
    const message = `Your mashup order of GHS ${details.amount.toFixed(2)} has been credited successfully. Dial *567*1*6# to check your balance. Thank you!`

    await sendSMS({
        recipient: beneficiaryPhone,
        message,
        sender: details.sender
    })
}

// ==========================================
// RESULTS CHECKER FUNCTIONS
// ==========================================

/**
 * Send voucher delivery SMS to customer after RC purchase.
 * Single voucher: compact format. Multiple: numbered list.
 */
export async function sendResultsCheckerDeliverySMS(
    phoneNumber: string,
    details: {
        typeName: string
        quantity: number
        vouchers: Array<{ pin: string; serial_number: string }>
        referenceCode: string
        sender?: string
    }
): Promise<SMSResult> {
    const { typeName, quantity, vouchers, sender } = details

    const upperTypeName = typeName.toUpperCase()
    let url = 'Please contact your exam board on how to print your results.'
    if (upperTypeName.includes('BECE')) {
        url = 'eresults.waecgh.org'
    } else if (upperTypeName.includes('WAEC') || upperTypeName.includes('WASSCE')) {
        url = 'ghana.waecdirect.org'
    }

    if (quantity === 1 && vouchers.length === 1) {
        const v = vouchers[0]
        const message = `Your ${typeName} PIN is ready!\nPIN: ${v.pin}\nSerial: ${v.serial_number}\n\nPlease visit ${url} to print your results.`
        return sendSMS({ recipient: phoneNumber, message, sender })
    }

    const voucherLines = vouchers
        .map((v) => `PIN: ${v.pin}\nSerial: ${v.serial_number}`)
        .join('\n\n')

    const message = `Your ${quantity}x ${typeName} vouchers:\n\n${voucherLines}\n\nPlease visit ${url} to print your results.`
    return sendSMS({ recipient: phoneNumber, message, sender })
}

/**
 * Send admin alert when a new RC order is placed.
 */
export async function sendAdminRCOrderAlertSMS(
    adminPhones: string[],
    details: {
        quantity: number
        typeName: string
        referenceCode: string
        source: string
        totalPaid: number
    }
): Promise<void> {
    const { quantity, typeName, referenceCode, source, totalPaid } = details
    const message = `NEW RC ORDER:\nType: ${typeName}\nQty: ${quantity}\nTotal: GH${totalPaid.toFixed(2)}\nSource: ${source}\nRef: ${referenceCode}`
    const promises = adminPhones.map(phone => sendSMS({ recipient: phone, message }))
    await Promise.allSettled(promises)
}

// ==========================================
// AUTO-UPGRADE SMS FUNCTIONS
// ==========================================

/**
 * Send SMS when auto-upgrade succeeds — wallet had sufficient funds.
 * Template: "Hi [Name]! Your [plan] was auto-renewed from your Flexy-Wallet.
 *            Active until [date]. Balance: GHS[balance]."
 */
export async function sendAutoUpgradeSuccessSMS(
    phoneNumber: string,
    firstName: string,
    planLabel: string,
    expiryDate: Date,
    newBalance: number
): Promise<SMSResult> {
    const day = expiryDate.getDate()
    const month = expiryDate.toLocaleString('default', { month: 'long' })
    const year = expiryDate.getFullYear()
    const suffix = ['th', 'st', 'nd', 'rd'][
        (day % 100 > 10 && day % 100 < 20) ? 0 : (day % 10 < 4 ? day % 10 : 0)
    ]
    const formattedDate = `${month} ${day}${suffix}, ${year}`

    const message = `Hi ${firstName}! Your ${planLabel} was auto-renewed from your Flexy-Wallet. Active until ${formattedDate}. Balance: GHS ${newBalance.toFixed(2)}.`

    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Send SMS when auto-upgrade FAILS due to insufficient wallet balance.
 * Template: "Hi [Name], auto-renewal for [plan] failed. Flexy-Wallet: GHS[balance],
 *            needed GHS[required]. Top up to continue: kingflexygh.com"
 */
export async function sendAutoUpgradeFailedSMS(
    phoneNumber: string,
    firstName: string,
    planLabel: string,
    currentBalance: number,
    requiredAmount: number
): Promise<SMSResult> {
    const shortfall = (requiredAmount - currentBalance).toFixed(2)

    const message = `Hi ${firstName}, auto-renewal for your ${planLabel} failed. Flexy-Wallet: GHS ${currentBalance.toFixed(2)}, needed GHS ${requiredAmount.toFixed(2)}. Top up to continue: kingflexygh.com`

    return sendSMS({ recipient: phoneNumber, message })
}

/**
 * Send a 6-digit OTP to a phone number for signup phone verification.
 * Called by /api/auth/verify-phone before account creation.
 */
export async function sendPhoneOTPSms(
    phoneNumber: string,
    otpCode: string
): Promise<SMSResult> {
    const message = `Your verification code is ${otpCode}. It is valid for 10 minutes. Please do not share this code with anyone.`
    return sendSMS({ recipient: phoneNumber, message })
}
