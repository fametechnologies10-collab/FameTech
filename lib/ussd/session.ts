import type { SupabaseClient } from '@supabase/supabase-js'
import type { USSDState } from './types'

// =============================================================================
// Session persistence helpers
// All DB operations use the service-role client passed in.
// =============================================================================

/** Upsert a session record (called on every Initiation/Response) */
export async function logSessionStep(
    supabase: SupabaseClient,
    sessionId: string,
    mobile: string,
    operator: string,
    platform: string,
): Promise<void> {
    // Atomic upsert+increment — avoids the lost-update race the old read-then-write
    // had when two requests for the same session interleave (retry storms / concurrent
    // Initiation+Response). Analytics-only, so a failure (e.g. RPC not yet migrated) is
    // logged and ignored; the USSD flow continues regardless.
    const { error } = await supabase.rpc('increment_ussd_session_step', {
        p_session_id: sessionId,
        p_mobile: mobile,
        p_operator: operator,
        p_platform: platform,
    })
    if (error) {
        console.error('[USSD] logSessionStep increment failed:', error.message)
        // Fallback: keep the session row visible even when the RPC is missing or
        // broken (prod ran blind 2026-06-30..07-04 because the RPC migration was
        // never applied — telemetry loss masked a real outage). The upsert does
        // not increment `steps`, so counts may lag; visibility beats precision.
        const { error: fallbackError } = await supabase
            .from('ussd_sessions')
            .upsert(
                {
                    session_id: sessionId,
                    mobile,
                    operator,
                    platform,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'session_id' },
            )
        if (fallbackError) console.error('[USSD] logSessionStep fallback upsert failed:', fallbackError.message)
    }
}

/** Save current state when Hubtel sends a Timeout event */
export async function saveInterruptedSession(
    supabase: SupabaseClient,
    sessionId: string,
    mobile: string,
    operator: string,
    state: USSDState,
): Promise<void> {
    await supabase
        .from('ussd_sessions')
        .upsert(
            {
                session_id: sessionId,
                mobile,
                operator,
                platform: 'USSD',
                interrupted_state: state,
                interrupted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'session_id' },
        )
}

/**
 * Fetch the most recent interrupted session for this mobile number
 * within the configured resume window (default 30 min).
 */
export async function getResumeSession(
    supabase: SupabaseClient,
    mobile: string,
    windowMinutes: number,
): Promise<{ session_id: string; interrupted_state: USSDState } | null> {
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

    const { data } = await supabase
        .from('ussd_sessions')
        .select('session_id, interrupted_state')
        .eq('mobile', mobile)
        .eq('completed', false)
        .not('interrupted_state', 'is', null)
        .gte('interrupted_at', cutoff)
        .order('interrupted_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (!data || !data.interrupted_state) return null
    return {
        session_id: data.session_id as string,
        interrupted_state: data.interrupted_state as USSDState,
    }
}

/** Clear interrupted state (user chose "Start fresh" or session completed) */
export async function clearInterruptedSession(
    supabase: SupabaseClient,
    sessionId: string,
): Promise<void> {
    await supabase
        .from('ussd_sessions')
        .update({ interrupted_state: null, interrupted_at: null, updated_at: new Date().toISOString() })
        .eq('session_id', sessionId)
}

/** Mark a session as fully completed */
export async function completeSession(
    supabase: SupabaseClient,
    sessionId: string,
    serviceUsed: string,
): Promise<void> {
    // CAS guard: only the FIRST completion writes, so a late duplicate fulfillment path
    // can't clobber service_used on an already-completed session. Null-safe — matches
    // rows where completed is NULL or false.
    await supabase
        .from('ussd_sessions')
        .update({
            completed: true,
            service_used: serviceUsed,
            interrupted_state: null,
            interrupted_at: null,
            updated_at: new Date().toISOString(),
        })
        .eq('session_id', sessionId)
        .or('completed.is.null,completed.eq.false')
}

/** Save pending order before returning AddToCart so fulfillment can process it */
export async function savePendingOrder(
    supabase: SupabaseClient,
    params: {
        sessionId: string
        mobile: string
        serviceType: 'data' | 'results_checker' | 'afa' | 'airtime' | 'utility' | 'mashup'
        orderPayload: Record<string, unknown>
        userId: string | null
        price: number
        shopId?: string | null
        operator?: string | null   // P2-1: real network operator (mtn/vodafone/airteltigo)
    },
): Promise<void> {
    // P2-2: never mutate an order whose payment has already been claimed
    // (hubtel_order_id set). Otherwise a late re-save in the same session could
    // change the price/payload behind a settled MoMo charge → amount mismatch or
    // wrong item. Pre-payment re-confirms (no claim yet) still upsert normally.
    const { data: existing } = await supabase
        .from('ussd_pending_orders')
        .select('hubtel_order_id')
        .eq('session_id', params.sessionId)
        .maybeSingle()
    if (existing && (existing as any).hubtel_order_id) return

    await supabase.from('ussd_pending_orders').upsert(
        {
            session_id:    params.sessionId,
            mobile:        params.mobile,
            service_type:  params.serviceType,
            order_payload: params.orderPayload,
            user_id:       params.userId ?? null,
            price:         params.price,
            shop_id:       params.shopId ?? null,
            operator:      params.operator ?? null,
            status:        'pending',
            // 20-min window: the clock starts when the MoMo prompt is sent (this
            // row is written right before AddToCart), and MoMo prompts time out in
            // ~2-5 min, so 20 min is a safe upper bound for a legitimate late pay.
            // Keeping it tight bounds how long the status-check cron re-polls an
            // abandoned order through the Fixie static-IP proxy (free tier = 500/mo).
            expires_at:    new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        },
        { onConflict: 'session_id' },
    )
}

/** P2-3: true if a phone is on the abuse blacklist (barred from receiving services). */
export async function isPhoneBlacklisted(supabase: SupabaseClient, phone: string): Promise<boolean> {
    const { data } = await supabase
        .from('phone_blacklist')
        .select('phone_number')
        .eq('phone_number', phone)
        .maybeSingle()
    return !!data
}

/**
 * Hard-expire ancient UNCLAIMED pending orders (48h backstop).
 *
 * Routine expiry is decided by the status-check cron's poll-then-expire flow:
 * a row is only flipped to 'expired' after Hubtel confirms it unpaid (or the
 * charge was never created) past its expires_at — never before it has been
 * polled at least once. Expiring first (the old behaviour) meant one late or
 * failed cron run silently discarded paid-but-callback-missed orders with no
 * refund record. This function only catches rows whose polls kept erroring.
 *
 * Claimed rows (hubtel_order_id set) are excluded: a stamped claim means a
 * fulfillment worker owns the row — expiring it mid-flight let a duplicate
 * callback see 'expired' and answer Hubtel 'failed' for a delivered order.
 */
export async function expireOldPendingOrders(supabase: SupabaseClient): Promise<void> {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    await supabase
        .from('ussd_pending_orders')
        .update({ status: 'expired' })
        .eq('status', 'pending')
        .is('hubtel_order_id', null)
        .lt('created_at', cutoff)
}
