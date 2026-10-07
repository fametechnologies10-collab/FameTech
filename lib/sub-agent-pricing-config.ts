// lib/sub-agent-pricing-config.ts
// =============================================================================
// Recruiter-facing pricing-config math (Plan 4, Task 4 —
// docs/superpowers/sdd/2026-09-14b-subagent-pricing-and-polish).
//
// This module is the ONE place that translates between the UI-facing "Sub
// price" (an absolute GHS amount) and the stored `markup` column in
// `sub_agent_pricing` / `sub_agent_default_pricing` (spec §4.1 — ALWAYS a
// delta, never an absolute price). Both pricing-config routes
// (app/api/dashboard/subagents/pricing, app/api/dashboard/subagents/[id]/
// pricing) call these functions rather than each re-deriving the arithmetic —
// see scripts/test-sub-agent-pricing-config.ts for the arithmetic's own tests.
//
// Deliberately does NOT touch lib/sub-agent-pricing.ts's resolveSubAgentMarkup
// (the live charge-time resolver) or any of the resolveSubAgent*Cost
// functions — those are reviewed, tested, money-path code from prior plans.
// This module only reads the display markup (a null-preserving variant of the
// same override-then-default precedence, for "not configured yet" vs "0") and
// writes rows into the same two tables those resolvers already read from.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { canOwnSubNetwork, r2, type RoleContext } from '@/lib/pricing/cost-basis'

export type SubAgentProductType = 'data' | 'afa' | 'results_checker'

// ─── Recruiter eligibility ───────────────────────────────────────────────────

export interface RecruiterEligibility {
    ok: boolean
    status: number
    error?: string
    /** Present only when ok — the recruiter's own live role snapshot. */
    recruiterCtx?: RoleContext
}

/**
 * The same recruiter-eligibility gate lib/sub-agent-create.ts's createSubAgent
 * enforces (role literally 'agent'|'dealer' AND canOwnSubNetwork) — reused,
 * not reinvented, per the task brief. Centralised here (rather than inlined
 * separately in both pricing routes) so the two routes share one copy of the
 * lookup + check.
 */
export async function resolveRecruiterEligibility(
    db: SupabaseClient,
    recruiterId: string,
): Promise<RecruiterEligibility> {
    const { data: recruiterUser, error } = await (db as any)
        .from('users')
        .select('id, role, agent_expires_at, dealer_expires_at')
        .eq('id', recruiterId)
        .maybeSingle()

    if (error) {
        console.error('[sub-agent-pricing-config] recruiter eligibility lookup failed', error)
        return { ok: false, status: 500, error: 'Could not verify recruiter eligibility' }
    }

    const role = recruiterUser?.role
    const isEligibleRole = role === 'agent' || role === 'dealer'
    if (!recruiterUser || !isEligibleRole || !canOwnSubNetwork(recruiterUser)) {
        return { ok: false, status: 403, error: 'Only agents and dealers may configure sub-agent pricing' }
    }

    return { ok: true, status: 200, recruiterCtx: recruiterUser }
}

// ─── subPrice <-> markup translation ─────────────────────────────────────────

export interface SubPriceToMarkupResult {
    ok: boolean
    error?: string
    /** Present only when ok. Always >= 0 — the DB CHECK constraint requires it. */
    markup?: number
}

/**
 * Translate a UI-facing absolute "Sub price" into the stored markup delta,
 * validating the floor server-side (spec: subPrice >= yourPrice for every
 * row — never trust a client-side check alone). markup = subPrice - yourPrice,
 * rounded to 2dp same as every other money value in this codebase (see
 * lib/pricing/cost-basis.ts's r2).
 */
export function subPriceToMarkup(subPrice: number, yourPrice: number): SubPriceToMarkupResult {
    if (!Number.isFinite(yourPrice) || yourPrice <= 0) {
        return { ok: false, error: 'Your price is not available for this item' }
    }
    if (!Number.isFinite(subPrice) || subPrice <= 0) {
        return { ok: false, error: 'Sub price must be a positive number' }
    }
    if (subPrice < yourPrice) {
        return { ok: false, error: 'Sub price cannot be below your own price' }
    }
    return { ok: true, markup: r2(subPrice - yourPrice) }
}

/** The inverse translation, used when reading rows back for display. */
export function markupToSubPrice(yourPrice: number | null | undefined, markup: number | null | undefined): number | null {
    if (yourPrice == null || !Number.isFinite(yourPrice)) return null
    const m = markup == null ? NaN : Number(markup)
    if (!Number.isFinite(m)) return null
    return r2(yourPrice + m)
}

// ─── Flat-rate (GHS per GB) data pricing ─────────────────────────────────────

/**
 * Parse a data_packages.size label ("1GB", "1.5GB", ...) into a GB number.
 * Deliberately fails closed (returns 0, which `subPriceToMarkup`'s floor
 * check then rejects as "must be a positive number") rather than silently
 * misreading a sub-GB label — `parseFloat("500MB")` would otherwise return
 * `500` and the flat-rate path would compute `rate × 500`, a ~500x
 * overcharge that sails past the floor validation because it lands far
 * ABOVE yourPrice, not below it (review finding, Task 4). Live
 * `data_packages.size` values are confirmed all "<n>GB"-suffixed today
 * (16 distinct values, 1GB-100GB), so this guard is not yet load-bearing —
 * it exists so a future non-GB label fails the sale outright instead of
 * silently overcharging a sub-agent.
 */
export function parsePackageSizeGb(sizeLabel: string): number {
    const match = /^\s*(\d+(?:\.\d+)?)\s*GB\s*$/i.exec(sizeLabel)
    if (!match) return 0
    const n = parseFloat(match[1])
    return Number.isFinite(n) ? n : 0
}

export function computeFlatRateSubPrice(flatRatePerGB: number, sizeGb: number): number {
    return r2(flatRatePerGB * sizeGb)
}

/**
 * Derives a {ref, subPrice} row per package from a single flat GHS/GB rate —
 * the "mode: 'flat'" input-to-subPrice derivation the task brief calls for.
 * Feeds into the exact same buildValidatedWrites/floor-validation loop that
 * "mode: 'package'" rows go through — same write path either way.
 */
export function buildFlatRateRows(
    flatRatePerGB: number,
    packages: Array<{ packageId: string; sizeLabel: string }>,
): Array<{ ref: string; subPrice: number }> {
    return packages.map((p) => ({
        ref: p.packageId,
        subPrice: computeFlatRateSubPrice(flatRatePerGB, parsePackageSizeGb(p.sizeLabel)),
    }))
}

/**
 * Derives a {ref, subPrice} row per ref where subPrice = yourPrice exactly
 * (0 markup) — the "match parent's price" toggle. A ref missing from
 * yourPriceByRef is dropped, not defaulted to 0 — same "don't fabricate a
 * price" posture as the rest of this module. Feeds into the same
 * buildValidatedWrites path as every other mode (markup: 0 is a fully legal,
 * distinguishable-from-unconfigured state).
 */
export function buildMatchParentPriceRows(
    refs: string[],
    yourPriceByRef: Map<string, number>,
): Array<{ ref: string; subPrice: number }> {
    return refs
        .filter((ref) => yourPriceByRef.has(ref))
        .map((ref) => ({ ref, subPrice: yourPriceByRef.get(ref)! }))
}

// ─── Recruiter markup ceiling (data packages only) ───────────────────────────

/**
 * Platform-wide ceiling on what a recruiter may charge a sub-agent ABOVE their
 * own cost — data packages only (2026-09-18, explicit operator decision): a
 * flat GHS 5 per GB, so 1GB tops out at a GHS 5 markup, 2GB at GHS 10, 3GB at
 * GHS 15, and so on. AFA and results-checker have no GB unit to key a per-GB
 * cap off, so they are deliberately NOT covered here — kept simple per the
 * request that introduced this, promote to an admin_settings row (matching
 * every other fee in this codebase) only if it ever needs to change without a
 * deploy.
 */
export const MAX_MARKUP_PER_GB = 5

export interface MarkupCeilingResult {
    ok: boolean
    error?: string
}

/**
 * Enforces MAX_MARKUP_PER_GB against a set of already-translated markup
 * writes for the 'data' product type. Rejects the WHOLE batch on the first
 * violation — same fail-the-batch posture as buildValidatedWrites, which this
 * always runs directly after. Every caller passes writes it already produced
 * via subPriceToMarkup/buildValidatedWrites, so this only ever needs to check
 * the delta, not re-derive a price.
 */
export function enforceMarkupCeiling(
    writes: PricingWriteRow[],
    sizeGbByRef: Map<string, number>,
): MarkupCeilingResult {
    for (const w of writes) {
        const sizeGb = sizeGbByRef.get(w.productRef)
        if (sizeGb == null || sizeGb <= 0) {
            // Mirrors parsePackageSizeGb's own fail-closed posture: an
            // unparseable size label must block the write, not silently skip
            // the cap.
            return { ok: false, error: `Could not determine package size for item: ${w.productRef}` }
        }
        const maxMarkup = r2(MAX_MARKUP_PER_GB * sizeGb)
        if (w.markup > maxMarkup) {
            return {
                ok: false,
                error: `Markup of GHS ${w.markup.toFixed(2)} exceeds the maximum allowed for this package — GHS ${maxMarkup.toFixed(2)} for ${sizeGb}GB at GHS ${MAX_MARKUP_PER_GB}/GB.`,
            }
        }
    }
    return { ok: true }
}

// ─── Row-set validation ──────────────────────────────────────────────────────

export interface PricingWriteRow {
    productRef: string
    markup: number
}

export type BuildWritesResult =
    | { ok: true; writes: PricingWriteRow[] }
    | { ok: false; error: string }

/**
 * Validates a full set of {ref, subPrice} rows against each ref's "your
 * price" and turns them into markup writes. Fails the WHOLE batch on the
 * first bad row (unknown ref, or subPrice < yourPrice) — a PUT either saves
 * cleanly or saves nothing, never a partial section.
 */
export function buildValidatedWrites(
    rows: Array<{ ref: string; subPrice: number }>,
    yourPriceByRef: Map<string, number>,
): BuildWritesResult {
    if (rows.length === 0) {
        return { ok: false, error: 'No rows provided' }
    }
    // Reject a duplicate ref with a clean 400 rather than letting two rows
    // sharing the same (productType, productRef) reach the upsert, where
    // Postgres's ON CONFLICT DO UPDATE rejects a batch affecting the same
    // conflict key twice — surfacing as a generic 500 (review finding, Task 4).
    const seenRefs = new Set<string>()
    for (const row of rows) {
        if (seenRefs.has(row.ref)) {
            return { ok: false, error: `Duplicate item in request: ${row.ref}` }
        }
        seenRefs.add(row.ref)
    }
    const writes: PricingWriteRow[] = []
    for (const row of rows) {
        const yourPrice = yourPriceByRef.get(row.ref)
        if (yourPrice == null) {
            return { ok: false, error: `Unknown item: ${row.ref}` }
        }
        const result = subPriceToMarkup(row.subPrice, yourPrice)
        if (!result.ok || result.markup == null) {
            return { ok: false, error: result.error ?? 'Invalid price' }
        }
        writes.push({ productRef: row.ref, markup: result.markup })
    }
    return { ok: true, writes }
}

// ─── Bulk markup read (for GET's override-over-default display) ─────────────

type MarkupKey = string
function markupKey(productType: SubAgentProductType, productRef: string): MarkupKey {
    return `${productType}:${productRef}`
}

/** All of a recruiter's own default-pricing rows, as one map — one query, not N. */
export async function fetchDefaultMarkupMap(
    db: SupabaseClient,
    recruiterId: string,
): Promise<Map<MarkupKey, number>> {
    const { data, error } = await (db as any)
        .from('sub_agent_default_pricing')
        .select('product_type, product_ref, markup')
        .eq('recruiter_id', recruiterId)

    const map = new Map<MarkupKey, number>()
    if (error) {
        console.error('[sub-agent-pricing-config] default markup map fetch failed', error)
        return map
    }
    for (const row of data ?? []) {
        map.set(markupKey(row.product_type, row.product_ref), Number(row.markup))
    }
    return map
}

/** All of one sub's own override rows, as one map — one query, not N. */
export async function fetchOverrideMarkupMap(
    db: SupabaseClient,
    subUserId: string,
): Promise<Map<MarkupKey, number>> {
    const { data, error } = await (db as any)
        .from('sub_agent_pricing')
        .select('product_type, product_ref, markup')
        .eq('sub_user_id', subUserId)

    const map = new Map<MarkupKey, number>()
    if (error) {
        console.error('[sub-agent-pricing-config] override markup map fetch failed', error)
        return map
    }
    for (const row of data ?? []) {
        map.set(markupKey(row.product_type, row.product_ref), Number(row.markup))
    }
    return map
}

/**
 * subPrice for one GET row: override wins over default (mirrors
 * resolveSubAgentMarkup's precedence exactly), else null — "not configured
 * yet" must stay distinguishable from "configured at 0 markup", which is why
 * this is a fresh lookup rather than reusing resolveSubAgentMarkup (that
 * function's contract returns 0 for "not configured", by design, for the
 * charge-time path — not appropriate for this display).
 */
export function resolveSubPriceForRow(
    yourPrice: number,
    productType: SubAgentProductType,
    productRef: string,
    defaultMap: Map<MarkupKey, number>,
    overrideMap?: Map<MarkupKey, number>,
): number | null {
    const key = markupKey(productType, productRef)
    const markup = overrideMap?.get(key) ?? defaultMap.get(key)
    return markupToSubPrice(yourPrice, markup)
}

// ─── Upserts ──────────────────────────────────────────────────────────────────

export interface WriteResult {
    ok: boolean
    error?: string
}

/** Upserts recruiter-wide default markup rows, keyed on (recruiter_id, product_type, product_ref). */
export async function upsertDefaultPricingRows(
    db: SupabaseClient,
    recruiterId: string,
    productType: SubAgentProductType,
    writes: PricingWriteRow[],
): Promise<WriteResult> {
    if (writes.length === 0) return { ok: true }
    const rows = writes.map((w) => ({
        recruiter_id: recruiterId,
        product_type: productType,
        product_ref: w.productRef,
        markup: w.markup,
        updated_at: new Date().toISOString(),
    }))
    const { error } = await (db as any)
        .from('sub_agent_default_pricing')
        .upsert(rows, { onConflict: 'recruiter_id,product_type,product_ref' })
    if (error) {
        console.error('[sub-agent-pricing-config] default pricing upsert failed', error)
        return { ok: false, error: 'Could not save pricing' }
    }
    return { ok: true }
}

/** Upserts per-sub override markup rows, keyed on (sub_user_id, product_type, product_ref). */
export async function upsertSubPricingRows(
    db: SupabaseClient,
    recruiterId: string,
    subUserId: string,
    productType: SubAgentProductType,
    writes: PricingWriteRow[],
): Promise<WriteResult> {
    if (writes.length === 0) return { ok: true }
    const rows = writes.map((w) => ({
        recruiter_id: recruiterId,
        sub_user_id: subUserId,
        product_type: productType,
        product_ref: w.productRef,
        markup: w.markup,
        updated_at: new Date().toISOString(),
    }))
    const { error } = await (db as any)
        .from('sub_agent_pricing')
        .upsert(rows, { onConflict: 'sub_user_id,product_type,product_ref' })
    if (error) {
        console.error('[sub-agent-pricing-config] sub pricing upsert failed', error)
        return { ok: false, error: 'Could not save pricing' }
    }
    return { ok: true }
}
