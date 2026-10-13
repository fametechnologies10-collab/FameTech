// lib/csv-safe.ts
//
// CSV formula-injection guard for admin exports. A spreadsheet treats any cell that begins with
// = + - @ (or a tab / carriage return, which some versions strip before evaluating) as a formula,
// so a customer-controlled string such as a name or reference like `=HYPERLINK(...)` becomes code
// that runs when an admin opens the export. Prefixing a single quote makes Excel/Sheets render it
// as plain text. Apply to TEXT columns only — numeric columns (amounts, profit) legitimately start
// with '-' and must stay numeric.

const FORMULA_LEAD = /^[=+\-@\t\r]/

export function csvSafeText(value: unknown): string {
    const s = value === null || value === undefined ? '' : String(value)
    return FORMULA_LEAD.test(s) ? `'${s}` : s
}
