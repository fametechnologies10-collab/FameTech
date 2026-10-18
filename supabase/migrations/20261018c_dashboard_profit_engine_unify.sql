-- supabase/migrations/20261018c_dashboard_profit_engine_unify.sql
-- =============================================================================
-- Make the admin dashboard read the SAME profit engine as Profit History.
--
-- THE BUG. This project carried two independent profit engines:
--
--   /admin                  -> get_admin_dashboard_stats() / _trends()
--                              sum(price - COALESCE(cost_price_at_time,0))
--                              over public.orders, and nothing else.
--   /admin/profits-history  -> get_profit_summary_v2() -> _profit_totals_v2()
--                              8 product categories, audited (20260928*).
--
-- The first is an inherited one-liner and it is wrong four ways:
--
--  1. STOREFRONT ORDERS ARE INVERTED -- the dominant error. A shop sale is
--     mirrored into `orders` (lib/shop-order-processor.ts:395-408) with
--     price = verifiedSellingPrice (what the storefront CUSTOMER paid) and
--     cost_price_at_time = verifiedCostPrice (what the SHOP OWNER paid us).
--     price - cost is therefore the shop owner's OWN margin, which we later
--     credit to their wallet. The platform's real margin on that order is
--     shop_orders.cost_price - shop_orders.admin_cost_at_time, which the old
--     formula never saw. Measured on live data 2026-10-18: a GHS 5.50 sale
--     with cost 4.20 and admin_cost 3.90 reported GHS 1.30 profit instead of
--     the true GHS 0.30 -- it booked the reseller's profit as ours AND
--     dropped our own. The error grows with OUR RESELLERS' markups.
--  2. IT ONLY READS `orders` -- airtime, utilities, AFA, results checker,
--     subscriptions, SMS bundles and USSD activations all contributed 0.
--     A real GHS 9.99 subscription was invisible on the 30d tile.
--  3. COALESCE(cost_price_at_time,0) treats unknown cost as FREE, i.e. 100%
--     margin. _profit_totals_v2 excludes such rows and reports the count.
--  4. No sub_agent_order_earnings deduction -- a recruiter's margin counted as
--     platform profit.
--
-- THE FIX. Delete the second engine rather than patch it. Revenue moves over
-- with profit: leaving revenue as orders-only gross while profit spans 8
-- categories lets profit exceed revenue on a subscription-heavy period.
--
-- DB TimeZone is UTC and Ghana is UTC+0, so the CURRENT_DATE boundaries used
-- here coincide exactly with the local-midnight boundaries the Profit History
-- page computes in the browser (app/admin/profits-history/page.tsx:145-147).
-- That is what lets the two pages agree to the pesewa.
--
-- Guarded by scripts/verify-profit-engine-parity.ts, which asserts the two pages
-- return identical revenue and profit for identical windows.
--
-- Deliberately NOT changed: the byNetwork / byCategory / bySource /
-- topPackages / topAgents breakdowns still aggregate `orders` by
-- network/category/size, because those columns only exist for data orders.
-- Their headings gained a "Data orders" qualifier in the UI instead, so the
-- headline revenue no longer reads as the sum of the panels below it.
--
-- Applied to the live project via apply_migration/execute_sql on 2026-10-18 in
-- the three stages below, in this order. Saved here for repo history per
-- CLAUDE.md's DB-migrations convention.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- STAGE 1. _profit_ts_rows_v2 -- the contributing-row stream at TIMESTAMP
-- grain, and _profit_daily_rows_v2 reduced to a wrapper over it.
--
-- The dashboard chart buckets HOURLY for its "today" range, which
-- _profit_daily_rows_v2 cannot express (it emits a date). Rather than add a
-- THIRD hand-synced copy of the 10-category union, this becomes the single
-- source. Body is _profit_daily_rows_v2's, verbatim from
-- 20260928c_profit_engine_v2_rc_afa_ussd_fix.sql (confirmed against the live
-- function first), with each category's `<col>::date AS day` replaced by
-- `<col> AS at` -- so `at::date` reproduces the old `day` exactly, per
-- category. Verified behaviour-preserving: the 30d output of
-- _profit_daily_rows_v2 was fingerprinted before and after and was identical
-- (md5 870fcce2f0aca42ec6067644d5a13d79, 28 rows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._profit_ts_rows_v2(
    p_start_date timestamptz,
    p_end_date timestamptz,
    p_product_types text[],
    p_network text
)
RETURNS TABLE (at timestamptz, revenue numeric, cost numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH flags AS (
    SELECT
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'data' = ANY(p_product_types)) AS inc_data,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'airtime' = ANY(p_product_types)) AS inc_airtime,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'utility' = ANY(p_product_types)) AS inc_utility,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'afa' = ANY(p_product_types)) AS inc_afa,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'results_checker' = ANY(p_product_types)) AS inc_rc,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'subscriptions' = ANY(p_product_types)) AS inc_sub,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'sms' = ANY(p_product_types)) AS inc_sms,
      (p_product_types IS NULL OR array_length(p_product_types,1) IS NULL OR 'ussd_activation' = ANY(p_product_types)) AS inc_ussd,
      (p_network IS NOT NULL AND p_network <> 'all') AS net_filter
  ),
  afa_setting AS (
    SELECT NULLIF(trim(both '"' from value::text), '')::numeric AS afa_cost
    FROM public.admin_settings WHERE key = 'afa_cost_price'
  ),
  sms_setting AS (
    SELECT COALESCE(
      (SELECT NULLIF(trim(both '"' from value::text), '')::numeric FROM public.admin_settings WHERE key = 'sms_cost_per_segment'),
      0.243
    ) AS sms_cost_per_segment
  ),
  ussd_setting AS (
    SELECT COALESCE(
      (SELECT NULLIF(trim(both '"' from value::text), '')::numeric FROM public.admin_settings WHERE key = 'ussd_shop_activation_fee'),
      50
    ) AS fee
  ),

  data_main AS (
    SELECT o.created_at AS at, o.price AS revenue, o.cost_price_at_time + COALESCE(sae.amount,0) AS cost
    FROM public.orders o
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'orders' AND sae.order_reference = o.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_data AND o.status = 'completed' AND o.shop_order_id IS NULL AND o.cost_price_at_time > 0
      AND o.created_at BETWEEN p_start_date AND p_end_date
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND o.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND o.network = p_network)
      )
  ),
  data_shop AS (
    SELECT so.created_at AS at, so.cost_price AS revenue, so.admin_cost_at_time + COALESCE(sae.amount,0) AS cost
    FROM public.shop_orders so
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'shop_orders' AND sae.order_reference = COALESCE(so.paystack_reference, so.id::text) AND sae.status IN ('pending','credited')
    WHERE f.inc_data AND so.status = 'completed' AND so.admin_cost_at_time IS NOT NULL AND so.admin_cost_at_time > 0
      AND so.package_id IS NOT NULL
      AND so.created_at BETWEEN p_start_date AND p_end_date
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND so.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND so.network = p_network)
      )
  ),
  airtime_rows AS (
    SELECT ao.created_at AS at,
      ao.admin_fee_amount + COALESCE(ao.commission_amount,0) AS revenue,
      COALESCE(ao.partner_commission_amount,0) AS cost
    FROM public.airtime_orders ao
    CROSS JOIN flags f
    WHERE f.inc_airtime AND ao.status = 'completed'
      AND ao.created_at BETWEEN p_start_date AND p_end_date
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND ao.network = 'AT')
        OR (p_network <> 'AirtelTigo' AND ao.network = p_network)
      )
  ),
  utility_rows AS (
    SELECT uo.created_at AS at, COALESCE(uo.commission_amount,0) AS revenue, COALESCE(uo.partner_commission_amount,0) AS cost
    FROM public.utility_orders uo
    CROSS JOIN flags f
    WHERE f.inc_utility AND uo.status = 'completed'
      AND uo.created_at BETWEEN p_start_date AND p_end_date
  ),
  afa_rows AS (
    SELECT ao.created_at AS at,
      CASE WHEN ao.shop_id IS NOT NULL THEN ao.cost_price ELSE COALESCE(ao.payment_amount, ao.selling_price, 0) END AS revenue,
      s.afa_cost + COALESCE(sae.amount,0) AS cost
    FROM public.afa_orders ao
    CROSS JOIN flags f
    CROSS JOIN afa_setting s
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'afa_orders' AND sae.order_reference = ao.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_afa AND s.afa_cost IS NOT NULL AND ao.status = 'completed'
      AND ao.created_at BETWEEN p_start_date AND p_end_date
  ),
  rc_rows AS (
    SELECT rco.created_at AS at,
      (rco.total_paid - COALESCE(rco.shop_markup, 0) * rco.quantity - COALESCE(rco.fee_amount, 0)) AS revenue,
      (rco.cost_price_at_time * rco.quantity) + COALESCE(sae.amount,0) AS cost
    FROM public.results_checker_orders rco
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'results_checker_orders' AND sae.order_reference = rco.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_rc AND rco.status = 'completed' AND rco.cost_price_at_time IS NOT NULL AND rco.cost_price_at_time >= 0
      AND rco.created_at BETWEEN p_start_date AND p_end_date
  ),
  sub_rows AS (
    SELECT wt.created_at AS at, wt.amount AS revenue, 0::numeric AS cost
    FROM public.wallet_transactions wt
    CROSS JOIN flags f
    WHERE f.inc_sub AND wt.type = 'debit' AND wt.status = 'completed'
      AND wt.source = 'purchase' AND wt.reference LIKE 'upgrade\_%' ESCAPE '\'
      AND wt.created_at BETWEEN p_start_date AND p_end_date
  ),
  sms_bundle_rows AS (
    SELECT ssp.created_at AS at, ssp.price AS revenue, ssp.credits * sm.sms_cost_per_segment AS cost
    FROM public.shop_sms_purchases ssp
    CROSS JOIN flags f
    CROSS JOIN sms_setting sm
    WHERE f.inc_sms AND ssp.created_at BETWEEN p_start_date AND p_end_date
  ),
  sms_activation_rows AS (
    SELECT ssa.created_at AS at, ssa.amount_paid AS revenue, 0::numeric AS cost
    FROM public.shop_sms_activations ssa
    CROSS JOIN flags f
    WHERE f.inc_sms AND ssa.created_at BETWEEN p_start_date AND p_end_date
  ),
  ussd_rows AS (
    SELECT sp.ussd_activated_at AS at, COALESCE(wt.amount, us.fee) AS revenue, 0::numeric AS cost
    FROM public.shop_profiles sp
    CROSS JOIN flags f
    CROSS JOIN ussd_setting us
    LEFT JOIN public.wallet_transactions wt
      ON wt.type = 'debit' AND wt.status = 'completed' AND wt.reference = 'USSDACT-' || sp.id::text
    WHERE f.inc_ussd AND sp.ussd_activated_at IS NOT NULL
      AND sp.ussd_activated_at BETWEEN p_start_date AND p_end_date
  )

  SELECT at, revenue, cost FROM data_main
  UNION ALL SELECT at, revenue, cost FROM data_shop
  UNION ALL SELECT at, revenue, cost FROM airtime_rows
  UNION ALL SELECT at, revenue, cost FROM utility_rows
  UNION ALL SELECT at, revenue, cost FROM afa_rows
  UNION ALL SELECT at, revenue, cost FROM rc_rows
  UNION ALL SELECT at, revenue, cost FROM sub_rows
  UNION ALL SELECT at, revenue, cost FROM sms_bundle_rows
  UNION ALL SELECT at, revenue, cost FROM sms_activation_rows
  UNION ALL SELECT at, revenue, cost FROM ussd_rows
$fn$;

REVOKE ALL ON FUNCTION public._profit_ts_rows_v2(timestamptz, timestamptz, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._profit_ts_rows_v2(timestamptz, timestamptz, text[], text) TO service_role;

CREATE OR REPLACE FUNCTION public._profit_daily_rows_v2(
    p_start_date timestamptz,
    p_end_date timestamptz,
    p_product_types text[],
    p_network text
)
RETURNS TABLE (day date, revenue numeric, cost numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT r.at::date AS day, r.revenue, r.cost
  FROM public._profit_ts_rows_v2(p_start_date, p_end_date, p_product_types, p_network) r
$fn$;

REVOKE ALL ON FUNCTION public._profit_daily_rows_v2(timestamptz, timestamptz, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._profit_daily_rows_v2(timestamptz, timestamptz, text[], text) TO service_role;


-- ---------------------------------------------------------------------------
-- STAGE 2. get_admin_dashboard_stats / get_admin_dashboard_trends now read the
-- v2 engine.
--
-- stats: revenueToday/7d/30d, revenuePrev7d/30d, profitToday/7d/30d all come
-- from _profit_totals_v2, and pendingOrders now counts 'processing' too,
-- matching the route's own fallback branch (app/api/admin/stats/route.ts:31).
-- `totalRevenue` is deliberately left as all-time gross sum(price) over
-- `orders`: it is not rendered anywhere in the admin console today (the KPI
-- strip reads only the windowed fields), so changing it would be unverifiable
-- churn. Revisit if it is ever surfaced.
--
-- trends: the Revenue & Profit series comes from _profit_ts_rows_v2, so the
-- chart cannot disagree with the tile above it. `orders` per bucket becomes
-- the count of revenue-contributing records across all 8 categories -- the
-- same definition as get_profit_summary_v2's total_orders, so the Orders tile
-- reconciles with Profit History too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
    result JSON;
    v_today_start   timestamptz := CURRENT_DATE;
    v_day_end       timestamptz := CURRENT_DATE + interval '1 day' - interval '1 microsecond';
    v_w7_start      timestamptz := CURRENT_DATE - 6;
    v_w30_start     timestamptz := CURRENT_DATE - 29;
    v_p7_start      timestamptz := CURRENT_DATE - 13;
    v_p7_end        timestamptz := (CURRENT_DATE - 6)::timestamptz - interval '1 microsecond';
    v_p30_start     timestamptz := CURRENT_DATE - 59;
    v_p30_end       timestamptz := (CURRENT_DATE - 29)::timestamptz - interval '1 microsecond';
    v_rev_today numeric;  v_profit_today numeric;
    v_rev_7d numeric;     v_profit_7d numeric;
    v_rev_30d numeric;    v_profit_30d numeric;
    v_rev_prev7 numeric;  v_rev_prev30 numeric;
BEGIN
    SELECT COALESCE(SUM(revenue),0), COALESCE(SUM(profit),0)
      INTO v_rev_today, v_profit_today
      FROM public._profit_totals_v2(v_today_start, v_day_end, NULL, NULL);

    SELECT COALESCE(SUM(revenue),0), COALESCE(SUM(profit),0)
      INTO v_rev_7d, v_profit_7d
      FROM public._profit_totals_v2(v_w7_start, v_day_end, NULL, NULL);

    SELECT COALESCE(SUM(revenue),0), COALESCE(SUM(profit),0)
      INTO v_rev_30d, v_profit_30d
      FROM public._profit_totals_v2(v_w30_start, v_day_end, NULL, NULL);

    SELECT COALESCE(SUM(revenue),0) INTO v_rev_prev7
      FROM public._profit_totals_v2(v_p7_start, v_p7_end, NULL, NULL);

    SELECT COALESCE(SUM(revenue),0) INTO v_rev_prev30
      FROM public._profit_totals_v2(v_p30_start, v_p30_end, NULL, NULL);

    SELECT json_build_object(
        'totalUsers',         (SELECT count(*) FROM public.users),
        'totalOrders',        (SELECT count(*) FROM public.orders),
        'completedOrders',    (SELECT count(*) FROM public.orders WHERE status = 'completed'),
        'pendingOrders',      (SELECT count(*) FROM public.orders WHERE status IN ('pending','processing')),
        'totalRevenue',       COALESCE((SELECT sum(price) FROM public.orders WHERE status = 'completed'), 0),
        'totalWalletBalance', COALESCE((SELECT sum(balance) FROM public.wallets), 0),
        'successRate', CASE
            WHEN (SELECT count(*) FROM public.orders) > 0
            THEN round(((SELECT count(*) FROM public.orders WHERE status = 'completed')::float
                       / (SELECT count(*) FROM public.orders)::float) * 100)
            ELSE 0 END,
        'todayOrders',        (SELECT count(*) FROM public.orders WHERE created_at >= CURRENT_DATE),
        'revenueToday',   v_rev_today,
        'revenue7d',      v_rev_7d,
        'revenue30d',     v_rev_30d,
        'revenuePrev7d',  v_rev_prev7,
        'revenuePrev30d', v_rev_prev30,
        'profitToday',    v_profit_today,
        'profit7d',       v_profit_7d,
        'profit30d',      v_profit_30d,
        'outstandingDebt', COALESCE((SELECT sum(amount_owed - amount_settled) FROM public.pending_settlements WHERE status IN ('pending','partially_settled')), 0),
        'debtorCount',     (SELECT count(DISTINCT user_id) FROM public.pending_settlements WHERE status IN ('pending','partially_settled')),
        'failedNeedsAction', (SELECT count(*) FROM public.orders WHERE status='failed'),
        'newUsers7d',  (SELECT count(*) FROM public.users WHERE created_at >= CURRENT_DATE - 6),
        'newUsers30d', (SELECT count(*) FROM public.users WHERE created_at >= CURRENT_DATE - 29),
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
$fn$;

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_trends(p_range text DEFAULT '7d'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
    v_start date;
    v_start_ts timestamptz;
    v_end_ts timestamptz := CURRENT_DATE + interval '1 day' - interval '1 microsecond';
    v_is_hourly boolean := false;
    series_json json; network_json json; category_json json;
    source_json json; top_pkg_json json; top_agent_json json;
BEGIN
    IF p_range = 'today' THEN
        v_start := CURRENT_DATE; v_is_hourly := true;
    ELSIF p_range = '30d' THEN
        v_start := CURRENT_DATE - 29;
    ELSE
        v_start := CURRENT_DATE - 6;
    END IF;
    v_start_ts := v_start::timestamptz;

    IF v_is_hourly THEN
        SELECT json_agg(t) INTO series_json FROM (
            SELECT to_char(g.b, 'HH24:00') AS bucket,
                   COALESCE(p.revenue,0) AS revenue, COALESCE(p.orders,0) AS orders, COALESCE(p.profit,0) AS profit
            FROM generate_series(date_trunc('hour', CURRENT_DATE::timestamptz), date_trunc('hour', now()), interval '1 hour') g(b)
            LEFT JOIN (
                SELECT date_trunc('hour', r.at) AS hb,
                       sum(r.revenue) AS revenue, count(*) AS orders, sum(r.revenue - r.cost) AS profit
                FROM public._profit_ts_rows_v2(v_start_ts, v_end_ts, NULL, NULL) r
                GROUP BY 1
            ) p ON p.hb = g.b
            ORDER BY g.b
        ) t;
    ELSE
        SELECT json_agg(t) INTO series_json FROM (
            SELECT to_char(g.b, 'Mon DD') AS bucket,
                   COALESCE(p.revenue,0) AS revenue, COALESCE(p.orders,0) AS orders, COALESCE(p.profit,0) AS profit
            FROM generate_series(v_start_ts, CURRENT_DATE::timestamptz, interval '1 day') g(b)
            LEFT JOIN (
                SELECT r.at::date AS db,
                       sum(r.revenue) AS revenue, count(*) AS orders, sum(r.revenue - r.cost) AS profit
                FROM public._profit_ts_rows_v2(v_start_ts, v_end_ts, NULL, NULL) r
                GROUP BY 1
            ) p ON p.db = g.b::date
            ORDER BY g.b
        ) t;
    END IF;

    -- UNCHANGED below: these group `orders` by network/category/size, columns
    -- only data orders have. The UI headings carry a "Data orders" qualifier.
    SELECT json_agg(t) INTO network_json FROM (
        SELECT network, sum(price) revenue, count(*) orders
        FROM public.orders WHERE status='completed' AND created_at >= v_start GROUP BY network ORDER BY sum(price) DESC
    ) t;
    SELECT json_agg(t) INTO category_json FROM (
        SELECT category, sum(price) revenue, count(*) orders
        FROM public.orders WHERE status='completed' AND created_at >= v_start GROUP BY category ORDER BY sum(price) DESC
    ) t;
    SELECT json_agg(t) INTO source_json FROM (
        SELECT source, sum(price) revenue, count(*) orders
        FROM public.orders WHERE status='completed' AND created_at >= v_start GROUP BY source ORDER BY sum(price) DESC
    ) t;
    SELECT json_agg(t) INTO top_pkg_json FROM (
        SELECT (network || ' ' || size) AS label, network, size, count(*) orders, sum(price) revenue
        FROM public.orders WHERE status='completed' AND created_at >= v_start GROUP BY network, size ORDER BY sum(price) DESC LIMIT 5
    ) t;
    SELECT json_agg(t) INTO top_agent_json FROM (
        SELECT o.user_id, COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), 'Unknown') AS name,
               sum(o.price) revenue, count(*) orders
        FROM public.orders o JOIN public.users u ON u.id = o.user_id
        WHERE o.status='completed' AND o.created_at >= v_start AND u.role = 'agent'
        GROUP BY o.user_id, u.first_name, u.last_name ORDER BY sum(o.price) DESC LIMIT 5
    ) t;

    RETURN json_build_object(
        'range', p_range,
        'series', COALESCE(series_json,'[]'::json), 'byNetwork', COALESCE(network_json,'[]'::json),
        'byCategory', COALESCE(category_json,'[]'::json), 'bySource', COALESCE(source_json,'[]'::json),
        'topPackages', COALESCE(top_pkg_json,'[]'::json), 'topAgents', COALESCE(top_agent_json,'[]'::json)
    );
END;
$fn$;


-- ---------------------------------------------------------------------------
-- STAGE 3. _profit_totals_v2 -- airtime `excluded` flag.
--
-- Was: COUNT(*) FILTER (WHERE commission_amount IS NULL), i.e. "we expected a
-- supplier commission and did not get one, so profit may be understated".
-- That is false on KingFlexyGH: its airtime status endpoint does not return a
-- commission at all (lib/kingflexy-commission-service.ts:319 calls the shared
-- helper with withCommission:false) and finalizeKfAirtime
-- (lib/kingflexy-finalize.ts:89) never writes the column. The old test
-- therefore flagged EVERY airtime order forever -- noise that would hide a
-- genuine exclusion. Live 2026-10-18: 0 of 3 airtime rows carry a commission
-- and there are no 'hubtel-commission' airtime rows at all. Airtime revenue on
-- KingFlexyGH is genuinely just admin_fee_amount, which the engine already
-- counts correctly.
--
-- Now: only flag rows from a supplier that actually pays airtime commission
-- (legacy Hubtel) where it is missing.
--
-- PATCHED IN PLACE rather than restated. _profit_totals_v2 is ~200 lines of
-- audited money SQL carrying four earlier critical fixes (20260928b/c,
-- 20260930); re-typing it to change one FILTER clause risks a silent
-- transcription slip in arithmetic nobody would notice. This derives the new
-- body from the live definition and ASSERTS both edits matched exactly --
-- a no-match raises and aborts instead of leaving the bug in place. On a fresh
-- rebuild the 20260928*/20260930 migrations run first, so the function this
-- patches always exists by the time this runs.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
    d text;
    d0 text;
    old_rows  text := 'SELECT ao.admin_fee_amount, ao.commission_amount, ao.partner_commission_amount
    FROM public.airtime_orders ao';
    new_rows  text := 'SELECT ao.admin_fee_amount, ao.commission_amount, ao.partner_commission_amount, ao.fulfillment_service
    FROM public.airtime_orders ao';
    old_filt  text := 'COUNT(*) FILTER (WHERE commission_amount IS NULL) AS excluded,
      0::numeric AS recruiter_payout,
      COALESCE(SUM(partner_commission_amount),0) AS partner_payout
    FROM airtime_rows';
    new_filt  text := 'COUNT(*) FILTER (WHERE commission_amount IS NULL AND fulfillment_service = ''hubtel-commission'') AS excluded,
      0::numeric AS recruiter_payout,
      COALESCE(SUM(partner_commission_amount),0) AS partner_payout
    FROM airtime_rows';
BEGIN
    d0 := pg_get_functiondef('public._profit_totals_v2(timestamptz,timestamptz,text[],text)'::regprocedure);

    IF position(old_rows in d0) = 0 THEN
        RAISE EXCEPTION 'airtime_rows CTE not found verbatim -- live definition drifted, patch aborted';
    END IF;
    IF position(old_filt in d0) = 0 THEN
        RAISE EXCEPTION 'airtime_agg excluded FILTER not found verbatim -- live definition drifted, patch aborted';
    END IF;
    -- the same FILTER text also appears in utility_agg, but followed by a
    -- different FROM, so anchoring on "FROM airtime_rows" keeps this unique
    IF (length(d0) - length(replace(d0, old_filt, ''))) / length(old_filt) <> 1 THEN
        RAISE EXCEPTION 'airtime excluded FILTER matched % times, expected exactly 1',
            (length(d0) - length(replace(d0, old_filt, ''))) / length(old_filt);
    END IF;

    d := replace(d0, old_rows, new_rows);
    d := replace(d,  old_filt, new_filt);

    IF d = d0 THEN
        RAISE EXCEPTION 'patch produced no change -- aborting';
    END IF;

    EXECUTE d;
    RAISE NOTICE 'airtime excluded flag patched (% -> % bytes)', length(d0), length(d);
END
$do$;
