// Deterministic sender-ID name suggestions derived from a shop's name. See
// docs/superpowers/specs/2026-08-12-shop-feature-improvements-design.md §2 for the
// full algorithm write-up and the worked-example table that
// scripts/test-shop-sender-suggestions.ts asserts against.
//
// Every candidate is run through the SAME validateSenderText()/senderCollides()
// checks the admin approval path uses, so a suggested name can never be one the
// reviewer would later have to reject.
import { validateSenderText, senderCollides } from './sms-sender-validation'

const FILLER_WORDS = new Set([
    'shop', 'store', 'the', 'gh', 'ghana', 'ltd', 'limited', 'co', 'company',
    'enterprise', 'enterprises', 'data', 'bundle', 'topup', 'airtime', 'sms',
    'reseller', 'voucher',
])

const SUFFIXES = ['GH', 'HUB']

/** Title-case a single word: "KING" → "King", "savage14" → "Savage14". Shop
 *  names arrive in every casing (ALL CAPS is common), and the compact/primary
 *  slots concatenate words directly — normalizing here is what keeps
 *  "KING FLEXY GUEST PORTAL" from suggesting the shouty "FLEXYGUEST". */
function titleCase(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function splitWords(name: string): string[] {
    return name
        .split(/[^A-Za-z0-9]+/)
        .map(w => w.trim())
        .filter(Boolean)
        .map(titleCase)
}

function stripFiller(words: string[]): string[] {
    const kept = words.filter(w => !FILLER_WORDS.has(w.toLowerCase()))
    return kept.length > 0 ? kept : words
}

/** Compact slot: concatenate words (no spaces), hard-truncate to 11 chars, then
 *  drop a trailing word-fragment shorter than 2 characters. `words` is the
 *  remaining-word list to use (retry drops leading words on collision). */
function compactCandidate(words: string[]): string | null {
    if (words.length === 0) return null
    const joined = words.join('')
    if (joined.length <= 11) return joined.length >= 3 ? joined : null
    let truncated = joined.slice(0, 11)
    // Find how much of the truncation belongs to the final (possibly partial) word.
    let consumed = 0
    let fragment = ''
    for (const w of words) {
        if (consumed + w.length > 11) {
            fragment = truncated.slice(consumed)
            break
        }
        consumed += w.length
    }
    if (fragment.length > 0 && fragment.length < 2) {
        truncated = truncated.slice(0, consumed)
    }
    return truncated.length >= 3 ? truncated : null
}

/** Initials slot: first letter of each word, uppercased. Falls back to the first
 *  4 letters of the first word (uppercased) if that's under 3 characters. */
function initialsCandidate(words: string[]): string | null {
    if (words.length === 0) return null
    const initials = words.map(w => w[0]?.toUpperCase() ?? '').join('')
    if (initials.length >= 3) return initials
    const first = words[0].replace(/[^A-Za-z]/g, '')
    return first.length >= 3 ? first.slice(0, 4).toUpperCase() : null
}

/** Primary+suffix slot: first word (title case, ≤9 chars) + suffix, only if the
 *  combined length is ≤11 and doesn't exceed the charset limits. */
function primarySuffixCandidate(words: string[], suffix: string): string | null {
    if (words.length === 0) return null
    const primary = words[0].slice(0, 9)
    const combined = primary + suffix
    return combined.length >= 3 && combined.length <= 11 ? combined : null
}

/** Runs a candidate-generator against progressively shorter word lists (dropping
 *  the leading word each retry) until a candidate passes charset + blocklist +
 *  collision checks, or the retries are exhausted. */
function resolveSlot(
    words: string[],
    generate: (w: string[]) => string | null,
    existing: string[],
    maxRetries = 2,
): string | null {
    let current = words
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const candidate = generate(current)
        // validateSenderText covers the charset/length rule, the "must contain a
        // letter" rule, AND the reserved-brand blocklist.
        if (candidate && validateSenderText(candidate).ok && !senderCollides(candidate, existing)) {
            return candidate
        }
        if (current.length <= 1) break
        current = current.slice(1)
    }
    return null
}

export function generateSenderSuggestions(
    shopName: string,
    opts?: { existing?: string[] },
): string[] {
    const words = stripFiller(splitWords(shopName || ''))
    if (words.length === 0) return []
    const existing = opts?.existing ?? []

    const results: string[] = []
    const seen = new Set<string>()
    const pushIfNew = (candidate: string | null) => {
        if (candidate && !seen.has(candidate)) {
            seen.add(candidate)
            results.push(candidate)
        }
    }

    pushIfNew(resolveSlot(words, compactCandidate, existing))
    pushIfNew(resolveSlot(words, initialsCandidate, existing))
    for (const suffix of SUFFIXES) {
        pushIfNew(resolveSlot(words, w => primarySuffixCandidate(w, suffix), existing))
    }

    return results.slice(0, 4)
}
