// Presentation-only per-biller accent system. Colors are grounded in each
// provider's own brand identity (ECG = its real logo blue/red — deliberately
// NOT the generic "electricity = yellow" assumption; indigo picked over
// DSTV's plain blue to stay visually distinct in the biller grid — Ghana
// Water = sky blue, DSTV = brand blue, GOtv = brand green, StarTimes = brand
// red) so the biller grid and verification card read as "this specific
// provider," not an arbitrary palette. Pure data — no hooks, safe to import
// from any component.
import { Zap, Droplets, Tv, MonitorPlay, Satellite, type LucideIcon } from 'lucide-react'
import type { UtilityBiller } from '@/lib/hubtel-utility/billers'

export interface BillerUI {
    Icon: LucideIcon
    /** Soft icon-badge background + fg (light/dark). */
    badge: string
    /** Ring accent used around the verification-card avatar. */
    ring: string
    /** Text accent matching the brand color. */
    text: string
    /** Solid left-border / progress-fill accent. */
    bar: string
}

export const BILLER_UI: Record<UtilityBiller, BillerUI> = {
    ecg: {
        Icon: Zap,
        badge: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400',
        ring: 'ring-indigo-400/70 dark:ring-indigo-500/50',
        text: 'text-indigo-600 dark:text-indigo-400',
        bar: 'bg-indigo-600',
    },
    ghana_water: {
        Icon: Droplets,
        badge: 'bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400',
        ring: 'ring-sky-400/70 dark:ring-sky-500/50',
        text: 'text-sky-600 dark:text-sky-400',
        bar: 'bg-sky-500',
    },
    dstv: {
        Icon: Tv,
        badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
        ring: 'ring-blue-400/70 dark:ring-blue-500/50',
        text: 'text-blue-700 dark:text-blue-400',
        bar: 'bg-blue-600',
    },
    gotv: {
        Icon: MonitorPlay,
        badge: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400',
        ring: 'ring-green-400/70 dark:ring-green-500/50',
        text: 'text-green-700 dark:text-green-400',
        bar: 'bg-green-600',
    },
    startimes: {
        Icon: Satellite,
        badge: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
        ring: 'ring-red-400/70 dark:ring-red-500/50',
        text: 'text-red-700 dark:text-red-400',
        bar: 'bg-red-600',
    },
}
