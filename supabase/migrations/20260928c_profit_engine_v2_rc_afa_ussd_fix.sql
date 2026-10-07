-- supabase/migrations/20260928c_profit_engine_v2_rc_afa_ussd_fix.sql
-- =============================================================================
-- Profit Engine v2 — final whole-branch review fix (four bugs found by an
-- opus final review that no earlier task review caught, because no test
-- actually checked function output against real, hand-computed orders).
--
-- C1 (Critical) — Results-checker profit overstated two ways in rc_rows:
--   1. Cost ignored quantity — revenue was rco.total_paid (the whole order)
--      but cost was rco.cost_price_at_time, a PER-UNIT cost (confirmed:
--      lib/results-checker-service.ts:420 sets cost_price_at_time:
--      type.cost_price). Any order with quantity > 1 overstated profit by
--      cost_price_at_time × (quantity − 1).
--   2. Storefront revenue included money that isn't the platform's — for
--      shop-sold RC orders, total_paid includes the shop owner's markup ×
--      quantity (paid to the owner, not the platform) AND the Paystack fee.
--   Fix (verified against the codebase's own existing RC profit-log trigger,
--   supabase/migrations/20260628_rc_fulfillment_hardening.sql:194-197):
--     revenue    = total_paid - COALESCE(shop_markup,0) * quantity - COALESCE(fee_amount,0)
--     admin_cost = cost_price_at_time * quantity
--   Wallet/main-site orders have shop_markup/fee_amount NULL → COALESCE 0 →
--   unchanged behavior, so this is safe for non-shop orders too.
--
-- C2 (Critical) — Shop-sold AFA counted the shop owner's own profit as
--   platform revenue in afa_rows. revenue was COALESCE(payment_amount,
--   selling_price, 0); for shop-sold AFA orders (confirmed:
--   lib/shop-afa-order-processor.ts:320-323) payment_amount ==
--   pending.selling_price == cost_price + the shop owner's own markup —
--   later credited to the owner's wallet. Fix: for shop-sold AFA orders
--   (shop_id IS NOT NULL), use afa_orders.cost_price instead — confirmed via
--   lib/shop-afa-checkout.ts this is exactly what the shop owner paid the
--   platform (resolveAfaPrice(...) / resolveSubAgentAfaCost(...).subCost),
--   analogous to how the data category already uses shop_orders.cost_price
--   (not selling_price) as platform revenue. Non-shop (direct dashboard) AFA
--   orders are unaffected (shop_id IS NULL keeps the original logic, correct
--   there since the buyer paid the platform directly).
--
-- I1 (Important) — USSD activation exact-amount join never matched anything.
--   ussd_rows joined wallet_transactions ON wt.source = 'ussd', but every
--   actual writer of USSDACT- referenced rows (confirmed:
--   20260926c_lock_shop_row_on_ussd_activation.sql:83 and the backfill in
--   20260926b_ledger_history_rc_sms_ussd.sql:416) uses source = 'purchase'.
--   Every activation therefore fell back to the CURRENT
--   ussd_shop_activation_fee setting instead of its real historical amount.
--   Fix: drop the wt.source = 'ussd' condition entirely — match only on
--   wt.type = 'debit' AND wt.status = 'completed' AND
--   wt.reference = 'USSDACT-' || sp.id::text.
--
-- I2 (Important) — Data/results-checker rows with invalid cost were silently
--   dropped instead of counted in `excluded` (v1 regression — v1's
--   get_profit_summary counted these via a separate COUNT query,
--   20260318_profit_rpcs.sql:50-53). data_main/data_shop/rc_rows already
--   filter out rows failing their cost-validity guard in their WHERE clause
--   — those rows vanished from `excluded` too, instead of being flagged.
--   Fix: data_agg and rc_agg in _profit_totals_v2 now also count completed
--   rows that fail the cost-validity guard, via parallel *_excluded CTEs
--   that mirror the main CTEs' WHERE/JOIN but invert the cost check.
--   _profit_daily_rows_v2 has no `excluded` field/output — no change needed
--   there per the brief.
--
-- Same additive CREATE OR REPLACE pattern as 20260928b_profit_engine_v2_network_fix.sql
-- (already live on production). Everything else is byte-identical to that
-- migration's SQL.
-- =============================================================================

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
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND o.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND o.network = p_network)
      )
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
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND so.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND so.network = p_network)
      )
  ),
  -- I2: count completed data rows that fail the cost-validity guard (mirrors
  -- data_main/data_shop's WHERE/JOIN exactly, but inverted on the cost check)
  -- instead of letting them silently vanish.
  data_main_excluded AS (
    SELECT COUNT(*) AS n
    FROM public.orders o
    CROSS JOIN flags f
    WHERE f.inc_data AND o.status = 'completed' AND o.shop_order_id IS NULL
      AND NOT (o.cost_price_at_time > 0)
      AND o.created_at BETWEEN p_start_date AND p_end_date
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND o.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND o.network = p_network)
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
  -- unset, every AFA row is excluded and flagged rather than assumed free.
  -- C2 fix: for shop-sold orders (shop_id IS NOT NULL), revenue is
  -- ao.cost_price (what the shop owner paid the platform), not
  -- payment_amount/selling_price (which is the shop owner's own resale price,
  -- inflated by their own markup). Non-shop orders are unaffected. ──
  afa_rows AS (
    SELECT
      CASE WHEN ao.shop_id IS NOT NULL THEN ao.cost_price ELSE COALESCE(ao.payment_amount, ao.selling_price, 0) END AS revenue,
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

  -- ── RESULTS CHECKER: results_checker_orders. cost_price_at_time is a real,
  -- admin-configured PER-UNIT cost (unlike AFA) — trustworthy as-is, but must
  -- be multiplied by quantity (C1.1). For shop-sold RC orders, total_paid
  -- includes the shop owner's own markup × quantity and the Paystack fee —
  -- neither belongs to the platform (C1.2). Fix verified against the
  -- existing RC profit-log trigger (20260628_rc_fulfillment_hardening.sql:
  -- 194-197). shop_markup/fee_amount are NULL on wallet/main-site orders →
  -- COALESCE 0 → unchanged behavior there. ──
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
  -- I2: count completed RC rows that fail the cost-validity guard, mirroring
  -- rc_rows exactly but inverted on the cost check.
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
  -- either way.
  -- I1 fix: every actual writer of USSDACT- referenced rows uses
  -- source = 'purchase', never 'ussd' — dropped the wt.source = 'ussd'
  -- condition so the join actually matches real historical amounts. ──
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

-- ── _profit_daily_rows_v2 — same categories, one row per contributing order,
-- for the chart's day-bucketing. Mirrors _profit_totals_v2's *_rows CTEs
-- exactly (kept in sync deliberately — same pattern as the cost-basis SQL
-- twin elsewhere in this codebase). No `excluded` field here (I2 is a
-- _profit_totals_v2-only change per the brief). ──
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
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND o.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND o.network = p_network)
      )
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
      AND (
        NOT f.net_filter
        OR (p_network = 'AirtelTigo' AND so.network IN ('AT-iShare', 'AT-BigTime'))
        OR (p_network <> 'AirtelTigo' AND so.network = p_network)
      )
  ),
  airtime_rows AS (
    SELECT ao.created_at::date AS day,
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
    SELECT uo.created_at::date AS day, COALESCE(uo.commission_amount,0) AS revenue, COALESCE(uo.partner_commission_amount,0) AS cost
    FROM public.utility_orders uo
    CROSS JOIN flags f
    WHERE f.inc_utility AND uo.status = 'completed'
      AND uo.created_at BETWEEN p_start_date AND p_end_date
  ),
  -- C2 fix (mirrors _profit_totals_v2's afa_rows): shop-sold orders use
  -- ao.cost_price (what the shop owner paid the platform) as revenue, not
  -- payment_amount/selling_price (the owner's own resale price).
  afa_rows AS (
    SELECT ao.created_at::date AS day,
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
  -- C1 fix (mirrors _profit_totals_v2's rc_rows): cost multiplied by
  -- quantity, and revenue strips shop_markup × quantity + fee_amount so
  -- shop-sold RC orders don't count the owner's own markup as platform
  -- revenue. shop_markup/fee_amount are NULL on wallet/main-site orders →
  -- COALESCE 0 → unchanged behavior there.
  rc_rows AS (
    SELECT rco.created_at::date AS day,
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
  -- I1 fix (mirrors _profit_totals_v2's ussd_rows): dropped the
  -- wt.source = 'ussd' condition — real writers use source = 'purchase'.
  ussd_rows AS (
    SELECT sp.ussd_activated_at::date AS day, COALESCE(wt.amount, us.fee) AS revenue, 0::numeric AS cost
    FROM public.shop_profiles sp
    CROSS JOIN flags f
    CROSS JOIN ussd_setting us
    LEFT JOIN public.wallet_transactions wt
      ON wt.type = 'debit' AND wt.status = 'completed' AND wt.reference = 'USSDACT-' || sp.id::text
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
