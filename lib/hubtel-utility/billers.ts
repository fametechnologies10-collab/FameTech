/**
 * Utility Bills (Hubtel Commission Services: ECG / Ghana Water / DSTV / GOtv /
 * StarTimes) — biller registry + canonical account-query parser.
 *
 * Pure logic only: NO database, NO fetch, NO env access except `serviceIdFor`
 * reading `process.env`. Every export name here is contractual — later tasks
 * (HTTP client, dispatch pipeline, webhook, API routes, USSD) import these
 * exact names, so do not rename/remove without updating every caller.
 *
 * Hubtel's account-query responses are messy in practice: leading/trailing
 * spaces on `Display`/`Value`, inconsistent key casing across billers, and
 * per-biller row shapes. `parseAccountQuery` is the single place that mess
 * gets normalized — it must never throw on malformed provider data.
 */

import crypto from 'crypto'

export type UtilityBiller = 'ecg' | 'ghana_water' | 'dstv' | 'gotv' | 'startimes'

export interface BillerDef {
    key: UtilityBiller
    label: string // "ECG Prepaid & Postpaid" | "Ghana Water" | "DSTV" | "GOtv" | "StarTimes TV"
    serviceIdEnv: string // env var name holding the Hubtel ServiceID override
    serviceIdDefault: string // GUID fallback from Hubtel docs
    accountLabel: string // "Meter number" (ecg, ghana_water) | "Smartcard number" (dstv, gotv) | "Account number" (startimes)
    queryBy: 'phone' | 'account' // ecg: 'phone' (query lists meters linked to a phone); all others: 'account'
    queryNeedsMobile: boolean // ghana_water: true (query REQUIRES &mobile=<phone>); others false
    payDestination: 'phone' | 'account' // ecg: 'phone'; ghana_water: 'phone' (per Hubtel doc SAMPLE — table contradicts; flag kept per-biller so ops can flip); dstv/gotv/startimes: 'account'
    extradata: 'none' | 'meter' | 'ghana_water' // ecg: 'meter' ({bundle: meterNumber}); ghana_water: 'ghana_water' ({bundle, Email, SessionId}); tv: 'none'
    linksPhoneToAccount: boolean // ecg: true (top-up links phone<->meter; UI must warn)
    hasAmountDue: boolean // startimes: false (query returns Bouquet, no amountDue); others true
}

export const UTILITY_BILLERS: Record<UtilityBiller, BillerDef> = {
    ecg: {
        key: 'ecg',
        label: 'ECG Prepaid & Postpaid',
        serviceIdEnv: 'HUBTEL_UTILITY_SERVICEID_ECG',
        serviceIdDefault: 'e6d6bac062b5499cb1ece1ac3d742a84',
        accountLabel: 'Meter number',
        queryBy: 'phone',
        queryNeedsMobile: false,
        payDestination: 'phone',
        extradata: 'meter',
        linksPhoneToAccount: true,
        hasAmountDue: true,
    },
    ghana_water: {
        key: 'ghana_water',
        label: 'Ghana Water',
        serviceIdEnv: 'HUBTEL_UTILITY_SERVICEID_GHANA_WATER',
        serviceIdDefault: '6c1e8a82d2e84feeb8bfd6be2790d71d',
        accountLabel: 'Meter number',
        queryBy: 'account',
        queryNeedsMobile: true,
        payDestination: 'phone',
        extradata: 'ghana_water',
        linksPhoneToAccount: false,
        hasAmountDue: true,
    },
    dstv: {
        key: 'dstv',
        label: 'DSTV',
        serviceIdEnv: 'HUBTEL_UTILITY_SERVICEID_DSTV',
        serviceIdDefault: '297a96656b5846ad8b00d5d41b256ea7',
        accountLabel: 'Smartcard number',
        queryBy: 'account',
        queryNeedsMobile: false,
        payDestination: 'account',
        extradata: 'none',
        linksPhoneToAccount: false,
        hasAmountDue: true,
    },
    gotv: {
        key: 'gotv',
        label: 'GOtv',
        serviceIdEnv: 'HUBTEL_UTILITY_SERVICEID_GOTV',
        serviceIdDefault: 'e6ceac7f3880435cb30b048e9617eb41',
        accountLabel: 'Smartcard number',
        queryBy: 'account',
        queryNeedsMobile: false,
        payDestination: 'account',
        extradata: 'none',
        linksPhoneToAccount: false,
        hasAmountDue: true,
    },
    startimes: {
        key: 'startimes',
        label: 'StarTimes TV',
        serviceIdEnv: 'HUBTEL_UTILITY_SERVICEID_STARTIMES',
        serviceIdDefault: '6598652d34ea4112949c93c079c501ce',
        accountLabel: 'Account number',
        queryBy: 'account',
        queryNeedsMobile: false,
        payDestination: 'account',
        extradata: 'none',
        linksPhoneToAccount: false,
        hasAmountDue: false,
    },
}

// Stable order — surfaces (admin panels, USSD menus) enumerate billers via this array.
export const UTILITY_BILLER_KEYS: UtilityBiller[] = ['ecg', 'ghana_water', 'dstv', 'gotv', 'startimes']

export function isUtilityBiller(x: unknown): x is UtilityBiller {
    return typeof x === 'string' && (UTILITY_BILLER_KEYS as string[]).includes(x)
}

export function serviceIdFor(biller: UtilityBiller): string {
    const def = UTILITY_BILLERS[biller]
    const envValue = process.env[def.serviceIdEnv]
    const trimmed = envValue?.trim()
    return trimmed ? trimmed : def.serviceIdDefault
}

export interface UtilityMeter {
    name: string
    meterNumber: string
    outstanding: number
}

export interface UtilityAccountInfo {
    accountName: string | null
    accountNumber: string | null
    amountDue: number | null // negative = customer credit balance
    bouquet: string | null // startimes only
    sessionId: string | null // ghana_water only — unique per query, REQUIRED for GW pay
    meters: UtilityMeter[] // ecg only; empty array otherwise
    raw: Array<{ Display: string; Value: string; Amount: number }>
}

function emptyAccountInfo(): UtilityAccountInfo {
    return {
        accountName: null,
        accountNumber: null,
        amountDue: null,
        bouquet: null,
        sessionId: null,
        meters: [],
        raw: [],
    }
}

/** Coerce a Hubtel `Display`/`Value` field to a trimmed string, tolerating any input. */
function toStr(v: unknown): string {
    if (v === null || v === undefined) return ''
    return String(v).trim()
}

/** Coerce a Hubtel `Amount` field to a finite number, defaulting to 0 for garbage. */
function toAmount(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        if (Number.isFinite(n)) return n
    }
    return 0
}

/** Parse a trimmed string as a finite number, or null if it isn't numeric. */
function parseNumericOrNull(s: string): number | null {
    if (s.trim() === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
}

/**
 * Normalize Hubtel's `Data` array from an account-query response into a
 * canonical shape. Never throws — malformed input yields empty/null fields.
 */
export function parseAccountQuery(biller: UtilityBiller, data: unknown): UtilityAccountInfo {
    if (!Array.isArray(data)) return emptyAccountInfo()

    const raw: Array<{ Display: string; Value: string; Amount: number }> = []
    for (const row of data) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
        const r = row as Record<string, unknown>
        raw.push({
            Display: toStr(r.Display),
            Value: toStr(r.Value),
            Amount: toAmount(r.Amount),
        })
    }

    const info = emptyAccountInfo()
    info.raw = raw

    // ECG special case: every row is a meter, regardless of Display content.
    if (biller === 'ecg') {
        for (const row of raw) {
            const idx = row.Display.lastIndexOf(' (')
            const name = idx >= 0 ? row.Display.slice(0, idx).trim() : row.Display
            info.meters.push({ name, meterNumber: row.Value, outstanding: row.Amount })
        }
        return info
    }

    for (const row of raw) {
        const key = row.Display.toLowerCase()
        switch (key) {
            case 'name':
                info.accountName = row.Value.length > 0 ? row.Value : null
                break
            case 'amountdue': {
                const numeric = parseNumericOrNull(row.Value)
                info.amountDue = numeric !== null ? numeric : row.Amount
                break
            }
            case 'account':
            case 'account number':
                info.accountNumber = row.Value.length > 0 ? row.Value : null
                break
            case 'bouquet':
                info.bouquet = row.Value.length > 0 ? row.Value : null
                break
            case 'sessionid':
                info.sessionId = row.Value.length > 0 ? row.Value : null
                break
            default:
                break
        }
    }

    return info
}

/**
 * Strip Ghana Water's `sessionId` (unique per query, must NEVER reach any client — the
 * dispatch pipeline always re-queries a fresh session at pay-time in
 * lib/hubtel-utility/service.ts, so nothing downstream needs the one returned by a lookup)
 * from a parsed `UtilityAccountInfo` before it is sent to a client. Scrubs both the parsed
 * `sessionId` field AND any raw provider row whose `Display` (case-insensitive) is
 * "sessionid" — Hubtel echoes the session back through BOTH places. Every other biller's
 * info passes through unchanged (their raw rows never carry a sessionId row, so the filter
 * is a no-op for them). Shared by the dashboard lookup route (app/api/utilities/lookup)
 * and the storefront guest lookup route (app/api/shop/utility/lookup) so both surfaces
 * scrub identically.
 */
export function sanitizeAccountInfoForClient(info: UtilityAccountInfo): UtilityAccountInfo {
    return {
        ...info,
        sessionId: null,
        raw: info.raw.filter((row) => row.Display.toLowerCase() !== 'sessionid'),
    }
}

/**
 * Compute a partner's share of a Hubtel commission payout.
 * pct is clamped to 0..100; commission must be a finite positive number or
 * the result is 0. Rounded to 4 decimal places (matches Hubtel's cedi/pesewa
 * precision seen in real commission payloads).
 */
export function computePartnerShare(commission: number, pct: number): number {
    if (typeof commission !== 'number' || !Number.isFinite(commission) || commission <= 0) return 0

    const clampedPct = Math.min(100, Math.max(0, pct))
    if (!Number.isFinite(clampedPct)) return 0

    return Math.round(((commission * clampedPct) / 100) * 1e4) / 1e4
}

/** Generate a unique client reference for a utility-bill order, e.g. UTIL-ECG-a1b2c3d4e5f60718. */
export function makeUtilityReference(biller: UtilityBiller): string {
    const randomHex = crypto.randomBytes(8).toString('hex') // 16 lowercase hex chars (64 bits)
    return `UTIL-${biller.toUpperCase().replace(/_/g, '')}-${randomHex}`
}

// Distinct prefix for storefront utility orders paid via Paystack (as opposed to
// Hubtel Direct Receive Money's `UTIL-`) — deliberately does NOT start with
// "UTIL" so it can never match isUtilityReference() below (that check gates the
// Hubtel Commission Services webhook and USSD fulfillment lookups only).
export function makeUtilityPaystackReference(biller: UtilityBiller): string {
    const randomHex = crypto.randomBytes(8).toString('hex')
    return `UTLP-${biller.toUpperCase().replace(/_/g, '')}-${randomHex}`
}

export function isUtilityReference(ref: string): boolean {
    return typeof ref === 'string' && ref.startsWith('UTIL-')
}

// Transient reference for the pre-charge MoMo-number OTP verification step on the
// Hubtel Direct Pay rail (see lib/hubtel-receive/number-verification.ts's
// sendVerificationOtp/confirmVerificationOtp and app/api/shop/charge/submit-otp's
// UTLV- branch). Never becomes a real order — it identifies a phone_otp_verifications
// row, not a utility_orders row — so it deliberately carries no biller suffix and can
// never collide with isUtilityReference() (4th char 'V' vs 'I').
export function makeUtilityVerifyReference(): string {
    const randomHex = crypto.randomBytes(8).toString('hex')
    return `UTLV-${randomHex}`
}
