// lib/ussd/code-generator.ts
// =============================================================================
// Shared USSD shop-code helpers.
// - Auto-generated codes: readable charset (no 0/O/1/I/L), ALWAYS mix >=1 letter
//   AND >=1 digit so the code looks like a code and is harder to guess.
// - Custom codes (owner-chosen): full A-Z0-9, upper-cased on store. Uniqueness is
//   enforced case-insensitively because every stored code is upper-case and the
//   USSD resolver upper-cases guest input before lookup.
// =============================================================================

// Auto-gen charset excludes look-alikes 0/O, 1/I/L for readability when spoken.
const AUTO_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ' // no I, L, O
const AUTO_DIGITS  = '23456789'                // no 0, 1
const AUTO_CHARS   = AUTO_LETTERS + AUTO_DIGITS

/** Cryptographically-strong, unbiased random index in [0, max). */
function randomIndex(max: number): number {
    const arr = new Uint32Array(1)
    const limit = Math.floor(0xFFFFFFFF / max) * max // rejection sampling avoids modulo bias
    let x: number
    do {
        globalThis.crypto.getRandomValues(arr)
        x = arr[0]
    } while (x >= limit)
    return x % max
}

/** Generate a 4-char upper-case code guaranteed to contain >=1 letter and >=1 digit. */
export function generateUssdCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
        let code = ''
        for (let i = 0; i < 4; i++) {
            code += AUTO_CHARS[randomIndex(AUTO_CHARS.length)]
        }
        const hasLetter = /[A-Z]/.test(code)
        const hasDigit  = /[0-9]/.test(code)
        if (hasLetter && hasDigit) return code
    }
    // Deterministic fallback (extraordinarily unlikely to reach): force a mix.
    const l = AUTO_LETTERS[randomIndex(AUTO_LETTERS.length)]
    const d = AUTO_DIGITS[randomIndex(AUTO_DIGITS.length)]
    const a = AUTO_CHARS[randomIndex(AUTO_CHARS.length)]
    const b = AUTO_CHARS[randomIndex(AUTO_CHARS.length)]
    return `${l}${d}${a}${b}`
}

/** Custom codes: exactly 4 chars, A-Z or 0-9 only (after upper-casing). */
export const CUSTOM_CODE_RE = /^[A-Z0-9]{4}$/

/**
 * Normalize an owner-supplied custom code: trim + upper-case.
 * Returns the normalized code if valid, or null if it fails the format rule.
 */
export function normalizeCustomCode(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const normalized = input.trim().toUpperCase()
    return CUSTOM_CODE_RE.test(normalized) ? normalized : null
}
