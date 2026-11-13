/**
 * Pure helper: builds the `delivered_at` patch to merge into an order update
 * when a supplier handler marks an order completed.
 *
 * A supplier-reported time is accepted only if it is a valid date, not more
 * than 1 minute in the future, and not more than 7 days old (relative to now).
 * Otherwise falls back to `now` only when `allowNowFallback` is true.
 * Never throws.
 */
const MAX_FUTURE_SKEW_MS = 60_000
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function deliveredAtPatch(
    newStatus: string,
    opts: { supplierTime?: Date | string | null; allowNowFallback: boolean; now?: Date },
): { delivered_at?: string } {
    try {
        if (newStatus !== 'completed') return {}
        const now = opts?.now instanceof Date && !isNaN(opts.now.getTime()) ? opts.now : new Date()
        const raw = opts?.supplierTime

        let parsed: Date | null = null
        try {
            if (typeof raw === 'string' || raw instanceof Date) {
                const d = new Date(raw)
                if (!isNaN(d.getTime())) parsed = d
            }
        } catch {
            parsed = null
        }

        if (parsed) {
            const diff = parsed.getTime() - now.getTime()
            if (diff <= MAX_FUTURE_SKEW_MS && diff >= -MAX_AGE_MS) {
                return { delivered_at: parsed.toISOString() }
            }
        }
        return opts?.allowNowFallback ? { delivered_at: now.toISOString() } : {}
    } catch {
        return {}
    }
}
