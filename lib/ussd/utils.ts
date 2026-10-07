import { createHmac, timingSafeEqual } from 'crypto'
import type { HubtelResponse, CartItem, USSDState } from './types'

// =============================================================================
// Phone helpers
// =============================================================================

/** Convert Hubtel's 233XXXXXXXXX → 0XXXXXXXXX for DB lookups */
export function normalizePhone(mobile: string): string {
    // P2-6: canonical 0XXXXXXXXX. Strip spaces and a leading '+' first so that
    // '+233...', '233...' and '0...' all normalise to the same DB-lookup form
    // (prevents duplicate ussd_customers / blacklist misses across formats).
    const clean = mobile.replace(/\s+/g, '').replace(/^\+/, '')
    if (clean.startsWith('233') && clean.length === 12) {
        return '0' + clean.slice(3)
    }
    return clean
}

/** Convert 0XXXXXXXXX → 233XXXXXXXXX for Hubtel / SMS APIs */
export function toHubtelPhone(phone: string): string {
    const clean = phone.replace(/\s+/g, '').replace(/^\+/, '')
    if (clean.startsWith('0') && clean.length === 10) {
        return '233' + clean.slice(1)
    }
    return clean
}

/** Validate Ghana phone (0XXXXXXXXX or 233XXXXXXXXX, with optional +) */
export function isValidGhanaPhone(phone: string): boolean {
    const clean = phone.replace(/\s+/g, '').replace(/^\+/, '')
    return /^(0\d{9}|233\d{9})$/.test(clean)
}

// =============================================================================
// Formatting
// =============================================================================

/** Format a number as GHS with 2 decimal places */
export function formatGHS(amount: number): string {
    return `GHS ${amount.toFixed(2)}`
}

/** Truncate a message to USSD safe length (182 chars max) */
export function truncate(text: string, maxLen = 182): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

/**
 * Short, opaque order code for the Hubtel AddToCart `ItemName`.
 *
 * WHY THIS EXISTS: `Item.ItemName` is the ONLY free-text field we control on the
 * USSD checkout rail, and Hubtel republishes it verbatim as the `description`
 * column on the merchant dashboard, in the settlement CSV, and on the public
 * (unauthenticated) `r.hbtl.co/p/<id>` customer receipt. Product-descriptive
 * values there are what Hubtel's financial-monitoring team screens on when
 * suspending merchants for reselling data, and any PII we put there (recipient
 * MSISDN, applicant name) lands on that public receipt URL. So ItemName must
 * stay neutral: no product words, no phone numbers, no names.
 *
 * NOTE: `ItemName` is never read back — fulfillment resolves purely by
 * SessionId -> ussd_pending_orders.order_payload (see app/api/ussd/fulfill),
 * and HubtelFulfillment.OrderInfo.Items[].Name is ignored — so this value is
 * cosmetic to us and carries no reconciliation weight.
 *
 * The code is the first 6 alphanumerics of Hubtel's own SessionId, uppercased,
 * so support can trace a receipt back with
 * `select * from ussd_pending_orders where session_id ilike '<code>%'`.
 */
export function orderCode(sessionId: string): string {
    const cleaned = (sessionId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
    return (cleaned + '000000').slice(0, 6)
}

// =============================================================================
// Response builders
// =============================================================================

/** Build a mid-session response (prompts user for next input) */
export function respond(
    sessionId: string,
    message: string,
    state: USSDState,
    label = '',
    fieldType: HubtelResponse['FieldType'] = 'text',
): HubtelResponse {
    return {
        SessionId: sessionId,
        Type: 'response',
        Message: truncate(message),
        Label: label || message.split('\n')[0],
        ClientState: encodeState(state),
        DataType: 'input',
        FieldType: fieldType,
    }
}

/** Build a session-ending release response */
export function release(sessionId: string, message: string): HubtelResponse {
    return {
        SessionId: sessionId,
        Type: 'release',
        Message: truncate(message),
        Label: message.split('\n')[0],
        DataType: 'display',
        FieldType: 'text',
    }
}

/** Build an AddToCart response (triggers Hubtel MoMo payment) */
export function addToCart(
    sessionId: string,
    message: string,
    item: CartItem,
    state?: USSDState,
): HubtelResponse {
    return {
        SessionId: sessionId,
        Type: 'AddToCart',
        Message: truncate(message),
        Label: message.split('\n')[0],
        DataType: 'display',
        FieldType: 'text',
        ClientState: state ? encodeState(state) : undefined,
        Item: item,
    }
}

// =============================================================================
// State helpers
// =============================================================================

/**
 * Encode USSDState into a signed ClientState string sent to Hubtel.
 *
 * Format (when USSD_STATE_SECRET is set):
 *   <base64url(JSON)>.<HMAC-SHA256-first-32-hex-chars>
 *
 * Without the secret (dev / CI without env var): plain base64url, no sig.
 * SEC-011: Production fails CLOSED — a missing secret throws instead of
 * emitting an unsigned (forgeable) ClientState.
 */
export function encodeState(state: USSDState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
    const secret = process.env.USSD_STATE_SECRET
    if (!secret) {
        // SEC-011: never emit unsigned state in production — fail closed.
        if (process.env.NODE_ENV === 'production') {
            throw new Error('[USSD] USSD_STATE_SECRET not set — refusing to emit unsigned ClientState in production.')
        }
        return payload
    }
    const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
    const encoded = `${payload}.${sig}`
    // P1-3: Hubtel truncates oversized ClientState, which then fails HMAC verify
    // and silently resets the session to the main menu (losing an in-progress
    // order). Warn loudly near that limit so it is visible in logs; the deeper
    // fix is to persist large in-progress state server-side keyed by SessionId.
    if (encoded.length > 1500) {
        console.warn(`[USSD] ClientState is ${encoded.length} chars (keys: ${Object.keys(state).join(',')}) — risks Hubtel truncation + session reset.`)
    }
    return encoded
}

/**
 * Decode and verify a ClientState string received from Hubtel.
 *
 * When USSD_STATE_SECRET is set: verifies HMAC using constant-time comparison.
 * Any signature mismatch or missing signature returns { step: 'main' },
 * forcing the session to restart safely from the main menu.
 *
 * SEC-011: Production fails CLOSED — unsigned/plain input (and a missing
 * secret) is never trusted; it resets to { step: 'main' }. Dev/test stays
 * permissive and accepts both signed (strips sig) and legacy plain JSON.
 */
export function decodeState(raw: string): USSDState {
    if (!raw) return { step: 'main' }
    const isProduction = process.env.NODE_ENV === 'production'
    try {
        const secret = process.env.USSD_STATE_SECRET

        if (!secret) {
            // SEC-011: in production a missing secret must not trust any input.
            if (isProduction) {
                console.error('[USSD] USSD_STATE_SECRET not set — rejecting ClientState in production.')
                return { step: 'main' }
            }
            // Dev / unconfigured — accept both formats
            if (raw.startsWith('{')) {
                // Legacy unsigned plain JSON (pre-signing)
                return JSON.parse(raw) as USSDState
            }
            const lastDot = raw.lastIndexOf('.')
            const payload = lastDot === -1 ? raw : raw.slice(0, lastDot)
            return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as USSDState
        }

        // SEC-011: reject plain/unsigned JSON in production even when a secret
        // is set — only a valid HMAC-signed payload may be trusted.
        if (isProduction && raw.startsWith('{')) {
            console.warn('[USSD] ClientState is unsigned plain JSON — rejecting')
            return { step: 'main' }
        }

        // Signed format: <base64url>.<32-hex-HMAC>
        const lastDot = raw.lastIndexOf('.')
        if (lastDot === -1) {
            console.warn('[USSD] ClientState missing signature — rejecting')
            return { step: 'main' }
        }

        const payload = raw.slice(0, lastDot)
        const sig     = raw.slice(lastDot + 1)

        if (sig.length !== 32) {
            console.warn('[USSD] ClientState signature length invalid — rejecting')
            return { step: 'main' }
        }

        const expected = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)

        // Constant-time comparison to prevent timing attacks
        if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
            console.warn('[USSD] ClientState signature mismatch — rejecting')
            return { step: 'main' }
        }

        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as USSDState
    } catch {
        return { step: 'main' }
    }
}
