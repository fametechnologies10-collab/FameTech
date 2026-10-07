// Shared "date filter -> {start, end}" resolution for admin order-list pages.
// Extracted so app/admin/fulfillment/page.tsx and app/admin/ishare/page.tsx compute
// IDENTICAL ranges from identical presets. A second hand-copied version of this
// function is exactly the class of drift this codebase spent a whole branch
// removing from its supplier lists — one implementation, every page imports it.
export type DateFilterId = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom'

export const DATE_FILTER_PRESETS: Array<{ id: DateFilterId; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'week', label: 'This Week' },
    { id: 'month', label: 'This Month' },
    { id: 'all', label: 'All Time' },
    { id: 'custom', label: 'Custom' },
]

/**
 * `all` deliberately matches no branch below and returns { start: null, end: null }
 * — "no date filter", not an error. `customDate` is a `YYYY-MM-DD` input value;
 * parsed as local-time components (not `new Date(string)`) so it means the
 * calendar day the admin picked, not that day shifted by process TZ.
 */
export function computeDateRange(
    dateFilter: DateFilterId,
    customDate: string
): { start: Date | null; end: Date | null } {
    const now = new Date()
    let start: Date | null = null
    let end: Date | null = null

    if (dateFilter === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    } else if (dateFilter === 'yesterday') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999)
    } else if (dateFilter === 'week') {
        const day = now.getDay() || 7 // Sun (0) -> 7
        if (day !== 1) now.setHours(-24 * (day - 1)) // back up to Monday this week
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        end = new Date() // up to now
    } else if (dateFilter === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1)
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    } else if (dateFilter === 'custom' && customDate) {
        const dateParts = customDate.split('-').map(Number)
        start = new Date(dateParts[0], dateParts[1] - 1, dateParts[2])
        end = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 23, 59, 59, 999)
    }

    return { start, end }
}
