-- supabase/migrations/20260930_profit_engine_v2_data_excluded_null_fix.sql
-- =============================================================================
-- Profit Engine v2 — data_main_excluded NULL-handling fix (parked residual
-- from the 2026-09-28 profit-engine-v2 final whole-branch review, closed on
-- user request 2026-09-30).
--
-- Bug: data_main_excluded (in _profit_totals_v2, from 20260928c_profit_engine
-- _v2_rc_afa_ussd_fix.sql:156) used `NOT (o.cost_price_at_time > 0)` to count
-- completed `orders` rows with an invalid cost. In Postgres, when
-- cost_price_at_time IS NULL, `cost_price_at_time > 0` evaluates to NULL, and
-- `NOT NULL` is also NULL — a NULL WHERE clause excludes the row from the
-- COUNT. So an orders row with a genuinely NULL cost_price_at_time was
-- silently absent from BOTH the main revenue/cost aggregate (correctly, since
-- the same NULL-propagation excludes it from data_main too) AND the
-- `excluded` transparency count (incorrectly — it should be flagged, per the
-- spec's "never silently drop" rule).
--
-- This was never a profit-figure bug: a NULL-cost row was never counted
-- toward profit before or after this fix, only the *count* shown in the
-- admin dashboard's transparency notice was slightly under-reported for this
-- one narrow case. The two sibling CTEs already handled this correctly
-- (data_shop_excluded and rc_rows_excluded both wrap the check in
-- `IS NOT NULL AND ... > 0`) — this migration brings data_main_excluded in
-- line with that same, already-correct pattern.
-- =============================================================================

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

  data_main AS (
    SELECT o.price AS revenue, o.cost_price_at_time AS admin_cost, COALESCE(sae.amount,0) AS recruiter_amt
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
  -- FIX (this migration): wrapped in IS NOT NULL, matching data_shop_excluded
  -- and rc_rows_excluded's already-correct pattern below.
  data_main_excluded AS (
    SELECT COUNT(*) AS n
    FROM public.orders o
    CROSS JOIN flags f
    WHERE f.inc_data AND o.status = 'completed' AND o.shop_order_id IS NULL
      AND NOT (o.cost_price_at_time IS NOT NULL AND o.cost_price_at_time > 0)
      AND o.created_at BETWEEN p_start_date AND p_end_date
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND o.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND o.network = p_network)
      )
  ),
  data_shop AS (
    SELECT so.cost_price AS revenue, so.admin_cost_at_time AS admin_cost, COALESCE(sae.amount,0) AS recruiter_amt
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
  data_shop_excluded AS (
    SELECT COUNT(*) AS n
    FROM public.shop_orders so
    CROSS JOIN flags f
    WHERE f.inc_data AND so.status = 'completed'
      AND NOT (so.admin_cost_at_time IS NOT NULL AND so.admin_cost_at_time > 0)
      AND so.package_id IS NOT NULL
      AND so.created_at BETWEEN p_start_date AND p_end_date
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND so.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND so.network = p_network)
      )
  ),
  data_agg AS (
    SELECT 'data'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue,
      COALESCE(SUM(admin_cost + recruiter_amt),0) AS cost,
      COALESCE(SUM(revenue - admin_cost - recruiter_amt),0) AS profit,
      COUNT(*) AS orders,
      (SELECT n FROM data_main_excluded) + (SELECT n FROM data_shop_excluded) AS excluded,
      COALESCE(SUM(recruiter_amt),0) AS recruiter_payout,
      0::numeric AS partner_payout
    FROM (
      SELECT revenue, admin_cost, recruiter_amt FROM data_main
      UNION ALL
      SELECT revenue, admin_cost, recruiter_amt FROM data_shop
    ) u
  ),

  airtime_rows AS (
    SELECT ao.admin_fee_amount, ao.commission_amount, ao.partner_commission_amount
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

  afa_rows AS (
    SELECT CASE WHEN ao.shop_id IS NOT NULL THEN ao.cost_price ELSE COALESCE(ao.payment_amount, ao.selling_price, 0) END AS revenue,
      COALESCE(sae.amount,0) AS recruiter_amt
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

  rc_rows AS (
    SELECT
      (rco.total_paid - COALESCE(rco.shop_markup, 0) * rco.quantity - COALESCE(rco.fee_amount, 0)) AS revenue,
      (rco.cost_price_at_time * rco.quantity) AS admin_cost,
      COALESCE(sae.amount,0) AS recruiter_amt
    FROM public.results_checker_orders rco
    CROSS JOIN flags f
    LEFT JOIN public.sub_agent_order_earnings sae
      ON sae.order_table = 'results_checker_orders' AND sae.order_reference = rco.reference_code AND sae.status IN ('pending','credited')
    WHERE f.inc_rc AND rco.status = 'completed' AND rco.cost_price_at_time IS NOT NULL AND rco.cost_price_at_time >= 0
      AND rco.created_at BETWEEN p_start_date AND p_end_date
  ),
  rc_rows_excluded AS (
    SELECT COUNT(*) AS n
    FROM public.results_checker_orders rco
    CROSS JOIN flags f
    WHERE f.inc_rc AND rco.status = 'completed'
      AND NOT (rco.cost_price_at_time IS NOT NULL AND rco.cost_price_at_time >= 0)
      AND rco.created_at BETWEEN p_start_date AND p_end_date
  ),
  rc_agg AS (
    SELECT 'results_checker'::text AS product,
      COALESCE(SUM(revenue),0) AS revenue,
      COALESCE(SUM(admin_cost + recruiter_amt),0) AS cost,
      COALESCE(SUM(revenue - admin_cost - recruiter_amt),0) AS profit,
      COUNT(*) AS orders,
      (SELECT n FROM rc_rows_excluded) AS excluded,
      COALESCE(SUM(recruiter_amt),0) AS recruiter_payout,
      0::numeric AS partner_payout
    FROM rc_rows
  ),

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

  ussd_rows AS (
    SELECT COALESCE(wt.amount, us.fee) AS revenue
    FROM public.shop_profiles sp
    CROSS JOIN flags f
    CROSS JOIN ussd_setting us
    LEFT JOIN public.wallet_transactions wt
      ON wt.type = 'debit' AND wt.status = 'completed' AND wt.reference = 'USSDACT-' || sp.id::text
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
