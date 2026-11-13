// Client-safe: no server-only imports. Shared by the override API and the admin UI.
import { adminShortTextSchema } from '@/lib/validation'
import type { DownSnapshot } from '@/lib/gateway-estimate'

export const OVERRIDE_CHANNELS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'standard_bundles'] as const

export type ParsedOverrideBody =
    | { ok: true; value: { channel: string; down: boolean; reason: string | null } }
    | { ok: false; error: string }

export interface OverrideRow {
    channel: string
    is_manually_down: boolean
    reason: string | null
    since: string | null
    snapshot: DownSnapshot | null
    updated_at: string
    updated_by: string | null
}

export function parseOverrideBody(body: unknown): ParsedOverrideBody {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Invalid request body' }
    }
    const b = body as Record<string, unknown>
    if (typeof b.channel !== 'string' || !(OVERRIDE_CHANNELS as readonly string[]).includes(b.channel)) {
        return { ok: false, error: 'Unknown network' }
    }
    if (typeof b.down !== 'boolean') {
        return { ok: false, error: 'down must be a boolean' }
    }
    let reason: string | null = null
    if (b.reason !== undefined && b.reason !== null) {
        if (typeof b.reason !== 'string') return { ok: false, error: 'reason must be a string' }
        const trimmed = b.reason.trim()
        if (trimmed) {
            const parsed = adminShortTextSchema.safeParse(trimmed)
            if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid reason' }
            reason = trimmed
        }
    }
    return { ok: true, value: { channel: b.channel, down: b.down, reason } }
}
