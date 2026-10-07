-- supabase/migrations/20260928_profit_engine_v2.sql
-- =============================================================================
-- Profit Engine v2 (spec: docs/superpowers/specs/2026-09-28-profit-engine-v2-design.md)
--
-- Additive only. get_profit_summary/get_profit_timeseries/get_shop_owner_stats/
-- get_wallet_overview (20260318_profit_rpcs.sql) are untouched — old callers
-- keep working, this ships alongside them.
--
-- Fixes vs v1:
--   1. Sub-agent orders no longer count the recruiter's markup as platform
--      profit — sub_agent_order_earnings is joined and subtracted (spec §1).
--   2. Adds airtime, utility, AFA, results checker, subscriptions, SMS, and
--      USSD activation — v1 only ever saw data orders (spec §2).
-- =============================================================================

-- ── New cost inputs (spec §2a) — real numbers, not placeholders ────────────
INSERT INTO public.admin_settings (key, value)
VALUES
  ('afa_cost_price', '"11.5"'),
  ('sms_cost_per_segment', '"0.243"')
ON CONFLICT (key) DO NOTHING;

-- ── _profit_totals_v2 — per-product-type revenue/cost/profit for one date range ──
CREATE OR REPLACE FUNCTION public._profit_totals_v2(
    p_start_date timestamptz,
    p_end_date timestamptz,
    p_product_types text[],
    p_network text
)
RETURNS TABLE (
    product text,
    revenue numeric,
    cost numeric,
    profit numeric,
    orders bigint,
    excluded bigint,
    recruiter_payout numeric,
    partner_payout numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- ── DATA: orders (main) + shop_orders (storefront), sub-agent margin removed ──
  data_main AS (
    SELECT o.price AS revenue, o.cost_price_at_time AS admin_cost, COALESCE(sae.amount,0) AS recruiter_amt
    FROM public.orders o
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'orders' AND sae.order_reference = o.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_data AND o.status = 'completed' AND o.shop_order_id IS NULL AND o.cost_price_at_time > 0
      AND o.created_at BETWEEN p_start_date AND p_end_date
      AND (NOT f.net_filter OR o.network = p_network)
  ),
  data_shop AS (
    -- package_id IS NOT NULL excludes airtime/mashup shop_orders rows (they never
    -- reference data_packages) — those are counted once, fully, via airtime_agg below.
    SELECT so.cost_price AS revenue, so.admin_cost_at_time AS admin_cost, COALESCE(sae.amount,0) AS recruiter_amt
    FROM public.shop_orders so
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'shop_orders' AND sae.order_reference = COALESCE(so.paystack_reference, so.id::text) AND sae.status IN ('pending','credited')
    WHERE f.inc_data AND so.status = 'completed' AND so.admin_cost_at_time IS NOT NULL AND so.admin_cost_at_time > 0
      AND so.package_id IS NOT NULL
      AND so.created_at BETWEEN p_start_date AND p_end_date
      AND (NOT f.net_filter OR so.network = p_network)
  ),
  data_agg AS (
    SELECT 'data'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue,
      COALESCE(SUM(admin_cost + recruiter_amt),0) AS cost,
      COALESCE(SUM(revenue - admin_cost - recruiter_amt),0) AS profit,
      COUNT(*) AS orders,
      0::bigint AS excluded,
      COALESCE(SUM(recruiter_amt),0) AS recruiter_payout,
      0::numeric AS partner_payout
    FROM (
      SELECT revenue, admin_cost, recruiter_amt FROM data_main
      UNION ALL
      SELECT revenue, admin_cost, recruiter_amt FROM data_shop
    ) u
  ),

  -- ── AIRTIME: airtime_orders (main + shop + api). Two revenue streams: customer
  -- markup (admin_fee_amount, always) + Hubtel's own reseller commission
  -- (commission_amount, all sources) minus any partner share paid to an eligible
  -- API developer (partner_commission_amount). No recruiter adjustment — margin
  -- is structurally zero for airtime (spec C9). ──
  airtime_rows AS (
    SELECT ao.admin_fee_amount, ao.commission_amount, ao.partner_commission_amount
    FROM public.airtime_orders ao
    CROSS JOIN flags f
    WHERE f.inc_airtime AND ao.status = 'completed'
      AND ao.created_at BETWEEN p_start_date AND p_end_date
      AND (NOT f.net_filter OR ao.network = p_network)
  ),
  airtime_agg AS (
    SELECT 'airtime'::text AS product,
      COALESCE(SUM(admin_fee_amount),0) + COALESCE(SUM(commission_amount),0) AS revenue,
      COALESCE(SUM(partner_commission_amount),0) AS cost,
      COALESCE(SUM(admin_fee_amount),0) + COALESCE(SUM(commission_amount),0) - COALESCE(SUM(partner_commission_amount),0) AS profit,
      COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE commission_amount IS NULL) AS excluded,
      0::numeric AS recruiter_payout,
      COALESCE(SUM(partner_commission_amount),0) AS partner_payout
    FROM airtime_rows
  ),

  -- ── UTILITY: utility_orders. No customer markup at all — the only revenue is
  -- Hubtel's commission, minus any partner share. ──
  utility_rows AS (
    SELECT uo.commission_amount, uo.partner_commission_amount
    FROM public.utility_orders uo
    CROSS JOIN flags f
    WHERE f.inc_utility AND uo.status = 'completed'
      AND uo.created_at BETWEEN p_start_date AND p_end_date
  ),
  utility_agg AS (
    SELECT 'utility'::text AS product,
      COALESCE(SUM(commission_amount),0) AS revenue,
      COALESCE(SUM(partner_commission_amount),0) AS cost,
      COALESCE(SUM(commission_amount),0) - COALESCE(SUM(partner_commission_amount),0) AS profit,
      COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE commission_amount IS NULL) AS excluded,
      0::numeric AS recruiter_payout,
      COALESCE(SUM(partner_commission_amount),0) AS partner_payout
    FROM utility_rows
  ),

  -- ── AFA: afa_orders. cost_price on the row is a resold TIER PRICE, not a true
  -- cost (spec §2) — use admin_settings.afa_cost_price instead. If it's ever
  -- unset, every AFA row is excluded and flagged rather than assumed free. ──
  afa_rows AS (
    SELECT COALESCE(ao.payment_amount, ao.selling_price, 0) AS revenue, COALESCE(sae.amount,0) AS recruiter_amt
    FROM public.afa_orders ao
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'afa_orders' AND sae.order_reference = ao.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_afa AND ao.status = 'completed'
      AND ao.created_at BETWEEN p_start_date AND p_end_date
  ),
  afa_agg AS (
    SELECT 'afa'::text AS product,
      CASE WHEN s.afa_cost IS NOT NULL THEN COALESCE((SELECT SUM(revenue) FROM afa_rows),0) ELSE 0 END AS revenue,
      CASE WHEN s.afa_cost IS NOT NULL THEN COALESCE((SELECT SUM(s.afa_cost + recruiter_amt) FROM afa_rows),0) ELSE 0 END AS cost,
      CASE WHEN s.afa_cost IS NOT NULL THEN COALESCE((SELECT SUM(revenue - s.afa_cost - recruiter_amt) FROM afa_rows),0) ELSE 0 END AS profit,
      CASE WHEN s.afa_cost IS NOT NULL THEN (SELECT COUNT(*) FROM afa_rows) ELSE 0 END AS orders,
      CASE WHEN s.afa_cost IS NOT NULL THEN 0 ELSE (SELECT COUNT(*) FROM afa_rows) END AS excluded,
      CASE WHEN s.afa_cost IS NOT NULL THEN COALESCE((SELECT SUM(recruiter_amt) FROM afa_rows),0) ELSE 0 END AS recruiter_payout,
      0::numeric AS partner_payout
    FROM afa_setting s
  ),

  -- ── RESULTS CHECKER: results_checker_orders. cost_price_at_time is a real,
  -- admin-configured per-type cost (unlike AFA) — trustworthy as-is. ──
  rc_rows AS (
    SELECT rco.total_paid AS revenue, rco.cost_price_at_time AS admin_cost, COALESCE(sae.amount,0) AS recruiter_amt
    FROM public.results_checker_orders rco
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'results_checker_orders' AND sae.order_reference = rco.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_rc AND rco.status = 'completed' AND rco.cost_price_at_time IS NOT NULL AND rco.cost_price_at_time >= 0
      AND rco.created_at BETWEEN p_start_date AND p_end_date
  ),
  rc_agg AS (
    SELECT 'results_checker'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue,
      COALESCE(SUM(admin_cost + recruiter_amt),0) AS cost,
      COALESCE(SUM(revenue - admin_cost - recruiter_amt),0) AS profit,
      COUNT(*) AS orders,
      0::bigint AS excluded,
      COALESCE(SUM(recruiter_amt),0) AS recruiter_payout,
      0::numeric AS partner_payout
    FROM rc_rows
  ),

  -- ── SUBSCRIPTIONS: role-upgrade wallet debits. 100% margin. ──
  sub_rows AS (
    SELECT wt.amount AS revenue
    FROM public.wallet_transactions wt
    CROSS JOIN flags f
    WHERE f.inc_sub AND wt.type = 'debit' AND wt.status = 'completed'
      AND wt.source = 'purchase' AND wt.reference LIKE 'upgrade\_%' ESCAPE '\'
      AND wt.created_at BETWEEN p_start_date AND p_end_date
  ),
  sub_agg AS (
    SELECT 'subscriptions'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue, 0::numeric AS cost, COALESCE(SUM(revenue),0) AS profit,
      COUNT(*) AS orders, 0::bigint AS excluded, 0::numeric AS recruiter_payout, 0::numeric AS partner_payout
    FROM sub_rows
  ),

  -- ── SMS: bundle purchases (costed at credits x sms_cost_per_segment) + the
  -- one-time feature-activation fee (100% margin). BOTH paid_from values count
  -- — spending from the shop's own profit balance is real revenue: it retires a
  -- liability the platform owed the shop owner, in exchange for a real service
  -- with a real Hubtel cost (spec §2, "profit-wallet-funded" note). ──
  sms_bundle_rows AS (
    SELECT ssp.price AS revenue, ssp.credits * sm.sms_cost_per_segment AS cost
    FROM public.shop_sms_purchases ssp
    CROSS JOIN flags f
    CROSS JOIN sms_setting sm
    WHERE f.inc_sms AND ssp.created_at BETWEEN p_start_date AND p_end_date
  ),
  sms_activation_rows AS (
    SELECT ssa.amount_paid AS revenue, 0::numeric AS cost
    FROM public.shop_sms_activations ssa
    CROSS JOIN flags f
    WHERE f.inc_sms AND ssa.created_at BETWEEN p_start_date AND p_end_date
  ),
  sms_agg AS (
    SELECT 'sms'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue,
      COALESCE(SUM(cost),0) AS cost,
      COALESCE(SUM(revenue - cost),0) AS profit,
      COUNT(*) AS orders, 0::bigint AS excluded, 0::numeric AS recruiter_payout, 0::numeric AS partner_payout
    FROM (
      SELECT revenue, cost FROM sms_bundle_rows
      UNION ALL
      SELECT revenue, cost FROM sms_activation_rows
    ) u
  ),

  -- ── USSD ACTIVATION: shop_profiles.ussd_activated_at is the only durable
  -- per-shop signal (one-time, idempotent). Wallet-funded activations get their
  -- exact amount from wallet_transactions; profit-funded ones have no ledger row
  -- at all (activate_shop_ussd's profit branch never wrote one) — counted at the
  -- CURRENT ussd_shop_activation_fee setting as a best-effort amount. 100% margin
  -- either way. ──
  ussd_rows AS (
    SELECT COALESCE(wt.amount, us.fee) AS revenue
    FROM public.shop_profiles sp
    CROSS JOIN flags f
    CROSS JOIN ussd_setting us
    LEFT JOIN public.wallet_transactions wt
      ON wt.source = 'ussd' AND wt.status = 'completed' AND wt.reference = 'USSDACT-' || sp.id::text
    WHERE f.inc_ussd AND sp.ussd_activated_at IS NOT NULL
      AND sp.ussd_activated_at BETWEEN p_start_date AND p_end_date
  ),
  ussd_agg AS (
    SELECT 'ussd_activation'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue, 0::numeric AS cost, COALESCE(SUM(revenue),0) AS profit,
      COUNT(*) AS orders, 0::bigint AS excluded, 0::numeric AS recruiter_payout, 0::numeric AS partner_payout
    FROM ussd_rows
  )

  SELECT * FROM data_agg
  UNION ALL SELECT * FROM airtime_agg
  UNION ALL SELECT * FROM utility_agg
  UNION ALL SELECT * FROM afa_agg
  UNION ALL SELECT * FROM rc_agg
  UNION ALL SELECT * FROM sub_agg
  UNION ALL SELECT * FROM sms_agg
  UNION ALL SELECT * FROM ussd_agg
$$;

REVOKE ALL ON FUNCTION public._profit_totals_v2(timestamptz, timestamptz, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._profit_totals_v2(timestamptz, timestamptz, text[], text) TO service_role;

-- ── _profit_daily_rows_v2 — same categories, one row per contributing order,
-- for the chart's day-bucketing. Mirrors _profit_totals_v2's *_rows CTEs
-- exactly (kept in sync deliberately — same pattern as the cost-basis SQL
-- twin elsewhere in this codebase). ──
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
AS $$
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
    SELECT o.created_at::date AS day, o.price AS revenue, o.cost_price_at_time + COALESCE(sae.amount,0) AS cost
    FROM public.orders o
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'orders' AND sae.order_reference = o.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_data AND o.status = 'completed' AND o.shop_order_id IS NULL AND o.cost_price_at_time > 0
      AND o.created_at BETWEEN p_start_date AND p_end_date
      AND (NOT f.net_filter OR o.network = p_network)
  ),
  data_shop AS (
    SELECT so.created_at::date AS day, so.cost_price AS revenue, so.admin_cost_at_time + COALESCE(sae.amount,0) AS cost
    FROM public.shop_orders so
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'shop_orders' AND sae.order_reference = COALESCE(so.paystack_reference, so.id::text) AND sae.status IN ('pending','credited')
    WHERE f.inc_data AND so.status = 'completed' AND so.admin_cost_at_time IS NOT NULL AND so.admin_cost_at_time > 0
      AND so.package_id IS NOT NULL
      AND so.created_at BETWEEN p_start_date AND p_end_date
      AND (NOT f.net_filter OR so.network = p_network)
  ),
  airtime_rows AS (
    SELECT ao.created_at::date AS day,
      ao.admin_fee_amount + COALESCE(ao.commission_amount,0) AS revenue,
      COALESCE(ao.partner_commission_amount,0) AS cost
    FROM public.airtime_orders ao
    CROSS JOIN flags f
    WHERE f.inc_airtime AND ao.status = 'completed'
      AND ao.created_at BETWEEN p_start_date AND p_end_date
      AND (NOT f.net_filter OR ao.network = p_network)
  ),
  utility_rows AS (
    SELECT uo.created_at::date AS day, COALESCE(uo.commission_amount,0) AS revenue, COALESCE(uo.partner_commission_amount,0) AS cost
    FROM public.utility_orders uo
    CROSS JOIN flags f
    WHERE f.inc_utility AND uo.status = 'completed'
      AND uo.created_at BETWEEN p_start_date AND p_end_date
  ),
  afa_rows AS (
    SELECT ao.created_at::date AS day, COALESCE(ao.payment_amount, ao.selling_price, 0) AS revenue,
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
    SELECT rco.created_at::date AS day, rco.total_paid AS revenue, rco.cost_price_at_time + COALESCE(sae.amount,0) AS cost
    FROM public.results_checker_orders rco
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'results_checker_orders' AND sae.order_reference = rco.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_rc AND rco.status = 'completed' AND rco.cost_price_at_time IS NOT NULL AND rco.cost_price_at_time >= 0
      AND rco.created_at BETWEEN p_start_date AND p_end_date
  ),
  sub_rows AS (
    SELECT wt.created_at::date AS day, wt.amount AS revenue, 0::numeric AS cost
    FROM public.wallet_transactions wt
    CROSS JOIN flags f
    WHERE f.inc_sub AND wt.type = 'debit' AND wt.status = 'completed'
      AND wt.source = 'purchase' AND wt.reference LIKE 'upgrade\_%' ESCAPE '\'
      AND wt.created_at BETWEEN p_start_date AND p_end_date
  ),
  sms_bundle_rows AS (
    SELECT ssp.created_at::date AS day, ssp.price AS revenue, ssp.credits * sm.sms_cost_per_segment AS cost
    FROM public.shop_sms_purchases ssp
    CROSS JOIN flags f
    CROSS JOIN sms_setting sm
    WHERE f.inc_sms AND ssp.created_at BETWEEN p_start_date AND p_end_date
  ),
  sms_activation_rows AS (
    SELECT ssa.created_at::date AS day, ssa.amount_paid AS revenue, 0::numeric AS cost
    FROM public.shop_sms_activations ssa
    CROSS JOIN flags f
    WHERE f.inc_sms AND ssa.created_at BETWEEN p_start_date AND p_end_date
  ),
  ussd_rows AS (
    SELECT sp.ussd_activated_at::date AS day, COALESCE(wt.amount, us.fee) AS revenue, 0::numeric AS cost
    FROM public.shop_profiles sp
    CROSS JOIN flags f
    CROSS JOIN ussd_setting us
    LEFT JOIN public.wallet_transactions wt
      ON wt.source = 'ussd' AND wt.status = 'completed' AND wt.reference = 'USSDACT-' || sp.id::text
    WHERE f.inc_ussd AND sp.ussd_activated_at IS NOT NULL
      AND sp.ussd_activated_at BETWEEN p_start_date AND p_end_date
  )

  SELECT day, revenue, cost FROM data_main
  UNION ALL SELECT day, revenue, cost FROM data_shop
  UNION ALL SELECT day, revenue, cost FROM airtime_rows
  UNION ALL SELECT day, revenue, cost FROM utility_rows
  UNION ALL SELECT day, revenue, cost FROM afa_rows
  UNION ALL SELECT day, revenue, cost FROM rc_rows
  UNION ALL SELECT day, revenue, cost FROM sub_rows
  UNION ALL SELECT day, revenue, cost FROM sms_bundle_rows
  UNION ALL SELECT day, revenue, cost FROM sms_activation_rows
  UNION ALL SELECT day, revenue, cost FROM ussd_rows
$$;

REVOKE ALL ON FUNCTION public._profit_daily_rows_v2(timestamptz, timestamptz, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._profit_daily_rows_v2(timestamptz, timestamptz, text[], text) TO service_role;

-- ── get_profit_summary_v2 — the public entry point ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_profit_summary_v2(
    p_start_date timestamptz,
    p_end_date timestamptz,
    p_prev_start_date timestamptz,
    p_prev_end_date timestamptz,
    p_product_types text[] DEFAULT NULL,
    p_network text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_revenue numeric := 0;
    v_total_cost numeric := 0;
    v_total_profit numeric := 0;
    v_total_orders bigint := 0;
    v_excluded bigint := 0;
    v_recruiter_payouts numeric := 0;
    v_partner_payouts numeric := 0;
    v_profit_margin numeric := 0;
    v_growth_pct numeric := 0;
    v_prev_total_profit numeric := 0;
    v_by_product jsonb := '{}'::jsonb;
    r record;
BEGIN
    FOR r IN SELECT * FROM public._profit_totals_v2(p_start_date, p_end_date, p_product_types, p_network) LOOP
        v_total_revenue := v_total_revenue + r.revenue;
        v_total_cost := v_total_cost + r.cost;
        v_total_profit := v_total_profit + r.profit;
        v_total_orders := v_total_orders + r.orders;
        v_excluded := v_excluded + r.excluded;
        v_recruiter_payouts := v_recruiter_payouts + r.recruiter_payout;
        v_partner_payouts := v_partner_payouts + r.partner_payout;
        v_by_product := v_by_product || jsonb_build_object(
            r.product, jsonb_build_object(
                'revenue', r.revenue, 'cost', r.cost, 'profit', r.profit,
                'orders', r.orders, 'excluded', r.excluded,
                'recruiter_payout', r.recruiter_payout, 'partner_payout', r.partner_payout
            )
        );
    END LOOP;

    SELECT COALESCE(SUM(profit),0) INTO v_prev_total_profit
    FROM public._profit_totals_v2(p_prev_start_date, p_prev_end_date, p_product_types, p_network);

    IF v_total_revenue > 0 THEN
        v_profit_margin := ROUND((v_total_profit / v_total_revenue) * 100, 2);
    END IF;
    IF v_prev_total_profit > 0 THEN
        v_growth_pct := ROUND(((v_total_profit - v_prev_total_profit) / v_prev_total_profit) * 100, 2);
    ELSIF v_total_profit > 0 THEN
        v_growth_pct := 100;
    END IF;

    RETURN jsonb_build_object(
        'summary', jsonb_build_object(
            'total_revenue', v_total_revenue,
            'total_cost', v_total_cost,
            'total_profit', v_total_profit,
            'profit_margin', v_profit_margin,
            'total_orders', v_total_orders,
            'excluded_orders', v_excluded,
            'growth_percent', v_growth_pct,
            'recruiter_payouts', v_recruiter_payouts,
            'partner_commission_payouts', v_partner_payouts
        ),
        'by_product', v_by_product
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_profit_summary_v2(timestamptz, timestamptz, timestamptz, timestamptz, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_profit_summary_v2(timestamptz, timestamptz, timestamptz, timestamptz, text[], text) TO service_role;

-- ── get_profit_timeseries_v2 — daily totals for the trend chart ─────────────
CREATE OR REPLACE FUNCTION public.get_profit_timeseries_v2(
    p_start_date timestamptz,
    p_end_date timestamptz,
    p_product_types text[] DEFAULT NULL,
    p_network text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result jsonb;
BEGIN
    WITH dates AS (
        SELECT generate_series(p_start_date::date, p_end_date::date, '1 day'::interval)::date AS day
    ),
    daily AS (
        SELECT day, SUM(revenue) AS revenue, SUM(cost) AS cost
        FROM public._profit_daily_rows_v2(p_start_date, p_end_date, p_product_types, p_network)
        GROUP BY day
    )
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'date', TO_CHAR(d.day, 'YYYY-MM-DD'),
            'revenue', COALESCE(x.revenue, 0),
            'cost', COALESCE(x.cost, 0),
            'profit', COALESCE(x.revenue, 0) - COALESCE(x.cost, 0)
        ) ORDER BY d.day ASC
    ), '[]'::jsonb) INTO v_result
    FROM dates d
    LEFT JOIN daily x ON x.day = d.day;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_profit_timeseries_v2(timestamptz, timestamptz, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_profit_timeseries_v2(timestamptz, timestamptz, text[], text) TO service_role;

-- ── get_wallet_overview_v2 — adds commission_wallets (recruiter + airtime/
-- utility partner-commission payouts), the third real liability pool the v1
-- get_wallet_overview (20260318_profit_rpcs.sql) never tracked. v1 is
-- untouched and still used wherever it already is today. ──
CREATE OR REPLACE FUNCTION public.get_wallet_overview_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_bal DECIMAL := 0;
    v_user_count INT := 0;
    v_shop_bal DECIMAL := 0;
    v_shop_count INT := 0;
    v_commission_bal DECIMAL := 0;
    v_commission_count INT := 0;
BEGIN
    SELECT COALESCE(SUM(w.balance), 0), COUNT(w.id)
    INTO v_user_bal, v_user_count
    FROM public.wallets w
    JOIN public.users u ON u.id = w.user_id
    WHERE u.role NOT IN ('admin', 'sub-admin') AND w.balance > 0;

    SELECT COALESCE(SUM(balance), 0), COUNT(id)
    INTO v_shop_bal, v_shop_count
    FROM public.shop_wallets
    WHERE balance > 0;

    -- commission_wallets holds BOTH recruiter sub-agent margin AND airtime/
    -- utility partner-commission shares — both credited via the same table
    -- (spec §1, §2). One combined liability figure; no product-level split
    -- needed here, the profit engine's recruiter_payout/partner_payout
    -- figures (Task 2's get_profit_summary_v2) already break that down.
    SELECT COALESCE(SUM(balance), 0), COUNT(id)
    INTO v_commission_bal, v_commission_count
    FROM public.commission_wallets
    WHERE balance > 0;

    RETURN jsonb_build_object(
        'total_user_balance', v_user_bal,
        'user_count', v_user_count,
        'total_shop_owner_balance', v_shop_bal,
        'shop_owner_count', v_shop_count,
        'total_commission_balance', v_commission_bal,
        'commission_count', v_commission_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_wallet_overview_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_overview_v2() TO service_role;
