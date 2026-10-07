// lib/phone-import.ts
//
// Shared number-import normalizer for the shop SMS paste/upload/group
// features. Has NO server-only imports (no crypto, no Supabase) so it runs
// identically in the browser (paste/upload preview) and on the server (the
// authority — API routes re-run this on every create/update, never trust
// the client's parse). Wraps the existing lib/sms-service.ts normalizer
// rather than duplicating its logic; only adds the bare-9-digit fallback
// (a number typed/pasted without its leading 0) on top.
import { normalizeGhanaPhone } from '@/lib/phone-normalize'

export interface ParsedPhoneEntry {
    phone: string
    name?: string
}

export interface ParsedPhoneResult {
    valid: ParsedPhoneEntry[]
    duplicateCount: number
    invalid: string[]
    invalidCount: number
}

const MAX_DISPLAYED_INVALID = 50

function normalizeOne(raw: string): string | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const direct = normalizeGhanaPhone(trimmed)
    if (direct) return direct
    // Bare 9-digit number missing its leading 0 (e.g. "244123456" pasted
    // from a spreadsheet that stripped the leading zero).
    const digitsOnly = trimmed.replace(/[\s\-+]/g, '')
    if (/^\d{9}$/.test(digitsOnly)) {
        return normalizeGhanaPhone('0' + digitsOnly)
    }
    return null
}

function dedupeAndCollect(
    entries: { raw: string; phone: string | null; name?: string }[],
): ParsedPhoneResult {
    const seen = new Set<string>()
    const valid: ParsedPhoneEntry[] = []
    const invalid: string[] = []
    let duplicateCount = 0

    for (const entry of entries) {
        if (!entry.phone) {
            if (entry.raw.trim()) invalid.push(entry.raw.trim())
            continue
        }
        if (seen.has(entry.phone)) {
            duplicateCount++
            continue
        }
        seen.add(entry.phone)
        valid.push(entry.name ? { phone: entry.phone, name: entry.name } : { phone: entry.phone })
    }

    return {
        valid,
        duplicateCount,
        invalid: invalid.slice(0, MAX_DISPLAYED_INVALID),
        invalidCount: invalid.length,
    }
}

/** Parse free text: numbers separated by commas, semicolons, or any whitespace (spaces/newlines/tabs). */
export function parsePhoneNumbersFromText(raw: string): ParsedPhoneResult {
    const tokens = raw.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)
    const entries = tokens.map(token => ({ raw: token, phone: normalizeOne(token) }))
    return dedupeAndCollect(entries)
}

/** Parse rows already split into phone/name fields (from CSV/XLSX parsing — see parseSheetRows in app/dashboard/shop/sms/page.tsx). */
export function parsePhoneNumbersFromRows(rows: { phone: string; name?: string }[]): ParsedPhoneResult {
    const entries = rows.map(row => ({
        raw: row.phone,
        phone: normalizeOne(row.phone),
        name: row.name?.trim() || undefined,
    }))
    return dedupeAndCollect(entries)
}
