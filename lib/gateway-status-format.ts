/**
 * Pure formatting helpers for the dashboard delivery-status widget.
 */
import type { GatewayBand } from '@/lib/gateway-health'

const DASH = '—'

/** 0.4 -> "0.4 min", 59.9 -> "59.9 min", 125 -> "2hr 5min", null -> "—". */
export function formatMinutes(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return DASH
    if (minutes < 60) {
        const rounded = Math.round(minutes * 10) / 10
        if (rounded < 60) return `${rounded} min`
    }
    const total = Math.round(minutes)
    const h = Math.floor(total / 60)
    const m = total % 60
    return m === 0 ? `${h}hr` : `${h}hr ${m}min`
}

const CLOCK = new Intl.DateTimeFormat('en-GH', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Accra',
})

/** ISO timestamp -> "11:14 pm" in Ghana time; invalid/null -> "—". */
export function formatClockTime(iso: string | null | undefined): string {
    if (!iso) return DASH
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return DASH
    return CLOCK.format(d).replace(/[  ]/g, ' ').toLowerCase()
}

export const BAND_HEADLINE: Record<GatewayBand, string> = {
    excellent: 'Delivering fast',
    good: 'Delivering fast',
    slow: 'Running slow',
    degraded: 'Delays likely',
    none: 'No recent orders',
}

export const BAND_FILL_CLASS: Record<GatewayBand, string> = {
    excellent: 'bg-green-500 dark:bg-green-400',
    good: 'bg-lime-500 dark:bg-lime-400',
    slow: 'bg-amber-500 dark:bg-amber-400',
    degraded: 'bg-red-500 dark:bg-red-400',
    none: 'bg-transparent',
}

export const BAND_TEXT_CLASS: Record<GatewayBand, string> = {
    excellent: 'text-green-700 dark:text-green-400',
    good: 'text-lime-700 dark:text-lime-400',
    slow: 'text-amber-700 dark:text-amber-400',
    degraded: 'text-red-700 dark:text-red-400',
    none: 'text-muted-foreground',
}
