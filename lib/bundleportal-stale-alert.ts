// lib/bundleportal-stale-alert.ts
// -----------------------------------------------------------------------------
// Stale-order alert for Bundle Portal — the safety net the v2 webhook migration
// (2026-09-28) deliberately shipped WITHOUT, on the assumption the webhook alone
// would be enough. It isn't: confirmed live the same day that real MTN orders can
// land in Bundle Portal's undocumented "held for review" state (their own sandbox
// docs: "the provider never answered... NOT refunded — this is the case most
// integrations get wrong") with NO webhook event for it (only order.completed/
// failed/cancelled/refunded exist) and NO way to poll — check_status returns
// 410 polling_disabled for every order, confirmed even for a held sandbox order.
//
// So unlike lib/agentportal-reconcile.ts (which polls AgentPortal's own order list
// and can often resolve a stuck order itself), this can only ever ALERT — there is
// no Bundle Portal endpoint left to ask "what happened to this order." An admin
// has to check Bundle Portal's own dashboard by hand.
//
// Threshold and alert shape deliberately mirror lib/agentportal-reconcile.ts's
// STUCK_THRESHOLD_MINS=60 and digest pattern (one alert per run, not one per
// order — an AgentPortal-side stall on 2026-07-26 fired 5 alerts across 8 admin
// devices for a single problem; a digest reads as one event because it is one).
import { createAdminClient } from '@/lib/supabase-admin'

const STUCK_THRESHOLD_MINS = 60
const STUCK_QUERY_LIMIT = 200
const MAX_STUCK_ALERTS_PER_RUN = 20

const supabaseAdmin = createAdminClient()

export interface StaleAlertResult {
    /** Number of bundleportal orders stuck in 'processing' past the threshold. */
    stillStuck: number
    errors: string[]
}

/**
 * Finds Bundle Portal orders stuck in 'processing' for over STUCK_THRESHOLD_MINS and raises
 * ONE digest admin alert if any are found. Never changes an order's status, never refunds —
 * purely a visibility signal for a human to check Bundle Portal's dashboard.
 */
export async function alertStaleBundlePortalOrders(): Promise<StaleAlertResult> {
    const errors: string[] = []
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINS * 60 * 1000).toISOString()

    let stuckOrders: Array<{ id: string; reference_code: string | null; phone_number: string | null; network: string | null; size: string | null; price: number | null; updated_at: string }> = []
    try {
        const { data, error } = await supabaseAdmin
            .from('orders')
            .select('id, reference_code, phone_number, network, size, price, updated_at')
            .eq('fulfillment_method', 'bundleportal')
            .eq('status', 'processing')
            .lt('updated_at', cutoff)
            .order('updated_at', { ascending: true })
            .limit(STUCK_QUERY_LIMIT)

        if (error) {
            errors.push(`Stuck-order query failed: ${error.message}`)
            return { stillStuck: 0, errors }
        }
        stuckOrders = (data as any) || []
    } catch (err: any) {
        errors.push(`Stuck-order query exception: ${err.message}`)
        return { stillStuck: 0, errors }
    }

    const stillStuck = stuckOrders.length
    if (stillStuck === 0) return { stillStuck: 0, errors }

    try {
        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        const { createHash } = await import('crypto')

        const stuckIds = stuckOrders.map(o => o.id)
        const idsToList = stuckOrders.slice(0, MAX_STUCK_ALERTS_PER_RUN)
        const listed = idsToList.map(o => o.reference_code || o.id).join(', ')
        const overflow = stillStuck > idsToList.length ? ` …and ${stillStuck - idsToList.length} more` : ''

        // Dedup is keyed on WHICH orders are stuck, not just "something is stuck": the same
        // standing set stays quiet (sendAdminNewOrderAlert's own dedup), but one more order
        // joining the pile alerts again — mirrors lib/agentportal-reconcile.ts.
        const digestKey = createHash('sha1').update([...stuckIds].sort().join(',')).digest('hex').slice(0, 16)

        const first = stuckOrders[0]
        await sendAdminNewOrderAlert({
            referenceCode: `BP-STUCK-DIGEST-${digestKey}`,
            phoneNumber: first.phone_number || 'N/A',
            network: first.network || 'MTN',
            size: first.size || 'N/A',
            price: first.price ?? 0,
            customerName: 'N/A',
            customerEmail: 'N/A',
            source: 'main_site',
            reason: `⚠️ ${stillStuck} Bundle Portal order(s) unresolved for over ${STUCK_THRESHOLD_MINS} min: ${listed}${overflow}. No webhook event and no status-check endpoint exist for these (v2 has no polling) — check Bundle Portal's own dashboard for their actual state. Nothing was changed automatically and nothing was refunded.`,
        }).catch((e: any) => console.error('[BundlePortalStaleAlert] Alert error:', e))
    } catch (err: any) {
        errors.push(`Stuck-order alert exception: ${err.message}`)
    }

    return { stillStuck, errors }
}
