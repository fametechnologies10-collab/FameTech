/**
 * Gateway health classification for the customer-facing delivery status widget.
 * Pure and dependency-free: consumed by the API route and the UI.
 */

export type GatewayBand = 'excellent' | 'good' | 'slow' | 'degraded' | 'none'

export const BAND_BAR_PCT: Record<GatewayBand, number> = {
    excellent: 100,
    good: 70,
    slow: 40,
    degraded: 15,
    none: 0,
}

export const BAND_LABEL: Record<GatewayBand, string> = {
    excellent: 'Excellent',
    good: 'Good',
    slow: 'Slow',
    degraded: 'Degraded',
    none: 'No recent orders',
}

export interface RawGatewayRow {
    key: string
    last_placed_at: string | null
    last_delivered_at: string | null
    /** Newest first. */
    delivery_minutes: number[]
    resolved_count: number
    failed_count: number
}

export interface GatewayNetwork {
    key: string
    label: string
    band: GatewayBand
    barPct: number
    medianMinutes: number | null
    lastMinutes: number | null
    lastPlacedAt: string | null
    lastDeliveredAt: string | null
    sampleSize: number
}

export const GATEWAY_ORDER: { key: string; label: string }[] = [
    { key: 'MTN', label: 'MTN' },
    { key: 'Telecel', label: 'Telecel' },
    { key: 'AT-iShare', label: 'AT-iShare' },
    { key: 'AT-BigTime', label: 'AT-BigTime' },
    { key: 'standard_bundles', label: 'Standard Bundles' },
]

export function median(values: number[]): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const DROP: Record<GatewayBand, GatewayBand> = {
    excellent: 'good',
    good: 'slow',
    slow: 'degraded',
    degraded: 'degraded',
    none: 'none',
}

export function classifyGateway(i: {
    medianMinutes: number | null
    resolvedCount: number
    failedCount: number
}): GatewayBand {
    const { medianMinutes, resolvedCount, failedCount } = i
    const failRatio = resolvedCount > 0 ? failedCount / resolvedCount : 0

    if (medianMinutes === null) {
        return failedCount >= 3 && failRatio > 0.3 ? 'degraded' : 'none'
    }

    let band: GatewayBand
    if (medianMinutes <= 10) band = 'excellent'
    else if (medianMinutes <= 30) band = 'good'
    else if (medianMinutes <= 60) band = 'slow'
    else band = 'degraded'

    if (resolvedCount >= 5 && failRatio > 0.3) band = DROP[band]
    return band
}

const round1 = (n: number) => Math.round(n * 10) / 10

export function shapeGatewayStats(rows: RawGatewayRow[]): GatewayNetwork[] {
    const byKey = new Map(rows.map((r) => [r.key, r]))
    return GATEWAY_ORDER.map(({ key, label }) => {
        const row = byKey.get(key)
        if (!row) {
            return {
                key,
                label,
                band: 'none' as GatewayBand,
                barPct: BAND_BAR_PCT.none,
                medianMinutes: null,
                lastMinutes: null,
                lastPlacedAt: null,
                lastDeliveredAt: null,
                sampleSize: 0,
            }
        }
        const minutes = row.delivery_minutes ?? []
        const med = median(minutes)
        const band = classifyGateway({
            medianMinutes: med,
            resolvedCount: row.resolved_count,
            failedCount: row.failed_count,
        })
        return {
            key,
            label,
            band,
            barPct: BAND_BAR_PCT[band],
            medianMinutes: med === null ? null : round1(med),
            lastMinutes: minutes.length > 0 ? round1(minutes[0]) : null,
            lastPlacedAt: row.last_placed_at ?? null,
            lastDeliveredAt: row.last_delivered_at ?? null,
            sampleSize: minutes.length,
        }
    })
}
