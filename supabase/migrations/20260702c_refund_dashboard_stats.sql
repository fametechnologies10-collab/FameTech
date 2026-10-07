-- 20260702c_refund_dashboard_stats.sql
-- Extend get_admin_dashboard_stats with refund metrics. Revenue/profit already filter status='completed'
-- (so refunds don't inflate them). refundsAmount uses wallet_transactions(source='refund') = money returned
-- to wallets (data/airtime/shop-owner-settle). Paystack guest refunds are tracked via shop_orders.refund_method.
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE result JSON;
BEGIN
    SELECT json_build_object(
        'totalUsers',         (SELECT count(*) FROM public.users),
        'totalOrders',        (SELECT count(*) FROM public.orders),
        'completedOrders',    (SELECT count(*) FROM public.orders WHERE status = 'completed'),
        'pendingOrders',      (SELECT count(*) FROM public.orders WHERE status = 'pending'),
        'totalRevenue',       COALESCE((SELECT sum(price) FROM public.orders WHERE status = 'completed'), 0),
        'totalWalletBalance', COALESCE((SELECT sum(balance) FROM public.wallets), 0),
        'successRate', CASE
            WHEN (SELECT count(*) FROM public.orders) > 0
            THEN round(((SELECT count(*) FROM public.orders WHERE status = 'completed')::float
                       / (SELECT count(*) FROM public.orders)::float) * 100)
            ELSE 0 END,
        'todayOrders',        (SELECT count(*) FROM public.orders WHERE created_at >= CURRENT_DATE),
        'revenueToday',   COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE), 0),
        'revenue7d',      COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 6), 0),
        'revenue30d',     COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 29), 0),
        'revenuePrev7d',  COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 13 AND created_at < CURRENT_DATE - 6), 0),
        'revenuePrev30d', COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 59 AND created_at < CURRENT_DATE - 29), 0),
        'profitToday', COALESCE((SELECT sum(price - COALESCE(cost_price_at_time,0)) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE), 0),
        'profit7d',    COALESCE((SELECT sum(price - COALESCE(cost_price_at_time,0)) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 6), 0),
        'profit30d',   COALESCE((SELECT sum(price - COALESCE(cost_price_at_time,0)) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 29), 0),
        'outstandingDebt', COALESCE((SELECT sum(amount_owed - amount_settled) FROM public.pending_settlements WHERE status IN ('pending','partially_settled')), 0),
        'debtorCount',     (SELECT count(DISTINCT user_id) FROM public.pending_settlements WHERE status IN ('pending','partially_settled')),
        'failedNeedsAction', (SELECT count(*) FROM public.orders WHERE status='failed'),
        'newUsers7d',  (SELECT count(*) FROM public.users WHERE created_at >= CURRENT_DATE - 6),
        'newUsers30d', (SELECT count(*) FROM public.users WHERE created_at >= CURRENT_DATE - 29),
        -- ── Refund metrics (new) ──────────────────────────────────────────────
        'refundedOrders',  (SELECT count(*) FROM public.orders WHERE status='refunded' OR payment_status='refunded'),
        'refundsAmount',   COALESCE((SELECT sum(amount) FROM public.wallet_transactions WHERE source='refund'), 0),
        'refundsToday',    COALESCE((SELECT sum(amount) FROM public.wallet_transactions WHERE source='refund' AND created_at >= CURRENT_DATE), 0),
        'refunds7d',       COALESCE((SELECT sum(amount) FROM public.wallet_transactions WHERE source='refund' AND created_at >= CURRENT_DATE - 6), 0),
        'refunds30d',      COALESCE((SELECT sum(amount) FROM public.wallet_transactions WHERE source='refund' AND created_at >= CURRENT_DATE - 29), 0),
        'roleMix', COALESCE((SELECT json_object_agg(COALESCE(role,'unknown'), c)
                             FROM (SELECT role, count(*) c FROM public.users GROUP BY role) r), '{}'::json)
    ) INTO result;
    RETURN result;
END;
$function$;

-- Preserve the service_role-only lockdown (CREATE OR REPLACE keeps ACL, but be explicit).
REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats() TO service_role;
