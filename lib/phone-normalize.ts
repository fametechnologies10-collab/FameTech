/**
 * Normalize a Ghanaian phone number to international format: 233XXXXXXXXX
 * Returns null if the number is not recognizable.
 */
export function normalizeGhanaPhone(raw: string): string | null {
    let n = raw.replace(/[\s\-+]/g, '')
    if (n.startsWith('0') && n.length === 10)  n = '233' + n.slice(1)
    if (n.startsWith('233') && n.length === 12) return n
    return null
}
