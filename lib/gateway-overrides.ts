import type { SupabaseClient } from '@supabase/supabase-js'
import { buildChannelView, type DownSnapshot, type GatewaySignalRow } from '@/lib/gateway-estimate'
import type { OverrideRow } from '@/lib/gateway-override-shared'

export { OVERRIDE_CHANNELS, parseOverrideBody } from '@/lib/gateway-override-shared'
export type { ParsedOverrideBody, OverrideRow } from '@/lib/gateway-override-shared'

const TABLE = 'gateway_status_overrides'

/**
 * Fresh live numbers for the "last delivery" shown while a channel is down, computed as if the
 * channel were NOT down so a stale override row can't hide them. Best-effort: any failure
 * (e.g. the signals RPC is broken) yields null so marking a network DOWN never fails because of it.
 * A channel with no valid C yields an object of nulls.
 */
export async function buildDownSnapshot(
    fetchSignals: () => Promise<GatewaySignalRow[]>,
    channel: string,
    nowMs: number,
): Promise<DownSnapshot | null> {
    try {
        const rows = await fetchSignals()
        const row = rows.find((r) => r.key === channel)
        const view = buildChannelView(row ? { ...row, is_manually_down: false } : undefined, channel, nowMs)
        return {
            lastSeconds: view.lastDelivery?.seconds ?? null,
            lastPlacedAt: view.lastDelivery?.placedAt ?? null,
            lastDeliveredAt: view.lastDelivery?.deliveredAt ?? null,
        }
    } catch {
        console.warn('[gateway-override] snapshot unavailable')
        return null
    }
}

export async function getOverrideRow(admin: SupabaseClient, channel: string): Promise<OverrideRow | null> {
    const { data, error } = await admin.from(TABLE).select('*').eq('channel', channel).maybeSingle()
    if (error) throw new Error('Failed to read gateway override')
    return (data as OverrideRow | null) ?? null
}

export async function listOverrides(admin: SupabaseClient): Promise<OverrideRow[]> {
    const { data, error } = await admin.from(TABLE).select('*').order('channel')
    if (error) throw new Error('Failed to list gateway overrides')
    return (data as OverrideRow[] | null) ?? []
}

/**
 * Read-then-write (not atomic; accepted: admin-only, low traffic).
 * ON from OFF: stamps since + snapshot (lazy). ON while ON: reason only. OFF: clears all.
 */
export async function applyOverride(
    admin: SupabaseClient,
    input: {
        channel: string
        down: boolean
        reason: string | null
        adminId: string
        makeSnapshot: () => Promise<DownSnapshot | null>
    },
): Promise<OverrideRow> {
    const current = await getOverrideRow(admin, input.channel)
    const nowIso = new Date().toISOString()
    let patch: Record<string, unknown>

    if (!input.down) {
        patch = { is_manually_down: false, reason: null, since: null, snapshot: null }
    } else if (current?.is_manually_down) {
        patch = { reason: input.reason }
    } else {
        patch = {
            is_manually_down: true,
            reason: input.reason,
            since: nowIso,
            snapshot: await input.makeSnapshot(),
        }
    }

    const { data, error } = await admin
        .from(TABLE)
        .upsert({ channel: input.channel, ...patch, updated_by: input.adminId, updated_at: nowIso }, { onConflict: 'channel' })
        .select('*')
        .single()
    if (error || !data) throw new Error('Failed to update gateway override')
    return data as OverrideRow
}
