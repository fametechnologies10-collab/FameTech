// Presentation-only per-biller accent system for the storefront Utilities tab.
// Colors are grounded in each provider's own brand identity (ECG = amber/electricity,
// Ghana Water = sky blue, DSTV = brand blue, GOtv = brand green, StarTimes = brand red) —
// same palette as app/dashboard/utilities/biller-ui.tsx, kept as a local copy so the
// storefront's components/ folder (StorefrontDataTab, ServiceChargeSheet, PackageCard, …)
// never reaches into app/dashboard. Pure data — no hooks, safe to import anywhere.
import { Zap, Droplets, Tv, MonitorPlay, Satellite, type LucideIcon } from 'lucide-react'
import type { UtilityBiller } from '@/lib/hubtel-utility/billers'

export interface UtilityBillerMeta {
    Icon: LucideIcon
    /** Soft icon-badge background + fg (light/dark) — matches the tile idiom used across the storefront's other service cards. */
    badge: string
    /** Ring accent used around the verification-card avatar. */
    ring: string
    /** One-line subtitle shown on the biller tile. */
    blurb: string
}

export const UTILITY_BILLER_META: Record<UtilityBiller, UtilityBillerMeta> = {
    ecg: {
        Icon: Zap,
        badge: 'bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
        ring: 'ring-amber-400/70 dark:ring-amber-500/50',
        blurb: 'Prepaid & postpaid credit',
    },
    ghana_water: {
        Icon: Droplets,
        badge: 'bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400',
        ring: 'ring-sky-400/70 dark:ring-sky-500/50',
        blurb: 'Water bill payment',
    },
    dstv: {
        Icon: Tv,
        badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
        ring: 'ring-blue-400/70 dark:ring-blue-500/50',
        blurb: 'Subscription renewal',
    },
    gotv: {
        Icon: MonitorPlay,
        badge: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400',
        ring: 'ring-green-400/70 dark:ring-green-500/50',
        blurb: 'Subscription renewal',
    },
    startimes: {
        Icon: Satellite,
        badge: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
        ring: 'ring-red-400/70 dark:ring-red-500/50',
        blurb: 'Bouquet renewal',
    },
}
