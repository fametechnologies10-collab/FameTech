// lib/dispatch-claim.ts
//
// Shared claim lifecycle for supplier dispatch, used by every dispatch entry point:
// lib/fulfillment-trigger.ts, lib/refulfillment-service.ts, lib/shop-order-processor.ts,
// lib/api-handlers/data-purchase.ts.
//
// Root cause this replaces: every dispatch path used to flip orders.status to
// 'processing' BEFORE calling the supplier, as a concurrency lock — see
// docs/superpowers/specs/2026-08-24-dispatch-claim-separation-design.md. Anything that
// killed the process between that claim and the eventual accept/revert write stranded
// the order in 'processing' permanently, because every recovery path queries
// status='pending'. Confirmed live: a Vercel 60s timeout mid-fallback-loop stranded 47
// orders on 2026-08-23.
//
// New invariant: orders.status stays 'pending' through the ENTIRE dispatch attempt. A
// dedicated dispatch_claimed_at timestamp is the lock instead. status only moves to
// 'processing' once a supplier has actually accepted the order (acceptDispatch). A
// claim that's never resolved (dead process, crashed lambda, Vercel timeout) simply
// expires after CLAIM_EXPIRY_MINUTES and the order becomes claimable again — no reaper
// cron required.

export const CLAIM_EXPIRY_MINUTES = 10

function expiryCutoff(): string {
    return new Date(Date.now() - CLAIM_EXPIRY_MINUTES * 60 * 1000).toISOString()
}

/**
 * Claims ONE pending order for dispatch to `supplierLabel`. Does NOT touch `status` —
 * it stays 'pending'. Stamps `fulfillment_method` so a supplier webhook landing mid-
 * dispatch (matching on fulfillment_method + status IN ('pending','processing')) can
 * still resolve the order.
 *
 * Returns true if this call now holds the claim (a fresh claim, or a stale one older
 * than CLAIM_EXPIRY_MINUTES that it just reclaimed). Returns false if another process
 * holds a live claim, the order isn't pending, or the UPDATE itself errored.
 */
// NOTE: this project's PostgREST cannot combine a compound `.or()` filter with an
// UPDATE — confirmed by direct diagnostic: even `.update(...).or('status.eq.a,status.eq.b')`
// against the ordinary, long-existing `status` column fails with "column orders.status
// does not exist" (PostgREST error 42703). SELECT + `.or()` works fine on this same
// project; only UPDATE + `.or()` is affected. Every claim primitive below therefore
// expresses "unclaimed OR expired" as two sequential single-condition UPDATE attempts
// (try the common "never claimed" case first, then the "expired claim" case) instead of
// one OR'd UPDATE. The tiny window between the two attempts is a self-healing miss, not
// a correctness risk: a concurrent claimant winning in that window just means this call
// returns false, exactly as if it had lost the single-query race.
export async function claimForDispatch(
    supabase: any,
    orderId: string,
    supplierLabel: string
): Promise<boolean> {
    const { data: freshData, error: freshError } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: new Date().toISOString(), fulfillment_method: supplierLabel })
        .eq('id', orderId)
        .eq('status', 'pending')
        .is('dispatch_claimed_at', null)
        .select('id')
        .maybeSingle()

    if (freshError) {
        console.error(`[DispatchClaim] Claim failed for order ${orderId} (supplier=${supplierLabel}): ${freshError.message}`)
        return false
    }
    if (freshData) return true

    const { data: staleData, error: staleError } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: new Date().toISOString(), fulfillment_method: supplierLabel })
        .eq('id', orderId)
        .eq('status', 'pending')
        .lt('dispatch_claimed_at', expiryCutoff())
        .select('id')
        .maybeSingle()

    if (staleError) {
        console.error(`[DispatchClaim] Claim (stale-reclaim) failed for order ${orderId} (supplier=${supplierLabel}): ${staleError.message}`)
        return false
    }
    return !!staleData
}

/**
 * Variant of claimForDispatch keyed by shop_orders.id instead of orders.id — used by
 * lib/shop-order-processor.ts, which is called with shop_orders.id and resolves the
 * underlying orders row via the shop_order_id foreign key. Returns the claimed order's
 * internal orders.id (needed by callers that must dispatch using the real orders.id, not
 * shop_orders.id — see the AgentPortal/BundlePortal/HendyLinks branches in
 * lib/shop-order-processor.ts for why that distinction matters), or null if the claim
 * failed.
 */
export async function claimForDispatchByShopOrderId(
    supabase: any,
    shopOrderId: string,
    supplierLabel: string
): Promise<string | null> {
    const { data: freshData, error: freshError } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: new Date().toISOString(), fulfillment_method: supplierLabel })
        .eq('shop_order_id', shopOrderId)
        .eq('status', 'pending')
        .is('dispatch_claimed_at', null)
        .select('id')
        .maybeSingle()

    if (freshError) {
        console.error(`[DispatchClaim] Shop-order claim failed for shop_order ${shopOrderId} (supplier=${supplierLabel}): ${freshError.message}`)
        return null
    }
    if (freshData) return (freshData as any).id

    const { data: staleData, error: staleError } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: new Date().toISOString(), fulfillment_method: supplierLabel })
        .eq('shop_order_id', shopOrderId)
        .eq('status', 'pending')
        .lt('dispatch_claimed_at', expiryCutoff())
        .select('id')
        .maybeSingle()

    if (staleError) {
        console.error(`[DispatchClaim] Shop-order claim (stale-reclaim) failed for shop_order ${shopOrderId} (supplier=${supplierLabel}): ${staleError.message}`)
        return null
    }
    return staleData ? (staleData as any).id : null
}

/**
 * Bulk variant of claimForDispatch — claims every id in `ids` still pending and
 * unclaimed-or-expired. Two sequential UPDATEs for the same reason as claimForDispatch
 * (no `.or()` on UPDATE). Returns the union of ids claimed by either pass.
 */
export async function claimBulkForDispatch(
    supabase: any,
    ids: string[],
    supplierLabel: string
): Promise<Set<string>> {
    if (ids.length === 0) return new Set()

    const { data: freshData, error: freshError } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: new Date().toISOString(), fulfillment_method: supplierLabel })
        .in('id', ids)
        .eq('status', 'pending')
        .is('dispatch_claimed_at', null)
        .select('id')

    if (freshError) {
        console.error(`[DispatchClaim] Bulk claim failed for supplier=${supplierLabel}: ${freshError.message}`)
        return new Set()
    }

    const claimed = new Set<string>((freshData || []).map((r: any) => r.id))
    const remainingIds = ids.filter(id => !claimed.has(id))
    if (remainingIds.length === 0) return claimed

    const { data: staleData, error: staleError } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: new Date().toISOString(), fulfillment_method: supplierLabel })
        .in('id', remainingIds)
        .eq('status', 'pending')
        .lt('dispatch_claimed_at', expiryCutoff())
        .select('id')

    if (staleError) {
        console.error(`[DispatchClaim] Bulk claim (stale-reclaim) failed for supplier=${supplierLabel}: ${staleError.message}`)
        return claimed
    }
    for (const r of (staleData || [])) claimed.add((r as any).id)
    return claimed
}

/**
 * Re-stamps fulfillment_method to a FALLBACK supplier while an order is still under an
 * active claim (status still 'pending', dispatch_claimed_at not null) — used between a
 * primary dispatch failure and a fallback attempt, so a webhook landing mid-fallback-
 * dispatch can still resolve the order. This is NOT a fresh claim (it doesn't touch
 * dispatch_claimed_at) and refuses to run once the claim is gone
 * (dispatch_claimed_at IS NULL), which means a concurrent process — most likely a
 * webhook that already resolved the order, or the claim expiring — has taken over.
 *
 * Returns false if the claim was lost; the caller must NOT proceed with the fallback
 * dispatch in that case.
 */
export async function reclaimForFallback(
    supabase: any,
    orderId: string,
    fallbackSupplier: string
): Promise<boolean> {
    const { data, error } = await supabase
        .from('orders')
        .update({ fulfillment_method: fallbackSupplier })
        .eq('id', orderId)
        .eq('status', 'pending')
        .not('dispatch_claimed_at', 'is', null)
        .select('id')
        .maybeSingle()

    if (error) {
        console.error(`[DispatchClaim] Fallback reclaim failed for order ${orderId} (supplier=${fallbackSupplier}): ${error.message}`)
        return false
    }
    if (!data) {
        console.log(`[DispatchClaim] Order ${orderId} claim no longer live — skipping fallback dispatch to ${fallbackSupplier}`)
        return false
    }
    return true
}

/**
 * Marks a claimed order as ACCEPTED by its supplier: pending -> processing, clears the
 * claim, and stamps whatever reference/bookkeeping columns the caller supplies (e.g.
 * codecraft_reference, dakazina_reference). `updated_at` is always set.
 *
 * Returns true if the transition happened. Returns false if 0 rows matched — a webhook
 * already resolved the order first. That is a safe no-op, not a failure: every caller
 * must treat a false return as "someone else already settled this", not as an error to
 * surface.
 */
export async function acceptDispatch(
    supabase: any,
    orderId: string,
    supplierLabel: string,
    extraColumns: Record<string, any> = {}
): Promise<boolean> {
    const { data, error } = await supabase
        .from('orders')
        .update({
            status: 'processing',
            fulfillment_method: supplierLabel,
            dispatch_claimed_at: null,
            updated_at: new Date().toISOString(),
            ...extraColumns,
        })
        .eq('id', orderId)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()

    if (error) {
        console.error(`[DispatchClaim] Accept failed for order ${orderId} (supplier=${supplierLabel}): ${error.message}`)
        return false
    }
    return !!data
}

/**
 * Bulk variant of acceptDispatch — accepts every id in `ids` (still pending) as
 * successfully dispatched. No per-order extra columns — the bulk path writes supplier
 * references in its own separate pass (see lib/refulfillment-service.ts step 12b). This
 * only flips status and clears the claim. Returns the set of ids actually transitioned.
 */
export async function acceptBulkDispatch(
    supabase: any,
    ids: string[]
): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const { data, error } = await supabase
        .from('orders')
        .update({ status: 'processing', dispatch_claimed_at: null, updated_at: new Date().toISOString() })
        .in('id', ids)
        .eq('status', 'pending')
        .select('id')

    if (error) {
        console.error(`[DispatchClaim] Bulk accept failed: ${error.message}`)
        return new Set()
    }
    return new Set((data || []).map((r: any) => r.id))
}

/**
 * Releases a claim after a DEFINITE rejection (never for an ambiguous one — those stay
 * claimed-then-accepted-anyway, see each call site's ambiguous branch). Clears the claim
 * and fulfillment_method; `status` needs no revert since it never left 'pending'.
 * Guarded on status='pending' so it can never clobber an order a webhook already
 * resolved to 'processing'/'completed'/'failed'.
 *
 * Returns true if released. Returns false if 0 rows matched — already resolved
 * elsewhere; log and move on, never treat as an error.
 */
export async function releaseClaim(supabase: any, orderId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: null, fulfillment_method: null })
        .eq('id', orderId)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()

    if (error) {
        console.error(`[DispatchClaim] Release failed for order ${orderId}: ${error.message}`)
        return false
    }
    return !!data
}

/** Bulk variant of releaseClaim. Returns the set of ids actually released. */
export async function releaseBulkClaims(supabase: any, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const { data, error } = await supabase
        .from('orders')
        .update({ dispatch_claimed_at: null, fulfillment_method: null })
        .in('id', ids)
        .eq('status', 'pending')
        .select('id')

    if (error) {
        console.error(`[DispatchClaim] Bulk release failed: ${error.message}`)
        return new Set()
    }
    return new Set((data || []).map((r: any) => r.id))
}
