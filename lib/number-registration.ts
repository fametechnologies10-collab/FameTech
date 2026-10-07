// lib/number-registration.ts
// -----------------------------------------------------------------------------
// MTN number-registration gate.
//
// New supplier rule: MTN recipient numbers must be pre-registered with the
// supplier before they can receive data. This module decides, at order-creation
// time, whether a given recipient should be HELD as 'queued' (unregistered MTN
// number, gate on) or fulfilled normally as 'pending'.
//
// Design invariants:
//   * MTN only — non-MTN networks are never gated.
//   * FAIL OPEN — any error returns queue=false. A registry hiccup must never
//     block or lose a paid sale; worst case an unregistered number is dispatched
//     and fails at the supplier (recoverable), which is strictly better than
//     dropping the order.
//   * TRACK FIRST — unknown MTN numbers are recorded (status 'new') even when the
//     gate is OFF, so the admin console can surface and export them before the
//     gate is switched on.
//   * Uses the SERVICE-ROLE client internally: number_registrations is admin-RLS
//     only, so a route/user client cannot read or write it.
// -----------------------------------------------------------------------------
import { createServerClient } from '@/lib/supabase'
import { validateGhanaianPhone } from '@/lib/phone-validation'

const GATE_KEY = 'number_registration_gate_enabled'
const GATE_CACHE_MS = 60_000

let gateCache: { value: boolean; at: number } | null = null

/** Canonicalize any Ghana number to 0XXXXXXXXX, or null if unparseable. */
export function canonicalizePhone(raw: string | null | undefined): string | null {
    if (!raw) return null
    const res = validateGhanaianPhone(raw)
    return res.isValid ? res.normalizedNumber : null
}

/** True when the order's network is MTN (the only gated network). */
export function isMtnNetwork(network: string | null | undefined): boolean {
    return (network || '').trim().toUpperCase() === 'MTN'
}

/** Read the gate toggle from admin_settings (60s cache, fail-closed→OFF). */
export async function isGateEnabled(): Promise<boolean> {
    const now = Date.now()
    if (gateCache && now - gateCache.at < GATE_CACHE_MS) return gateCache.value
    try {
        const supabase = createServerClient()
        const { data } = await (supabase.from('admin_settings') as any)
            .select('value')
            .eq('key', GATE_KEY)
            .maybeSingle()
        const enabled = data?.value === true || data?.value === 'true'
        gateCache = { value: enabled, at: now }
        return enabled
    } catch (e) {
        console.error('[number-registration] failed to read gate toggle:', e)
        return gateCache?.value ?? false
    }
}

export interface QueueDecision {
    /** True → hold the order as 'queued' (do NOT dispatch). */
    queue: boolean
    /** Canonical 0XXXXXXXXX form, or null if unparseable / non-MTN. */
    canonicalPhone: string | null
}

/**
 * Decide whether an order should be queued for number registration.
 * Also TRACKS unknown MTN numbers (idempotent) so admins can export them.
 * Safe to call for any order; returns {queue:false} for non-MTN / errors.
 *
 * Callers should only invoke this for auto-fulfillable data orders (skip mashup,
 * which is manually fulfilled regardless).
 */
export async function resolveOrderQueueing(
    rawPhone: string | null | undefined,
    network: string | null | undefined,
): Promise<QueueDecision> {
    try {
        if (!isMtnNetwork(network)) return { queue: false, canonicalPhone: null }

        const canonicalPhone = canonicalizePhone(rawPhone)
        if (!canonicalPhone) return { queue: false, canonicalPhone: null }

        const supabase = createServerClient() as any
        const { data: reg } = await supabase.from('number_registrations')
            .select('status')
            .eq('phone_number', canonicalPhone)
            .maybeSingle()

        // Already registered with the supplier → fulfill normally.
        if (reg?.status === 'registered') return { queue: false, canonicalPhone }

        // Track-first: record the unknown number (idempotent; never downgrades an
        // existing 'submitted'/'registered' row thanks to ignoreDuplicates).
        await supabase.from('number_registrations').upsert(
            { phone_number: canonicalPhone, network: 'MTN', status: 'new', source: 'order' },
            { onConflict: 'phone_number', ignoreDuplicates: true },
        )

        const gateOn = await isGateEnabled()
        return { queue: gateOn, canonicalPhone }
    } catch (e) {
        console.error('[number-registration] gate error (failing open):', e)
        return { queue: false, canonicalPhone: null }
    }
}

/** Test/diagnostic helper: reset the in-memory gate cache. */
export function __resetGateCache() {
    gateCache = null
}
