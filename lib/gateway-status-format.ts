/**
 * Pure formatting helpers for the dashboard delivery-status widget.
 */
import type { StrengthTier } from '@/lib/gateway-estimate'

const DASH = '—'

const CLOCK = new Intl.DateTimeFormat('en-GH', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Accra',
})

/** Replace narrow/no-break spaces with a plain space and lower-case am/pm. */
export function normalizeClock(text: string): string {
    return text.replace(/[\u202f\u00a0]/g, ' ').toLowerCase()
}

/** ISO timestamp -> "11:14 pm" in Ghana time; invalid/null -> "—". */
export function formatClockTime(iso: string | null | undefined): string {
    if (!iso) return DASH
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return DASH
    return normalizeClock(CLOCK.format(d))
}

export const TIER_FILL_CLASS: Record<StrengthTier | 'down' | 'none', string> = {
    Excellent: 'bg-green-500 dark:bg-green-400',
    Good: 'bg-lime-500 dark:bg-lime-400',
    Delayed: 'bg-amber-500 dark:bg-amber-400',
    Critical: 'bg-red-500 dark:bg-red-400',
    down: 'bg-transparent',
    none: 'bg-transparent',
}

export const TIER_TEXT_CLASS: Record<StrengthTier | 'down' | 'none', string> = {
    Excellent: 'text-green-700 dark:text-green-400',
    Good: 'text-lime-700 dark:text-lime-400',
    Delayed: 'text-amber-700 dark:text-amber-400',
    Critical: 'text-red-700 dark:text-red-400',
    down: 'text-amber-700 dark:text-amber-400',
    none: 'text-muted-foreground',
}

export const COOLDOWN_MS = 10_000

/** Milliseconds of refresh cooldown left; always within [0, COOLDOWN_MS]. */
export function cooldownRemainingMs(nowMs: number, fetchEndedAtMs: number | null): number {
    if (fetchEndedAtMs === null || !Number.isFinite(nowMs) || !Number.isFinite(fetchEndedAtMs)) return 0
    const remaining = COOLDOWN_MS - (nowMs - fetchEndedAtMs)
    return Math.min(COOLDOWN_MS, Math.max(0, remaining))
}
