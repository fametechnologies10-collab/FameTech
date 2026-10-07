// lib/afa-validation.ts
//
// Single source of truth for AFA registration input validation, shared by the
// dashboard route (app/api/user/afa-registration) and the developer API
// (app/api/v2/afa/register).
//
// ── WHY THIS EXISTS (review finding I6) ────────────────────────────────────
// The v2 AFA route duplicated the dashboard's region allowlist, Ghana Card
// regex, field length caps, free-text rejection and 18+ DOB arithmetic. Two
// copies of a KYC allowlist is a bad shape: adding Ghana's next region, or
// tightening the ID format, would have to happen twice, and whichever copy was
// missed would keep accepting or rejecting the wrong thing silently.
//
// Pure and dependency-free — no DB, no auth, no response shaping — so each
// caller keeps its own error envelope (the dashboard returns NextResponse.json,
// the API returns the v2 envelope) and this stays unit-testable.

export const VALID_ID_TYPES = ['Ghana Card'] as const

/** All 16 official regions of Ghana. */
export const VALID_REGIONS = [
    'Greater Accra', 'Ashanti', 'Western', 'Eastern', 'Central', 'Northern',
    'Volta', 'Upper East', 'Upper West', 'Bono', 'Bono East', 'Ahafo',
    'Savannah', 'North East', 'Oti', 'Western North',
] as const

export const ID_FORMAT_PATTERNS: Record<string, { pattern: RegExp; hint: string }> = {
    'Ghana Card': { pattern: /^GHA-\d{9}-\d$/, hint: 'GHA-XXXXXXXXX-X' },
}

export const FIELD_MAX_LENGTHS: Record<string, number> = {
    full_name: 100, phone: 20, id_number: 20, id_type: 50, region: 100, location: 100, notes: 500,
}

export const REQUIRED_AFA_FIELDS = [
    'full_name', 'phone', 'id_type', 'id_number', 'location', 'region', 'date_of_birth',
] as const

/**
 * Free-text fields that reach a human (admin panel, exports). Rejected outright
 * if they contain angle brackets rather than being escaped, matching the
 * customer-facing validation convention in lib/validation.ts.
 */
const FREE_TEXT_FIELDS = ['full_name', 'location', 'notes'] as const

export type AfaValidationResult =
    | { ok: true }
    | { ok: false; field: string; message: string }

/** Whole-number age on `asOf`, honouring month/day so a birthday later this year doesn't count. */
export function ageOn(dateOfBirth: Date, asOf: Date = new Date()): number {
    let age = asOf.getFullYear() - dateOfBirth.getFullYear()
    const monthDiff = asOf.getMonth() - dateOfBirth.getMonth()
    if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < dateOfBirth.getDate())) age--
    return age
}

/**
 * Validates an AFA registration payload. Returns the FIRST failure, so callers
 * can surface one actionable message rather than a list.
 *
 * Deliberately does NOT validate the phone number: the two callers normalise it
 * with different helpers already, and moving that here would change behaviour on
 * one of them. Callers still run their own phone check.
 */
export function validateAfaRegistration(formData: Record<string, any>): AfaValidationResult {
    for (const field of REQUIRED_AFA_FIELDS) {
        if (!formData[field] || String(formData[field]).trim() === '') {
            return { ok: false, field, message: `Missing required field: ${field}` }
        }
    }

    for (const [field, maxLen] of Object.entries(FIELD_MAX_LENGTHS)) {
        const val = formData[field]
        if (val && String(val).length > maxLen) {
            return { ok: false, field, message: `Field "${field}" exceeds maximum length of ${maxLen} characters.` }
        }
    }

    for (const field of FREE_TEXT_FIELDS) {
        const val = formData[field]
        if (val && /[<>]/.test(String(val))) {
            return { ok: false, field, message: `Field "${field}" contains invalid characters. Remove < and > and try again.` }
        }
    }

    if (!(VALID_ID_TYPES as readonly string[]).includes(formData.id_type)) {
        return { ok: false, field: 'id_type', message: `Invalid ID type. Must be one of: ${VALID_ID_TYPES.join(', ')}.` }
    }

    if (!(VALID_REGIONS as readonly string[]).includes(formData.region)) {
        return { ok: false, field: 'region', message: 'Invalid region. Must be one of the supported Ghana regions.' }
    }

    const idConfig = ID_FORMAT_PATTERNS[formData.id_type as string]
    if (!idConfig) {
        // Only reachable if VALID_ID_TYPES gains an entry without a matching
        // pattern — a config mistake, not user input. Surfaced as its own field
        // so the caller can log it as a 500 rather than blaming the applicant.
        return { ok: false, field: '__config', message: 'ID type validation is not configured. Please contact support.' }
    }
    if (!idConfig.pattern.test(String(formData.id_number).trim())) {
        return { ok: false, field: 'id_number', message: `Invalid ID number format for the selected ID type. Expected format: ${idConfig.hint}` }
    }

    const dob = new Date(formData.date_of_birth)
    if (isNaN(dob.getTime())) {
        return { ok: false, field: 'date_of_birth', message: 'Invalid Date of Birth format' }
    }
    if (ageOn(dob) < 18) {
        return { ok: false, field: 'date_of_birth', message: 'Applicant must be at least 18 years of age.' }
    }

    return { ok: true }
}
