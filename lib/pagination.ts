// Shared helpers for the arrow-only, fixed-page-size pagination used on
// /dashboard/my-orders and /dashboard/shop/orders.

export const ORDER_HISTORY_PAGE_SIZE = 20

/** Converts a 1-indexed page number into a Supabase .range(from, to) pair. */
export function pageToRange(page: number, pageSize: number = ORDER_HISTORY_PAGE_SIZE): { from: number; to: number } {
    const safePage = Math.max(1, Math.floor(page) || 1)
    const from = (safePage - 1) * pageSize
    const to = from + pageSize - 1
    return { from, to }
}

/** Total page count for a given row count, always at least 1 (so "Page 1 of 1" renders on an empty result). */
export function totalPages(totalCount: number, pageSize: number = ORDER_HISTORY_PAGE_SIZE): number {
    if (!Number.isFinite(totalCount) || totalCount <= 0) return 1
    return Math.ceil(totalCount / pageSize)
}

/** Human-readable "Showing A–B of N" range for the current page, clamped to the true total. */
export function pageRangeLabel(page: number, pageSize: number, totalCount: number): { from: number; to: number } {
    if (totalCount <= 0) return { from: 0, to: 0 }
    const { from, to } = pageToRange(page, pageSize)
    return { from: from + 1, to: Math.min(to + 1, totalCount) }
}

/**
 * Escapes Postgres LIKE/ILIKE wildcard characters (%, _) and the escape
 * character itself (\) in free-text search input before it's interpolated
 * into an ilike pattern server-side, so a search for e.g. "50%" or a phone
 * number containing "_" can't be (mis)interpreted as a wildcard.
 */
export function escapeLikePattern(input: string): string {
    return input.replace(/[\\%_]/g, (ch) => '\\' + ch)
}
