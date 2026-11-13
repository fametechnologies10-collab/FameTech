/**
 * Pure delivery-estimation formulas (C/P logic). No imports, no DB, no React.
 * C = last delivered order (Metric 1), P = oldest open order newer than C (Metric 2).
 */

export const BUFFER_SECONDS = 300
export const STALE_SECONDS = 86_400
export const DOWN_HEADLINE = 'Experiencing delays'
export const NONE_HEADLINE = 'No recent orders'

export type GatewayState = 'live' | 'none' | 'down'
export type StrengthTier = 'Excellent' | 'Good' | 'Delayed' | 'Critical'

export interface DownSnapshot {
    lastSeconds: number | null
    lastPlacedAt: string | null
    lastDeliveredAt: string | null
}

export interface GatewaySignalRow {
    key: string
    c_created_at: string | null
    c_delivered_at: string | null
    p_created_at: string | null
    is_manually_down: boolean
    down_reason: string | null
    down_since: string | null
    down_snapshot: DownSnapshot | null
}

export interface DurationView {
    seconds: number
    minutes: number
}

export interface ChannelView {
    key: string
    label: string
    state: GatewayState
    headline: string | null
    tier: StrengthTier | null
    strengthPct: number
    lastDelivery: (DurationView & { placedAt: string; deliveredAt: string }) | null
    currentEstimate: (DurationView & { source: 'open_order' | 'last_delivery' }) | null
    openOrderAgeSeconds: number | null
}

export const GATEWAY_ORDER: { key: string; label: string }[] = [
    { key: 'MTN', label: 'MTN' },
    { key: 'Telecel', label: 'Telecel' },
    { key: 'AT-iShare', label: 'AT-iShare' },
    { key: 'AT-BigTime', label: 'AT-BigTime' },
    { key: 'standard_bundles', label: 'Standard Bundles' },
]

/** Finite, non-negative number or 0. */
function safe(n: number): number {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

function parseMs(s: unknown): number | null {
    if (typeof s !== 'string' || s === '') return null
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? ms : null
}

/** Forgive the first 5 minutes (supplier/validation overhead). */
export function adjustSeconds(rawSeconds: number): number {
    const raw = safe(rawSeconds)
    return raw <= BUFFER_SECONDS ? raw : raw - BUFFER_SECONDS
}

export function estimateHeadline(adjMinutes: number): string {
    const m = safe(adjMinutes)
    if (m < 10) return 'Instant Delivery Ongoing'
    if (m < 60) return 'Delivery Ongoing'
    return 'Validation Ongoing'
}

export function strengthFromMetric1(adjMinutes: number): { percent: number; tier: StrengthTier } {
    const m = safe(adjMinutes)
    let p: number
    if (m <= 10) p = 100
    else if (m <= 30) p = 100 - ((m - 10) / 20) * 20
    else if (m <= 60) p = 79 - ((m - 30) / 30) * 29
    else if (m <= 180) p = 49 - ((m - 60) / 120) * 29
    else if (m < 480) p = 20 - ((m - 180) / 300) * 19
    else p = 1
    const percent = Math.min(100, Math.max(1, Math.round(p)))
    const tier: StrengthTier = m <= 30 ? 'Excellent' : m <= 60 ? 'Good' : m <= 180 ? 'Delayed' : 'Critical'
    return { percent, tier }
}

export function formatDuration(minutes: number | null, seconds: number | null): string {
    if (minutes === null || seconds === null) return ''
    if (seconds < 60) return `${Math.max(1, Math.round(safe(seconds)))} sec`
    return `${minutes} min`
}

function duration(seconds: number): DurationView {
    const s = safe(seconds)
    return { seconds: s, minutes: Math.round(s / 60) }
}

function labelFor(key: string): string {
    return GATEWAY_ORDER.find(g => g.key === key)?.label ?? key
}

function emptyView(key: string, state: 'none' | 'down'): ChannelView {
    return {
        key,
        label: labelFor(key),
        state,
        headline: state === 'none' ? NONE_HEADLINE : null,
        tier: null,
        strengthPct: 0,
        lastDelivery: null,
        currentEstimate: null,
        openOrderAgeSeconds: null,
    }
}

export function buildChannelView(row: GatewaySignalRow | undefined, key: string, nowMs: number): ChannelView {
    if (!row) return emptyView(key, 'none')

    if (row.is_manually_down) {
        const view = emptyView(key, 'down')
        const snap = row.down_snapshot
        if (
            snap &&
            typeof snap.lastSeconds === 'number' &&
            Number.isFinite(snap.lastSeconds) &&
            typeof snap.lastPlacedAt === 'string' &&
            typeof snap.lastDeliveredAt === 'string'
        ) {
            const seconds = safe(snap.lastSeconds)
            view.lastDelivery = {
                seconds,
                minutes: Math.round(seconds / 60),
                placedAt: snap.lastPlacedAt,
                deliveredAt: snap.lastDeliveredAt,
            }
        }
        return view
    }

    const createdMs = parseMs(row.c_created_at)
    const deliveredMs = parseMs(row.c_delivered_at)
    if (
        createdMs === null ||
        deliveredMs === null ||
        deliveredMs < createdMs ||
        createdMs > nowMs ||
        nowMs - createdMs > STALE_SECONDS * 1000
    ) {
        return emptyView(key, 'none')
    }

    const m1Seconds = adjustSeconds(Math.floor((deliveredMs - createdMs) / 1000))
    const strength = strengthFromMetric1(m1Seconds / 60)
    const m1 = duration(m1Seconds)

    const pMs = parseMs(row.p_created_at)
    const pValid = pMs !== null && pMs > createdMs && pMs <= nowMs
    let currentEstimate: NonNullable<ChannelView['currentEstimate']>
    let openOrderAgeSeconds: number | null
    if (pValid) {
        openOrderAgeSeconds = Math.max(0, Math.floor((nowMs - (pMs as number)) / 1000))
        currentEstimate = { ...duration(adjustSeconds(openOrderAgeSeconds)), source: 'open_order' }
    } else {
        openOrderAgeSeconds = null
        currentEstimate = { ...m1, source: 'last_delivery' }
    }

    return {
        key,
        label: labelFor(key),
        state: 'live',
        headline: estimateHeadline(currentEstimate.seconds / 60),
        tier: strength.tier,
        strengthPct: strength.percent,
        lastDelivery: {
            ...m1,
            placedAt: row.c_created_at as string,
            deliveredAt: row.c_delivered_at as string,
        },
        currentEstimate,
        openOrderAgeSeconds,
    }
}

export function shapeGatewaySignals(rows: GatewaySignalRow[], nowMs: number): ChannelView[] {
    const list = Array.isArray(rows) ? rows : []
    return GATEWAY_ORDER.map(({ key }) =>
        buildChannelView(list.find(r => r && r.key === key), key, nowMs),
    )
}

/** Seconds elapsed since the server computed the payload (server-relative, clock-skew safe). */
export function ageOffsetSeconds(
    generatedAtIso: string,
    serverNowIso: string,
    receivedAtMs: number,
    nowMs: number,
): number {
    const sinceReceipt = (nowMs - receivedAtMs) / 1000
    const fallback = Number.isFinite(sinceReceipt) ? Math.max(0, sinceReceipt) : 0
    const gen = parseMs(generatedAtIso)
    const srv = parseMs(serverNowIso)
    if (gen === null || srv === null || !Number.isFinite(sinceReceipt)) return fallback
    const total = (srv - gen) / 1000 + sinceReceipt
    return Number.isFinite(total) ? Math.max(0, total) : fallback
}

/** Recompute current estimate + headline as time passes. Never mutates; base age is kept. */
export function liveEstimate(view: ChannelView, offsetSeconds: number): ChannelView {
    if (view.state !== 'live' || view.openOrderAgeSeconds === null) return view
    const seconds = adjustSeconds(view.openOrderAgeSeconds + safe(offsetSeconds))
    const currentEstimate = { ...duration(seconds), source: 'open_order' as const }
    return {
        ...view,
        headline: estimateHeadline(seconds / 60),
        currentEstimate,
    }
}
