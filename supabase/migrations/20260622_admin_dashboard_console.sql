-- ============================================================================
-- Migration: Admin Fintech Console
-- Date: 2026-06-22
-- Adds:
--   1) get_admin_dashboard_stats()  — EXTENDED (backward-compatible: all prior
--      keys preserved, new revenue/profit/debt/growth keys appended)
--   2) get_admin_dashboard_trends(text) — NEW: gap-filled time-series +
--      network/category/source breakdowns + top packages/agents
--   3) get_admin_recent_activity(int)   — NEW: unified recent activity feed
--   4) admin_settings_audit table + RLS + change-logging trigger on
--      critical keys (fees, kill-switches, page-access)
-- Read RPCs are SECURITY DEFINER (aggregates only); HTTP routes still gate
-- access via validateAdminAccess.
-- ============================================================================

BEGIN;

-- ── 1. Extended dashboard stats ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
    SELECT json_build_object(
        -- Existing keys (unchanged shape) -----------------------------------
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
        -- New revenue / profit windows --------------------------------------
        'revenueToday',   COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE), 0),
        'revenue7d',      COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 6), 0),
        'revenue30d',     COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 29), 0),
        'revenuePrev7d',  COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 13 AND created_at < CURRENT_DATE - 6), 0),
        'revenuePrev30d', COALESCE((SELECT sum(price) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 59 AND created_at < CURRENT_DATE - 29), 0),
        'profitToday', COALESCE((SELECT sum(price - COALESCE(cost_price_at_time,0)) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE), 0),
        'profit7d',    COALESCE((SELECT sum(price - COALESCE(cost_price_at_time,0)) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 6), 0),
        'profit30d',   COALESCE((SELECT sum(price - COALESCE(cost_price_at_time,0)) FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE - 29), 0),
        -- Float / liability --------------------------------------------------
        'outstandingDebt', COALESCE((SELECT sum(amount_owed - amount_settled) FROM public.pending_settlements WHERE status IN ('pending','partially_settled')), 0),
        'debtorCount',     (SELECT count(DISTINCT user_id) FROM public.pending_settlements WHERE status IN ('pending','partially_settled')),
        -- Operational --------------------------------------------------------
        'failedNeedsAction', (SELECT count(*) FROM public.orders WHERE status='failed'),
        -- Growth -------------------------------------------------------------
        'newUsers7d',  (SELECT count(*) FROM public.users WHERE created_at >= CURRENT_DATE - 6),
        'newUsers30d', (SELECT count(*) FROM public.users WHERE created_at >= CURRENT_DATE - 29),
        'roleMix', COALESCE((SELECT json_object_agg(COALESCE(role,'unknown'), c)
                             FROM (SELECT role, count(*) c FROM public.users GROUP BY role) r), '{}'::json)
    ) INTO result;
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ── 2. Trends (time-series + breakdowns) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_trends(p_range text DEFAULT '7d')
RETURNS JSON AS $$
DECLARE
    v_start date;
    v_is_hourly boolean := false;
    series_json json; network_json json; category_json json;
    source_json json; top_pkg_json json; top_agent_json json;
BEGIN
    IF p_range = 'today' THEN
        v_start := CURRENT_DATE; v_is_hourly := true;
    ELSIF p_range = '30d' THEN
        v_start := CURRENT_DATE - 29;
    ELSE
        v_start := CURRENT_DATE - 6;  -- default 7d
    END IF;

    IF v_is_hourly THEN
        SELECT json_agg(t) INTO series_json FROM (
            SELECT to_char(g.b, 'HH24:00') AS bucket,
                   COALESCE(o.revenue,0) AS revenue,
                   COALESCE(o.orders,0)  AS orders,
                   COALESCE(o.profit,0)  AS profit
            FROM generate_series(date_trunc('hour', CURRENT_DATE::timestamp),
                                 date_trunc('hour', now()), interval '1 hour') g(b)
            LEFT JOIN (
                SELECT date_trunc('hour', created_at) hb,
                       sum(price) revenue, count(*) orders,
                       sum(price - COALESCE(cost_price_at_time,0)) profit
                FROM public.orders
                WHERE status='completed' AND created_at >= CURRENT_DATE
                GROUP BY 1
            ) o ON o.hb = g.b
            ORDER BY g.b
        ) t;
    ELSE
        SELECT json_agg(t) INTO series_json FROM (
            SELECT to_char(g.b, 'Mon DD') AS bucket,
                   COALESCE(o.revenue,0) AS revenue,
                   COALESCE(o.orders,0)  AS orders,
                   COALESCE(o.profit,0)  AS profit
            FROM generate_series(v_start::timestamp, CURRENT_DATE::timestamp, interval '1 day') g(b)
            LEFT JOIN (
                SELECT created_at::date db,
                       sum(price) revenue, count(*) orders,
                       sum(price - COALESCE(cost_price_at_time,0)) profit
                FROM public.orders
                WHERE status='completed' AND created_at >= v_start
                GROUP BY 1
            ) o ON o.db = g.b::date
            ORDER BY g.b
        ) t;
    END IF;

    SELECT json_agg(t) INTO network_json FROM (
        SELECT network, sum(price) revenue, count(*) orders
        FROM public.orders WHERE status='completed' AND created_at >= v_start
        GROUP BY network ORDER BY sum(price) DESC
    ) t;

    SELECT json_agg(t) INTO category_json FROM (
        SELECT category, sum(price) revenue, count(*) orders
        FROM public.orders WHERE status='completed' AND created_at >= v_start
        GROUP BY category ORDER BY sum(price) DESC
    ) t;

    SELECT json_agg(t) INTO source_json FROM (
        SELECT source, sum(price) revenue, count(*) orders
        FROM public.orders WHERE status='completed' AND created_at >= v_start
        GROUP BY source ORDER BY sum(price) DESC
    ) t;

    SELECT json_agg(t) INTO top_pkg_json FROM (
        SELECT (network || ' ' || size) AS label, network, size,
               count(*) orders, sum(price) revenue
        FROM public.orders WHERE status='completed' AND created_at >= v_start
        GROUP BY network, size ORDER BY sum(price) DESC LIMIT 5
    ) t;

    SELECT json_agg(t) INTO top_agent_json FROM (
        SELECT o.user_id,
               COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), 'Unknown') AS name,
               sum(o.price) revenue, count(*) orders
        FROM public.orders o
        JOIN public.users u ON u.id = o.user_id
        WHERE o.status='completed' AND o.created_at >= v_start AND u.role = 'agent'
        GROUP BY o.user_id, u.first_name, u.last_name
        ORDER BY sum(o.price) DESC LIMIT 5
    ) t;

    RETURN json_build_object(
        'range', p_range,
        'series',      COALESCE(series_json,  '[]'::json),
        'byNetwork',   COALESCE(network_json, '[]'::json),
        'byCategory',  COALESCE(category_json,'[]'::json),
        'bySource',    COALESCE(source_json,  '[]'::json),
        'topPackages', COALESCE(top_pkg_json, '[]'::json),
        'topAgents',   COALESCE(top_agent_json,'[]'::json)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ── 3. Recent activity feed ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_recent_activity(p_limit int DEFAULT 12)
RETURNS JSON AS $$
DECLARE result json; v_limit int := LEAST(GREATEST(COALESCE(p_limit,12),1),50);
BEGIN
    SELECT COALESCE(json_agg(t), '[]'::json) INTO result FROM (
        SELECT kind, id, label, amount, status, at FROM (
            (SELECT 'order'::text AS kind, o.id::text AS id,
                    (o.network || ' ' || o.size) AS label,
                    o.price::numeric AS amount, COALESCE(o.status,'') AS status, o.created_at AS at
             FROM public.orders o WHERE o.created_at IS NOT NULL
             ORDER BY o.created_at DESC LIMIT v_limit)
            UNION ALL
            (SELECT 'withdrawal'::text, w.id::text,
                    COALESCE(NULLIF(w.description,''),'Withdrawal'),
                    w.amount::numeric, COALESCE(w.status,''), w.created_at
             FROM public.shop_wallet_transactions w
             WHERE w.type='withdrawal' AND w.created_at IS NOT NULL
             ORDER BY w.created_at DESC LIMIT v_limit)
            UNION ALL
            (SELECT 'signup'::text, ('user-' || substr(u.id::text, 1, 8)),
                    COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name),''),'New user'),
                    NULL::numeric, COALESCE(u.role,''), u.created_at
             FROM public.users u WHERE u.created_at IS NOT NULL
             ORDER BY u.created_at DESC LIMIT v_limit)
        ) unioned
        ORDER BY at DESC NULLS LAST
        LIMIT v_limit
    ) t;
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ── 4. Settings audit table + trigger ───────────────────────────────────────
-- NOTE: admin_settings.value is JSONB, so old/new values are stored as jsonb too.
CREATE TABLE IF NOT EXISTS public.admin_settings_audit (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key         text NOT NULL,
    old_value   jsonb,
    new_value   jsonb,
    changed_by  uuid REFERENCES public.users(id),
    changed_at  timestamptz DEFAULT now(),
    source      text
);

ALTER TABLE public.admin_settings_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_settings_audit_select ON public.admin_settings_audit;
CREATE POLICY admin_settings_audit_select ON public.admin_settings_audit
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin'));
-- No INSERT/UPDATE/DELETE policy: rows are written only by the SECURITY DEFINER
-- trigger below (and never mutated). Client writes are blocked by RLS.

CREATE INDEX IF NOT EXISTS idx_admin_settings_audit_changed_at
    ON public.admin_settings_audit (changed_at DESC);

CREATE OR REPLACE FUNCTION public.log_admin_settings_change()
RETURNS trigger AS $$
BEGIN
    IF NEW.key IN (
        'paystack_fee_percent','agent_paystack_fee_percent','dealer_paystack_fee_percent',
        'paystack_min_topup','paystack_max_topup','mtn_price_adjustment','agent_upgrade_price',
        'auto_fulfillment_enabled','ussd_enabled','phone_verification_enabled','page_access_storefront'
    ) AND (TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value) THEN
        INSERT INTO public.admin_settings_audit(key, old_value, new_value, changed_by, source)
        VALUES (NEW.key,
                CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END,
                NEW.value, auth.uid(), 'settings');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS trg_log_admin_settings_change ON public.admin_settings;
CREATE TRIGGER trg_log_admin_settings_change
    AFTER INSERT OR UPDATE ON public.admin_settings
    FOR EACH ROW EXECUTE FUNCTION public.log_admin_settings_change();

-- ── Defense-in-depth note (M-2) ─────────────────────────────────────────────
-- A DB-level CHECK bounding fee values was considered but deferred: admin_settings.value
-- is JSONB (values stored as JSON scalars, e.g. "1.95"), which makes a correct,
-- non-fragile constraint awkward on a live money table. The controls for fee values
-- remain: client-side range validation (settings page), admin-only RLS on writes,
-- and the server-validated /api/admin/settings/toggle route for kill-switches.

-- ── Grants ──────────────────────────────────────────────────────────────────
-- These RPCs return cross-user aggregates (revenue, wallet float, user names,
-- UUIDs). They must NOT be callable directly by browser (authenticated) clients,
-- which would bypass the admin-only HTTP routes. RLS does not gate SECURITY
-- DEFINER execution, so lock execution to service_role — the role used by
-- createServerClient() inside the admin routes. (Also revokes the over-broad
-- authenticated grant previously held by get_admin_dashboard_stats.)
-- IMPORTANT: Supabase's default privileges grant EXECUTE on new public-schema
-- functions to anon, authenticated AND service_role explicitly. Revoking PUBLIC
-- does NOT remove the explicit anon/authenticated grants — they must be named.
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_stats()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_trends(text)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_recent_activity(int)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_admin_dashboard_stats()        TO service_role;
GRANT  EXECUTE ON FUNCTION public.get_admin_dashboard_trends(text)   TO service_role;
GRANT  EXECUTE ON FUNCTION public.get_admin_recent_activity(int)     TO service_role;

-- Trigger function must never be callable as a REST RPC.
REVOKE EXECUTE ON FUNCTION public.log_admin_settings_change()        FROM PUBLIC, anon, authenticated;

COMMIT;
