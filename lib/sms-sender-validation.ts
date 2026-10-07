/**
 * Sender-ID validation (KFT SMS) — charset/length rules + NORMALIZED
 * reserved-brand collision detection.
 *
 * Exact-match deny lists are trivially bypassed ('M T N', 'MTNAlert',
 * 'Te1ecel', 'KlNGFLEXY'). We fold the candidate (lowercase, strip
 * spaces/digits/punctuation, leet variants incl. the 1→i/1→l and l→i
 * ambiguities) and reject on equality OR substring against the reserved set.
 * Admin review + Hubtel's own registration check remain the human backstops.
 */

export const SENDER_TEXT_RE = /^[A-Za-z0-9 ]{3,11}$/

/** Brands that may never appear in a tenant sender ID. */
const RESERVED_BRANDS = [
    'kingflexy', 'kfgsms', 'kft', 'kftsms',
    'mtn', 'telecel', 'vodafone', 'airteltigo', 'atmoney', 'tigo',
    'momo', 'mobilemoney', 'hubtel', 'paystack', 'moolre', 'mnotify',
    'gcb', 'ecobank', 'fidelity', 'absa', 'stanbic', 'calbank',
    'gtbank', 'zenith', 'accessbank', 'uba',
]

const LEET: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' }

/** Base fold: lowercase, leet-fold (except '1'), keep only [a-z1]. */
function foldBase(s: string): string {
    return s.toLowerCase()
        .replace(/[03457@$]/g, c => LEET[c] ?? '')
        .replace(/[^a-z1]/g, '')
}

/**
 * Comparison forms. The 'merged' form canonicalizes the 1/i/l lookalike class
 * to a single symbol — applied to BOTH candidate and brand, so 'KlNGFLEXY'
 * (l-for-i) and 'K1NGFLEXY' land on the same form as 'KINGFLEXY'. (Folding
 * only the candidate can't work: the brand's own legitimate 'l' would differ.)
 */
export function senderComparisonForms(s: string): string[] {
    const base = foldBase(s)
    return Array.from(new Set([
        base.replace(/1/g, 'i'),            // plain (1 read as i)
        base.replace(/1/g, 'l'),            // plain (1 read as l)
        base.replace(/[1l]/g, 'i'),         // merged i/l/1 canonical
    ])).filter(Boolean)
}

export interface SenderValidation {
    ok: boolean
    error?: string
}

export function validateSenderText(raw: string): SenderValidation {
    const text = (raw || '').trim()
    if (!SENDER_TEXT_RE.test(text)) {
        return { ok: false, error: 'Sender ID must be 3–11 characters, letters/numbers/spaces only' }
    }
    if (!/[A-Za-z]/.test(text)) {
        return { ok: false, error: 'Sender ID must contain letters' }
    }
    const forms = senderComparisonForms(text)
    for (const brandForms of RESERVED_BRAND_FORMS) {
        for (const f of forms) {
            for (const bf of brandForms) {
                if (f === bf || f.includes(bf)) {
                    return { ok: false, error: 'This sender ID conflicts with a protected brand name' }
                }
            }
        }
    }
    return { ok: true }
}

// Brands folded through the SAME pipeline (precomputed at module load).
const RESERVED_BRAND_FORMS: string[][] = RESERVED_BRANDS.map(senderComparisonForms)

/** Normalized equality vs existing sender rows (duplicate-pending guard). */
export function senderCollides(candidate: string, existing: string[]): boolean {
    const candForms = new Set(senderComparisonForms(candidate))
    return existing.some(e => senderComparisonForms(e).some(f => candForms.has(f)))
}
