// lib/order-recipient.ts
// -----------------------------------------------------------------------------
// Server-side recipient validation shared by the wallet data-purchase routes
// (/api/orders/purchase and /api/orders/bulk-purchase).
//
// The dashboard validates all of this in the browser, but a direct API call
// skips the browser. Every check here exists because the server previously
// trusted the client for it:
//   * canonical form  — one stored/compared shape (0XXXXXXXXX) so blacklist,
//     whitelist and queue lookups can't be dodged by 233… / padded spacing
//   * network match   — an MTN bundle can't be sent to a Telecel number
//   * blacklist       — checked against every format an admin may have stored
//   * reference codes — a bounded charset so client-chosen idempotency keys
//     can't carry arbitrary payloads or LIKE wildcards
// Pure except findBlacklistedRecipients, which takes the caller's service-role
// client.
// -----------------------------------------------------------------------------
import { validateGhanaianPhone } from '@/lib/phone-validation'

/** Longest raw phone string we will even look at (digits + sane punctuation). */
const MAX_RAW_PHONE_LENGTH = 32

export type Carrier = 'MTN' | 'Telecel' | 'AirtelTigo'

export type RecipientCheck =
    | { ok: true; phone: string; carrier: Carrier }
    | { ok: false; error: string }

const BAD_FORMAT = 'Invalid phone number format. Use Ghana format: 0XXXXXXXXX or 233XXXXXXXXX'

/**
 * Validate and canonicalize a recipient number. `phone` is always the
 * 0XXXXXXXXX form — the only form that should be stored, sent to a supplier,
 * or used as a lookup key.
 */
export function normalizeRecipient(raw: unknown): RecipientCheck {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, error: 'Phone number is required' }
    }
    // Bound BEFORE any regex/replace work: a megabyte of whitespace is still
    // "valid" once whitespace is stripped, and would otherwise be stored verbatim.
    if (raw.length > MAX_RAW_PHONE_LENGTH) return { ok: false, error: BAD_FORMAT }

    const compact = raw.replace(/\s+/g, '')
    if (!/^(0\d{9}|233\d{9})$/.test(compact)) return { ok: false, error: BAD_FORMAT }

    const v = validateGhanaianPhone(compact)
    if (!v.isValid || !v.network) return { ok: false, error: v.error || BAD_FORMAT }
    return { ok: true, phone: v.normalizedNumber, carrier: v.network as Carrier }
}

/** Which carrier a package network is delivered on (both AT products → AirtelTigo). */
export function carrierForPackageNetwork(packageNetwork: string | null | undefined): string {
    const n = (packageNetwork || '').trim()
    return n === 'AT-iShare' || n === 'AT-BigTime' ? 'AirtelTigo' : n
}

/** True when the recipient's carrier matches the package's network. */
export function recipientMatchesPackage(carrier: string, packageNetwork: string | null | undefined): boolean {
    return carrier === carrierForPackageNetwork(packageNetwork)
}

/** Every spelling an admin may have stored a number under. */
export function blacklistVariants(canonicalPhone: string): string[] {
    const national = canonicalPhone.startsWith('0') ? canonicalPhone.slice(1) : canonicalPhone
    return [`0${national}`, `233${national}`, `+233${national}`]
}

function canonicalFromStored(stored: string): string {
    let digits = stored.replace(/\D/g, '')
    if (digits.startsWith('233')) digits = '0' + digits.slice(3)
    return digits
}

const BLACKLIST_CHUNK = 100

/**
 * Look up recipients on phone_blacklist under all stored spellings.
 * Returns the set of CANONICAL numbers that are blacklisted. `ok: false` means
 * the lookup itself failed — callers must fail CLOSED (refuse the sale) rather
 * than treat an unreadable blacklist as an empty one.
 */
export async function findBlacklistedRecipients(
    supabase: any,
    canonicalPhones: string[],
): Promise<{ ok: true; blocked: Set<string> } | { ok: false }> {
    const blocked = new Set<string>()
    const unique = [...new Set(canonicalPhones)]
    for (let i = 0; i < unique.length; i += BLACKLIST_CHUNK) {
        const chunk = unique.slice(i, i + BLACKLIST_CHUNK)
        const { data, error } = await supabase
            .from('phone_blacklist')
            .select('phone_number')
            .in('phone_number', chunk.flatMap(blacklistVariants))
        if (error) {
            console.error('[order-recipient] blacklist lookup failed (failing closed):', error)
            return { ok: false }
        }
        for (const row of (data as { phone_number: string }[] | null) ?? []) {
            blocked.add(canonicalFromStored(row.phone_number))
        }
    }
    return { ok: true, blocked }
}

/**
 * Client-chosen idempotency keys. Bounded charset (no LIKE wildcards, no
 * whitespace/control characters) and length. Bulk batches get `${ref}-${i}`
 * appended, so the batch cap leaves room for the suffix.
 */
const REFERENCE_RE = /^[A-Za-z0-9-]{6,97}$/
const BATCH_REFERENCE_RE = /^[A-Za-z0-9-]{6,80}$/

export function isValidReferenceCode(v: unknown): v is string {
    return typeof v === 'string' && REFERENCE_RE.test(v)
}

export function isValidBatchReference(v: unknown): v is string {
    return typeof v === 'string' && BATCH_REFERENCE_RE.test(v)
}
