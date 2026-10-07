-- Fametech schema snapshot: functions / RPCs
-- Source: read-only introspection of the KiNG FLEXY GH production DB (schema only, NO data).
-- Apply files in numeric order to a FRESH Supabase project.

CREATE OR REPLACE FUNCTION public._profit_daily_rows_v2(p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_product_types text[], p_network text)
 RETURNS TABLE(day date, revenue numeric, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public._profit_totals_v2(p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_product_types text[], p_network text)
 RETURNS TABLE(product text, revenue numeric, cost numeric, profit numeric, orders bigint, excluded bigint, recruiter_payout numeric, partner_payout numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.activate_shop_sms(p_owner_id uuid, p_paid_from text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop_id UUID;
    v_fee     NUMERIC;
    v_rows    INTEGER;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'profit') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT id INTO v_shop_id FROM shop_profiles WHERE owner_id = p_owner_id;
    IF v_shop_id IS NULL THEN
        RAISE EXCEPTION 'SHOP_NOT_FOUND';
    END IF;

    IF EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = v_shop_id) THEN
        RAISE EXCEPTION 'ALREADY_ACTIVATED';
    END IF;

    SELECT COALESCE(NULLIF(TRIM(BOTH '"' FROM value::text), '')::numeric, 0) INTO v_fee
    FROM shop_global_settings WHERE key = 'sms_activation_fee';
    IF v_fee IS NULL THEN v_fee := 0; END IF;

    IF v_fee > 0 THEN
        IF p_paid_from = 'wallet' THEN
            UPDATE wallets
            SET balance     = balance - v_fee,
                total_spent = COALESCE(total_spent, 0) + v_fee,
                updated_at  = now()
            WHERE user_id = p_owner_id AND balance >= v_fee;
        ELSE
            UPDATE shop_wallets
            SET balance    = balance - v_fee,
                updated_at = now()
            WHERE owner_id = p_owner_id AND balance >= v_fee;
        END IF;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
        END IF;

        IF p_paid_from = 'wallet' THEN
            INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
            SELECT id, p_owner_id, 'debit', v_fee, 'Shop SMS activation fee',
                   'SMSACT-' || v_shop_id::text, 'purchase', 'completed'
            FROM wallets WHERE user_id = p_owner_id;
        END IF;
    END IF;

    INSERT INTO shop_sms_activations (shop_id, owner_id, amount_paid, paid_from)
    VALUES (v_shop_id, p_owner_id, v_fee, p_paid_from);

    INSERT INTO shop_sms_wallets (shop_id, credits)
    VALUES (v_shop_id, 0)
    ON CONFLICT (shop_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'amount_paid', v_fee);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.activate_shop_ussd(p_owner_id uuid, p_paid_from text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop       shop_profiles%ROWTYPE;
    v_fee        NUMERIC;
    v_rows       INTEGER;
    v_constraint TEXT;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'profit') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    -- Lock the shop row so concurrent activations serialise on it (F15).
    SELECT * INTO v_shop FROM shop_profiles WHERE owner_id = p_owner_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SHOP_NOT_FOUND';
    END IF;

    IF v_shop.approval_status <> 'approved' OR COALESCE(v_shop.is_active, false) = false THEN
        RAISE EXCEPTION 'SHOP_NOT_APPROVED';
    END IF;

    -- Idempotent: if a code was EVER assigned, treat the shop as already
    -- activated and charge nothing — even if ussd_active was later toggled off.
    IF v_shop.ussd_code IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success',        true,
            'code',           v_shop.ussd_code,
            'already_active', true,
            'amount_paid',    0
        );
    END IF;

    -- Fee from admin config only. admin_settings.value is JSONB stored as a
    -- quoted string e.g. "50.00" — strip the surrounding quotes before casting.
    SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 50)
      INTO v_fee
      FROM admin_settings
     WHERE key = 'ussd_shop_activation_fee';
    IF v_fee IS NULL THEN
        v_fee := 50;
    END IF;
    IF v_fee < 0 THEN
        RAISE EXCEPTION 'INVALID_FEE';
    END IF;

    -- Atomic debit from the chosen balance (skipped when the fee is 0).
    IF v_fee > 0 THEN
        IF p_paid_from = 'wallet' THEN
            UPDATE wallets
               SET balance     = balance - v_fee,
                   total_spent = COALESCE(total_spent, 0) + v_fee,
                   updated_at  = now()
             WHERE user_id = p_owner_id AND balance >= v_fee;
        ELSE
            UPDATE shop_wallets
               SET balance    = balance - v_fee,
                   updated_at = now()
             WHERE owner_id = p_owner_id AND balance >= v_fee;
        END IF;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
        END IF;

        -- History row in the same transaction (rolled back with the debit if the
        -- activation below fails, e.g. CODE_TAKEN).
        IF p_paid_from = 'wallet' THEN
            INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
            SELECT id, p_owner_id, 'debit', v_fee, 'Shop USSD activation fee',
                   'USSDACT-' || v_shop.id::text, 'purchase', 'completed'
            FROM wallets WHERE user_id = p_owner_id;
        END IF;
    END IF;

    -- Activate. Scope the unique handler to the ussd_code constraint — any OTHER
    -- future unique violation must surface (not be retried, re-running the debit).
    BEGIN
        UPDATE shop_profiles
           SET ussd_code         = p_code,
               ussd_active       = true,
               ussd_activated_at = now(),
               updated_at        = now()
         WHERE id = v_shop.id;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint ILIKE '%ussd_code%' THEN
            RAISE EXCEPTION 'CODE_TAKEN';
        ELSE
            RAISE;
        END IF;
    END;

    RETURN jsonb_build_object(
        'success',        true,
        'code',           p_code,
        'already_active', false,
        'amount_paid',    v_fee
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_shop_pricing_for_role_change(p_user_id uuid, p_old_role text, p_new_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop_id UUID; v_is_sub BOOLEAN; v_updated_count INTEGER := 0; rec RECORD;
    v_old_cost DECIMAL(12,2); v_new_cost DECIMAL(12,2); v_profit DECIMAL(12,2);
    v_new_price DECIMAL(12,2); v_new_sub DECIMAL(12,2);
BEGIN
    SELECT EXISTS (SELECT 1 FROM public.sub_agents WHERE user_id = p_user_id) INTO v_is_sub;
    IF v_is_sub THEN
        RETURN jsonb_build_object('success', true, 'updated', 0, 'message', 'Sub-agent shop — priced off upline wholesale, not repriced on role change');
    END IF;
    SELECT id INTO v_shop_id FROM public.shop_profiles WHERE owner_id = p_user_id LIMIT 1;
    IF v_shop_id IS NULL THEN
        RETURN jsonb_build_object('success', true, 'updated', 0, 'message', 'No shop found for this user — nothing to adjust');
    END IF;
    FOR rec IN
        SELECT sp.id AS pricing_id, sp.selling_price, sp.sub_price,
               dp.price AS customer_price, dp.agent_price, dp.dealer_price
        FROM public.shop_pricing sp JOIN public.data_packages dp ON dp.id = sp.package_id
        WHERE sp.shop_id = v_shop_id
    LOOP
        v_old_cost := public.effective_owner_cost(rec.customer_price, rec.agent_price, rec.dealer_price, p_old_role);
        v_new_cost := public.effective_owner_cost(rec.customer_price, rec.agent_price, rec.dealer_price, p_new_role);
        IF v_old_cost = v_new_cost THEN CONTINUE; END IF;
        v_profit := rec.selling_price - v_old_cost;
        v_new_price := v_new_cost + v_profit;
        IF v_new_price <= v_new_cost THEN v_new_price := v_new_cost + 0.01; END IF;
        v_new_price := ROUND(v_new_price, 2);
        v_new_sub := rec.sub_price;
        IF v_new_sub IS NOT NULL AND v_new_sub < v_new_cost + 0.01 THEN v_new_sub := ROUND(v_new_cost + 0.01, 2); END IF;
        UPDATE public.shop_pricing SET selling_price = v_new_price, sub_price = v_new_sub WHERE id = rec.pricing_id;
        v_updated_count := v_updated_count + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'updated', v_updated_count,
        'message', format('Adjusted %s pricing rows from %s to %s cost tier', v_updated_count, p_old_role, p_new_role));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_adjust_wallet(p_user_id uuid, p_delta numeric, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wallet public.wallets%ROWTYPE;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wallet_not_found');
  END IF;

  IF p_delta < 0 AND v_wallet.balance + p_delta < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_balance');
  END IF;

  UPDATE public.wallets
     SET balance        = balance + p_delta,
         total_credited = CASE WHEN p_delta > 0 THEN COALESCE(total_credited, 0) + p_delta ELSE total_credited END,
         total_spent    = CASE WHEN p_delta < 0 THEN COALESCE(total_spent, 0) - p_delta ELSE total_spent END,
         updated_at     = now()
   WHERE id = v_wallet.id;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, source, status)
  VALUES (v_wallet.id, p_user_id,
          CASE WHEN p_delta > 0 THEN 'credit' ELSE 'debit' END,
          abs(p_delta),
          COALESCE(p_description, 'Admin manual adjustment'), 'admin', 'completed');

  RETURN jsonb_build_object('ok', true, 'new_balance', v_wallet.balance + p_delta, 'old_balance', v_wallet.balance);
END; $function$
;

CREATE OR REPLACE FUNCTION public.admin_airtime_stats(p_network text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(gross_sales numeric, admin_markup numeric, hubtel_commission numeric, shop_profit numeric, total_volume numeric, pending_value numeric, total_count bigint, airtime_count bigint, mashup_count bigint, pending_count bigint, completed_count bigint, hubtel_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT
        COALESCE(SUM(total_paid)     FILTER (WHERE status = 'completed'), 0) AS gross_sales,
        COALESCE(SUM(
            CASE WHEN admin_fee_amount > 0 THEN admin_fee_amount
                 WHEN shop_id IS NOT NULL  THEN GREATEST(0, fee_amount - shop_fee_amount)
                 ELSE fee_amount END
        ) FILTER (WHERE status = 'completed'), 0) AS admin_markup,
        COALESCE(SUM(NULLIF(fulfillment_metadata->>'commission', '')::numeric)
                 FILTER (WHERE status = 'completed'), 0) AS hubtel_commission,
        COALESCE(SUM(shop_fee_amount) FILTER (WHERE status = 'completed' AND shop_id IS NOT NULL), 0) AS shop_profit,
        COALESCE(SUM(airtime_amount)  FILTER (WHERE status = 'completed'), 0) AS total_volume,
        COALESCE(SUM(total_paid)      FILTER (WHERE status = 'pending'), 0) AS pending_value,
        COUNT(*)                                                          AS total_count,
        COUNT(*) FILTER (WHERE type <> 'mashup')                          AS airtime_count,
        COUNT(*) FILTER (WHERE type = 'mashup')                           AS mashup_count,
        COUNT(*) FILTER (WHERE status = 'pending')                        AS pending_count,
        COUNT(*) FILTER (WHERE status = 'completed')                      AS completed_count,
        COUNT(*) FILTER (WHERE status = 'completed' AND fulfillment_service = 'hubtel-commission') AS hubtel_count
    FROM public.airtime_orders
    WHERE (p_network IS NULL OR network    = p_network)
      AND (p_type    IS NULL OR type       = p_type)
      AND (p_start   IS NULL OR created_at >= p_start)
      AND (p_end     IS NULL OR created_at <= p_end);
$function$
;

CREATE OR REPLACE FUNCTION public.admin_credit_wallet(p_user_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_new_balance NUMERIC;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Credit amount must be greater than zero';
    END IF;

    UPDATE wallets
    SET balance        = balance + p_amount,
        total_credited = COALESCE(total_credited, 0) + p_amount,
        updated_at     = now()
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_payment_stats(from_ts timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'main', jsonb_build_object(
      'completed_count',  (SELECT count(*)                       FROM wallet_payments WHERE status='completed' AND created_at >= from_ts),
      'completed_amount', (SELECT coalesce(sum(total_amount),0)  FROM wallet_payments WHERE status='completed' AND created_at >= from_ts),
      'pending_count',    (SELECT count(*)                       FROM wallet_payments WHERE status='pending'   AND created_at >= from_ts),
      'pending_amount',   (SELECT coalesce(sum(total_amount),0)  FROM wallet_payments WHERE status='pending'   AND created_at >= from_ts),
      'failed_count',     (SELECT count(*)                       FROM wallet_payments WHERE status='failed'    AND created_at >= from_ts)
    ),
    'shop', jsonb_build_object(
      'completed_count',  (SELECT count(*)                       FROM shop_orders WHERE status IN ('pending','processing','completed') AND created_at >= from_ts),
      'completed_amount', (SELECT coalesce(sum(selling_price),0) FROM shop_orders WHERE status IN ('pending','processing','completed') AND created_at >= from_ts),
      'pending_count',    (SELECT count(*)                       FROM shop_orders WHERE status IN ('pending','processing')             AND created_at >= from_ts),
      'pending_amount',   (SELECT coalesce(sum(selling_price),0) FROM shop_orders WHERE status IN ('pending','processing')             AND created_at >= from_ts),
      'failed_count',     (SELECT count(*)                       FROM shop_orders WHERE status IN ('failed','refunded')                AND created_at >= from_ts)
    ),
    'results_checker', jsonb_build_object(
      'completed_count',  (SELECT count(*)                       FROM results_checker_orders WHERE payment_status='completed'                       AND created_at >= from_ts),
      'completed_amount', (SELECT coalesce(sum(total_paid),0)    FROM results_checker_orders WHERE payment_status='completed'                       AND created_at >= from_ts),
      'pending_count',    (SELECT count(*)                       FROM results_checker_orders WHERE status='pending' AND payment_status='completed'  AND created_at >= from_ts),
      'pending_amount',   (SELECT coalesce(sum(total_paid),0)    FROM results_checker_orders WHERE status='pending' AND payment_status='completed'  AND created_at >= from_ts),
      'failed_count',     (SELECT count(*)                       FROM results_checker_orders WHERE status IN ('failed','refunded')                  AND created_at >= from_ts)
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.admin_search_users(p_term text DEFAULT NULL::text, p_role text DEFAULT 'all'::text, p_status text DEFAULT 'all'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, email text, first_name text, last_name text, phone_number text, role text, status text, agent_expires_at timestamp with time zone, dealer_expires_at timestamp with time zone, suspended_until timestamp with time zone, suspension_reason text, phone_verified boolean, created_at timestamp with time zone, updated_at timestamp with time zone, wallet_balance numeric, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT u.*, COALESCE(w.balance, 0) AS wbal
    FROM public.users u
    LEFT JOIN public.wallets w ON w.user_id = u.id
    WHERE
      ( p_role = 'all'
        OR (p_role = 'staff' AND u.role IN ('admin','sub-admin'))
        OR u.role = p_role )
      AND ( p_status = 'all'
        OR (p_status = 'active'    AND u.status = 'active')
        OR (p_status = 'suspended' AND u.status = 'suspended')
        OR (p_status = 'expired'   AND (
              (u.role = 'agent'  AND u.agent_expires_at  IS NOT NULL AND u.agent_expires_at  <= now())
           OR (u.role = 'dealer' AND u.dealer_expires_at IS NOT NULL AND u.dealer_expires_at <= now()) )) )
      AND ( p_term IS NULL OR btrim(p_term) = ''
        OR ( length(regexp_replace(p_term,'\D','','g')) >= 3 AND (
               regexp_replace(COALESCE(u.phone_number,''),'\D','','g') ILIKE '%'||regexp_replace(p_term,'\D','','g')||'%'
               OR right(regexp_replace(COALESCE(u.phone_number,''),'\D','','g'),9)
                  = right(regexp_replace(p_term,'\D','','g'),9) ) )
        OR NOT EXISTS (
             SELECT 1 FROM unnest(string_to_array(lower(btrim(p_term)),' ')) AS tok
             WHERE tok <> ''
               AND lower(COALESCE(u.first_name,'')) NOT LIKE '%'||tok||'%'
               AND lower(COALESCE(u.last_name,''))  NOT LIKE '%'||tok||'%'
               AND lower(COALESCE(u.email,''))      NOT LIKE '%'||tok||'%' ) )
  )
  SELECT id, email, first_name, last_name, phone_number, role, status,
         agent_expires_at, dealer_expires_at, suspended_until, suspension_reason,
         phone_verified, created_at, updated_at, wbal AS wallet_balance,
         count(*) OVER() AS total_count
  FROM base
  ORDER BY created_at DESC
  LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
$function$
;

CREATE OR REPLACE FUNCTION public.admin_search_users(p_term text DEFAULT NULL::text, p_role text DEFAULT 'all'::text, p_status text DEFAULT 'all'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_phone_verified text DEFAULT 'all'::text)
 RETURNS TABLE(id uuid, email text, first_name text, last_name text, phone_number text, role text, status text, agent_expires_at timestamp with time zone, dealer_expires_at timestamp with time zone, suspended_until timestamp with time zone, suspension_reason text, phone_verified boolean, created_at timestamp with time zone, updated_at timestamp with time zone, wallet_balance numeric, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with base as (
    select u.*, coalesce(w.balance, 0) as wbal
    from public.users u
    left join public.wallets w on w.user_id = u.id
    where
      ( p_role = 'all'
        or (p_role = 'staff' and u.role in ('admin','sub-admin'))
        or u.role = p_role )
      and ( p_status = 'all'
        or (p_status = 'active'    and u.status = 'active')
        or (p_status = 'suspended' and u.status = 'suspended')
        or (p_status = 'expired'   and (
              (u.role = 'agent'  and u.agent_expires_at  is not null and u.agent_expires_at  <= now())
           or (u.role = 'dealer' and u.dealer_expires_at is not null and u.dealer_expires_at <= now()) )) )
      and ( p_phone_verified = 'all'
        or (p_phone_verified = 'verified'   and u.phone_verified is true)
        or (p_phone_verified = 'unverified' and u.phone_verified is not true) )
      and ( p_term is null or btrim(p_term) = ''
        or ( length(regexp_replace(p_term,'\D','','g')) >= 3 and (
               regexp_replace(coalesce(u.phone_number,''),'\D','','g') ilike '%'||regexp_replace(p_term,'\D','','g')||'%'
               or right(regexp_replace(coalesce(u.phone_number,''),'\D','','g'),9)
                  = right(regexp_replace(p_term,'\D','','g'),9) ) )
        or not exists (
             select 1 from unnest(string_to_array(lower(btrim(p_term)),' ')) as tok
             where tok <> ''
               and lower(coalesce(u.first_name,'')) not like '%'||tok||'%'
               and lower(coalesce(u.last_name,''))  not like '%'||tok||'%'
               and lower(coalesce(u.email,''))      not like '%'||tok||'%' ) )
  )
  select id, email, first_name, last_name, phone_number, role, status,
         agent_expires_at, dealer_expires_at, suspended_until, suspension_reason,
         phone_verified, created_at, updated_at, wbal as wallet_balance,
         count(*) over() as total_count
  from base
  order by created_at desc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$function$
;

CREATE OR REPLACE FUNCTION public.admin_update_subagent_contact(p_user_id uuid, p_new_email text, p_new_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.subagent_contact_override', 'true', true);
  UPDATE public.users
  SET email = COALESCE(p_new_email, email),
      phone_number = COALESCE(p_new_phone, phone_number)
  WHERE id = p_user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_user_stats()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'total',           count(*),
    'customers',       count(*) filter (where role = 'customer'),
    'agents',          count(*) filter (where role = 'agent'),
    'active_agents',   count(*) filter (where role = 'agent'  and (agent_expires_at  is null or agent_expires_at  > now())),
    'expired_agents',  count(*) filter (where role = 'agent'  and agent_expires_at  is not null and agent_expires_at  <= now()),
    'dealers',         count(*) filter (where role = 'dealer'),
    'active_dealers',  count(*) filter (where role = 'dealer' and (dealer_expires_at is null or dealer_expires_at > now())),
    'expired_dealers', count(*) filter (where role = 'dealer' and dealer_expires_at is not null and dealer_expires_at <= now()),
    'staff',           count(*) filter (where role in ('admin','sub-admin')),
    'subagents',       count(*) filter (where role = 'subagent'),
    'suspended',       count(*) filter (where status = 'suspended'),
    'expired',         count(*) filter (where
                          (role = 'agent'  and agent_expires_at  is not null and agent_expires_at  <= now())
                       or (role = 'dealer' and dealer_expires_at is not null and dealer_expires_at <= now())),
    'verified',        count(*) filter (where phone_verified is true),
    'unverified',      count(*) filter (where phone_verified is not true)
  ) from public.users
$function$
;

CREATE OR REPLACE FUNCTION public.apply_shop_sms_delivery_report(p_provider_message_id text, p_status text, p_detail text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_receipt shop_sms_delivery_receipts;
BEGIN
  UPDATE shop_sms_delivery_receipts
  SET status = p_status, updated_at = now()
  WHERE provider_message_id = p_provider_message_id
    AND status = 'sent'
  RETURNING * INTO v_receipt;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false);
  END IF;

  UPDATE shop_sms_logs
  SET pending_count = GREATEST(pending_count - 1, 0),
      delivered_count = delivered_count
        + CASE WHEN p_status = 'delivered' THEN 1 ELSE 0 END,
      undelivered_count = undelivered_count
        + CASE WHEN p_status IN ('undelivered','rejected','expired') THEN 1 ELSE 0 END
  WHERE id = v_receipt.log_id;

  RETURN jsonb_build_object('updated', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_sms_delivery_report(p_provider_message_id text, p_status text, p_detail text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_row RECORD;
BEGIN
    -- SECURITY (audit H-1): 'failed' is a SEND-TIME provider rejection written
    -- only by bulk_update_sms_message_status, and settle_sms_campaign refunds
    -- exactly the 'failed' rows. A DLR callback must NEVER be able to mint a
    -- 'failed' row (that would refund an already-sent message), so it is
    -- excluded here regardless of what the caller maps — the DB contract holds
    -- even if an app-layer mapping regresses.
    IF p_status NOT IN ('delivered', 'undelivered', 'expired', 'rejected') THEN
        RAISE EXCEPTION 'INVALID_STATUS';
    END IF;

    UPDATE sms_messages
    SET status = p_status,
        status_detail = COALESCE(p_detail, status_detail),
        status_updated_at = now()
    WHERE provider_message_id = p_provider_message_id
      AND status IN ('queued', 'sent')
    RETURNING id, campaign_id, account_id INTO v_row;

    IF v_row.id IS NULL THEN
        RETURN jsonb_build_object('updated', false);
    END IF;

    RETURN jsonb_build_object('updated', true,
        'message_id', v_row.id, 'campaign_id', v_row.campaign_id,
        'account_id', v_row.account_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_sub_agent_earning_sync(p_order_reference text, p_new_status text, p_order_table text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_earning public.sub_agent_order_earnings%ROWTYPE;
  v_wallet_id UUID;
  v_tx_id UUID;
BEGIN
  IF p_order_reference IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_earning FROM public.sub_agent_order_earnings
    WHERE order_reference = p_order_reference AND order_table = p_order_table FOR UPDATE;

  IF NOT FOUND THEN
    -- No pending earning for this order (not a sub's order, or a zero-markup
    -- product per spec C9) — nothing to do.
    RETURN;
  END IF;

  IF p_new_status = 'completed' AND v_earning.status = 'pending' THEN
    -- Single race-free upsert: under concurrent first-ever credits for the
    -- same recruiter, a separate INSERT...ON CONFLICT DO NOTHING followed by
    -- a SELECT can race (a concurrent uncommitted insert makes the INSERT a
    -- no-op while also being invisible to the SELECT, yielding NULL and a
    -- NOT NULL violation downstream). DO UPDATE forces this statement to
    -- return the row's id either way.
    INSERT INTO public.commission_wallets (owner_id, balance, total_earned)
      VALUES (v_earning.recruiter_id, 0, 0)
      ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
      RETURNING id INTO v_wallet_id;

    INSERT INTO public.commission_wallet_transactions
      (commission_wallet_id, type, amount, description, status, order_reference, order_table)
    VALUES
      (v_wallet_id, 'sub_agent_margin', v_earning.amount,
       'Sub-agent order completed', 'completed', v_earning.order_reference, v_earning.order_table)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_tx_id;

    IF v_tx_id IS NULL THEN
      -- Already recorded by a concurrent/replayed call — balance already
      -- reflects it. Do not move the balance again; do not update the
      -- ledger status again (it was already moved by whichever call
      -- actually inserted the row).
      RETURN;
    END IF;

    UPDATE public.commission_wallets
      SET balance = balance + v_earning.amount, total_earned = total_earned + v_earning.amount, updated_at = NOW()
      WHERE id = v_wallet_id;

    UPDATE public.sub_agent_order_earnings
      SET status = 'credited', credited_at = NOW()
      WHERE id = v_earning.id;

  -- DELIBERATE: this branch only fires when v_earning.status = 'credited'.
  -- A row that reverses here becomes 'reversed', not 'pending' — so if the
  -- order's status later flips back to 'completed' again, the credit branch
  -- above (which requires v_earning.status = 'pending') will NOT re-fire and
  -- the earning will NOT auto re-credit. This is intentional: re-crediting
  -- after a reversal needs a human decision, not an automatic bounce-back.
  -- Do not "fix" this into a bounce-back without a deliberate product call.
  ELSIF p_new_status <> 'completed' AND v_earning.status = 'credited' THEN
    SELECT id INTO v_wallet_id FROM public.commission_wallets
      WHERE owner_id = v_earning.recruiter_id FOR UPDATE;

    -- Defensive only: a 'credited' earning implies the wallet already exists
    -- (created by the credit branch above), so this should be unreachable
    -- in practice. Guards against an AFTER UPDATE trigger raising on the
    -- NOT NULL commission_wallet_id below and aborting the order's own
    -- status change (e.g. blocking an admin's refund with an opaque error).
    IF v_wallet_id IS NULL THEN
      RETURN;
    END IF;

    INSERT INTO public.commission_wallet_transactions
      (commission_wallet_id, type, amount, description, status, order_reference, order_table)
    VALUES
      (v_wallet_id, 'sub_agent_margin_reversal', v_earning.amount,
       'Sub-agent order status changed after completion', 'completed', v_earning.order_reference, v_earning.order_table)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_tx_id;

    IF v_tx_id IS NULL THEN
      -- Already recorded by a concurrent/replayed call — balance already
      -- reflects it. Do not move the balance again; do not update the
      -- ledger status again (it was already moved by whichever call
      -- actually inserted the row).
      RETURN;
    END IF;

    -- DELIBERATE ASYMMETRY: only `balance` moves here, not `total_earned`
    -- (contrast the credit branch above, which updates both). `total_earned`
    -- is lifetime gross earnings and must not be reduced by a later reversal;
    -- only the current spendable `balance` does. Do not add total_earned
    -- here to "mirror" the credit branch — that would misrepresent history.
    UPDATE public.commission_wallets
      SET balance = balance - v_earning.amount, updated_at = NOW()
      WHERE id = v_wallet_id;

    UPDATE public.sub_agent_order_earnings
      SET status = 'reversed', reversed_at = NOW()
      WHERE id = v_earning.id;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assign_results_checker_vouchers(p_type_id uuid, p_quantity integer, p_order_id uuid)
 RETURNS TABLE(id uuid, pin text, serial_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_timeout_minutes INTEGER := 10;
  v_timeout_setting TEXT;
  v_reserved_count  INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_order_id::text));

  IF EXISTS (
    SELECT 1 FROM public.results_checker_inventory
    WHERE reserved_by_order = p_order_id AND status IN ('reserved', 'sold')
  ) THEN
    RETURN QUERY
    SELECT inv.id, inv.pin, inv.serial_number
    FROM public.results_checker_inventory inv
    WHERE inv.reserved_by_order = p_order_id
      AND inv.status IN ('reserved', 'sold')
    ORDER BY inv.created_at ASC;
    RETURN;
  END IF;

  SELECT value INTO v_timeout_setting
  FROM public.admin_settings
  WHERE key = 'results_checker_reservation_timeout';
  IF v_timeout_setting IS NOT NULL THEN
    v_timeout_minutes := v_timeout_setting::INTEGER;
  END IF;

  UPDATE public.results_checker_inventory inv
  SET
    status                 = 'reserved',
    reserved_by_order      = p_order_id,
    reservation_expires_at = NOW() + (v_timeout_minutes || ' minutes')::INTERVAL,
    updated_at             = NOW()
  WHERE inv.id IN (
    SELECT sub.id
    FROM public.results_checker_inventory sub
    WHERE sub.type_id = p_type_id
      AND sub.status  = 'available'
    ORDER BY sub.created_at ASC
    LIMIT p_quantity
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_reserved_count = ROW_COUNT;

  IF v_reserved_count < p_quantity THEN
    UPDATE public.results_checker_inventory
    SET status = 'available', reserved_by_order = NULL, reservation_expires_at = NULL, updated_at = NOW()
    WHERE reserved_by_order = p_order_id;
    RAISE EXCEPTION 'INSUFFICIENT_INVENTORY';
  END IF;

  RETURN QUERY
  SELECT inv.id, inv.pin, inv.serial_number
  FROM public.results_checker_inventory inv
  WHERE inv.reserved_by_order = p_order_id
    AND inv.type_id           = p_type_id
    AND inv.status            = 'reserved';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_update_shop_pricing_on_platform_cost()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF NEW.price <= 0 THEN RAISE EXCEPTION 'Invalid platform price detected'; END IF;
    IF NEW.price IS NOT DISTINCT FROM OLD.price
       AND NEW.agent_price IS NOT DISTINCT FROM OLD.agent_price
       AND NEW.dealer_price IS NOT DISTINCT FROM OLD.dealer_price THEN
        RETURN NEW;
    END IF;
    BEGIN
        PERFORM set_config('app.system_pricing_update', 'true', true);
        WITH updated_pricing AS (
            SELECT sp.id, sp.shop_id, sp.package_id,
                public.effective_owner_cost(OLD.price, OLD.agent_price, OLD.dealer_price, u.role) AS old_cost,
                sp.selling_price AS old_selling,
                public.effective_owner_cost(NEW.price, NEW.agent_price, NEW.dealer_price, u.role) AS new_cost,
                public.effective_owner_cost(NEW.price, NEW.agent_price, NEW.dealer_price, u.role) + GREATEST(sp.profit_margin, 0.01) AS new_selling,
                sp.sub_price AS old_sub_price
            FROM public.shop_pricing sp
            JOIN public.shop_profiles spf ON sp.shop_id = spf.id
            JOIN public.users u ON u.id = spf.owner_id
            WHERE sp.package_id = NEW.id
              AND NOT EXISTS (SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id)
        ),
        applied_update AS (
            UPDATE public.shop_pricing sp
            SET selling_price = up.new_selling,
                sub_price = CASE WHEN up.old_sub_price IS NULL THEN NULL
                    ELSE ROUND(GREATEST(up.new_cost + (up.old_sub_price - up.old_cost), up.new_cost + 0.01), 2) END,
                last_auto_updated_at = NOW()
            FROM updated_pricing up WHERE sp.id = up.id
            RETURNING up.*
        )
        INSERT INTO public.shop_pricing_logs (shop_id, package_id, old_cost_price, new_cost_price, old_selling_price, new_selling_price, changed_at)
        SELECT shop_id, package_id, old_cost, new_cost, old_selling, new_selling, NOW() FROM applied_update;
        PERFORM set_config('app.system_pricing_update', 'false', true);
        RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('app.system_pricing_update', 'false', true);
        RAISE;
    END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.block_client_money_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'SECURITY: % can only be written by the server', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN coalesce(NEW, OLD);
END $function$
;

CREATE OR REPLACE FUNCTION public.bulk_update_sms_message_status(p_updates jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_count INTEGER;
BEGIN
    IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD';
    END IF;

    UPDATE sms_messages m
    SET status              = u.status,
        provider_message_id = COALESCE(u.provider_message_id, m.provider_message_id),
        network_id          = COALESCE(u.network_id, m.network_id),
        rate                = COALESCE(u.rate, m.rate),
        status_detail       = COALESCE(u.detail, m.status_detail),
        status_updated_at   = now()
    FROM jsonb_to_recordset(p_updates) AS u(
        id UUID, status TEXT, provider_message_id TEXT,
        network_id TEXT, rate NUMERIC, detail TEXT
    )
    WHERE m.id = u.id
      AND u.status IN ('sent', 'failed')
      AND m.status = 'queued';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bump_otp_attempts(p_id uuid)
 RETURNS TABLE(attempts integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.phone_otp_verifications
     SET attempts = COALESCE(phone_otp_verifications.attempts, 0) + 1
   WHERE id = p_id AND used = false
   RETURNING phone_otp_verifications.attempts;
$function$
;

CREATE OR REPLACE FUNCTION public.bump_support_thread_last_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.support_threads
  SET last_message_at = NEW.created_at,
      updated_at      = now()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_sms_campaign(p_campaign_id uuid, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_camp   RECORD;
    v_credit JSONB;
BEGIN
    UPDATE sms_campaigns
    SET status = 'cancelled', settled_at = now()
    WHERE id = p_campaign_id AND account_id = p_account_id AND status = 'queued'
    RETURNING * INTO v_camp;

    IF v_camp.id IS NULL THEN
        RETURN jsonb_build_object('cancelled', false, 'reason', 'NOT_CANCELLABLE');
    END IF;

    UPDATE sms_messages
    SET status = 'failed', status_detail = 'campaign cancelled', status_updated_at = now()
    WHERE campaign_id = p_campaign_id AND status = 'queued';

    IF v_camp.credits_charged > 0 THEN
        v_credit := credit_user_sms_credits(
            p_account_id, v_camp.credits_charged,
            'refund:' || p_campaign_id::text, 'refund', p_campaign_id::text);
    END IF;

    RETURN jsonb_build_object('cancelled', true,
        'refunded_credits', COALESCE(v_camp.credits_charged, 0));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cascade_lead_suspend()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.approval_status = 'suspended' AND OLD.approval_status IS DISTINCT FROM 'suspended' THEN
    UPDATE public.shop_profiles sp
    SET is_active = false, updated_at = now()
    FROM public.sub_agents sa
    WHERE sa.upline_shop_id = NEW.id
      AND sp.owner_id = sa.user_id
      AND sp.is_active = true;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_hubtel_receive_paid(p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row record;
BEGIN
  UPDATE public.hubtel_receive_charges
     SET status='paid', paid_at=now()
   WHERE reference_code=p_reference AND status='pending'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.hubtel_receive_charges WHERE reference_code=p_reference;
    IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'error','not_found'); END IF;
    RETURN jsonb_build_object('claimed',false,'already',v_row.status);
  END IF;
  RETURN jsonb_build_object('claimed',true,'service_type',v_row.service_type,'order_id',v_row.order_id);
END $function$
;

CREATE OR REPLACE FUNCTION public.claim_momo_transaction(p_transaction_id text, p_user_id uuid, p_is_auto boolean DEFAULT false, p_ref_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_txn              RECORD;
    v_wallet           RECORD;
    v_fee_key          TEXT;
    v_min_claimable    NUMERIC;
    v_fee_percent      NUMERIC;
    v_fee_amount       NUMERIC;
    v_net_amount       NUMERIC;
    v_new_balance      NUMERIC;
    v_user_role        TEXT;
    v_description      TEXT;
BEGIN
    -- 1. Get user role
    SELECT role INTO v_user_role
    FROM public.users
    WHERE id = p_user_id;

    -- 2. Lock the transaction row (prevents concurrent claims)
    SELECT * INTO v_txn
    FROM public.momo_transactions
    WHERE transaction_id = p_transaction_id
    FOR UPDATE;

    -- 3. Validate it exists and is pending
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transaction not found');
    END IF;

    IF v_txn.status = 'claimed' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed',
            'claimed_at', v_txn.claimed_at,
            'is_own_claim', (v_txn.claimed_by = p_user_id),
            'is_auto_claimed', v_txn.is_auto_claimed,
            'claimed_via_ref', v_txn.claimed_via_ref);
    END IF;

    IF v_txn.status = 'voided' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transaction has been voided by admin');
    END IF;

    IF v_txn.status = 'flagged' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This transaction requires admin review. Please contact support.');
    END IF;

    -- 4. Get minimum claimable amount from settings (handle JSONB safely)
    SELECT NULLIF(value#>>ARRAY[]::TEXT[], '')::NUMERIC INTO v_min_claimable
    FROM public.admin_settings
    WHERE key = 'momo_min_claimable';
    v_min_claimable := COALESCE(v_min_claimable, 1);

    -- 5. Determine which fee key to use based on user role
    IF v_user_role = 'agent' THEN
        v_fee_key := 'momo_claim_fee_agent';
    ELSE
        v_fee_key := 'momo_claim_fee_customer';
    END IF;

    -- 6. Get fee percent from admin settings (handle JSONB safely)
    SELECT NULLIF(value#>>ARRAY[]::TEXT[], '')::NUMERIC INTO v_fee_percent
    FROM public.admin_settings
    WHERE key = v_fee_key;
    v_fee_percent := COALESCE(v_fee_percent, 0);

    -- 7. Compute fee and net amount entirely server-side
    v_fee_amount := ROUND((v_txn.amount * v_fee_percent / 100), 2);
    v_net_amount := v_txn.amount - v_fee_amount;

    -- 8. Enforce minimum claimable (belt-and-suspenders server check)
    IF v_net_amount < v_min_claimable THEN
        RETURN jsonb_build_object('success', false, 'error', 'below_minimum',
            'min_claimable', v_min_claimable,
            'net_amount', v_net_amount);
    END IF;

    -- 9. Get user's wallet (lock it too)
    SELECT * INTO v_wallet
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
    END IF;

    -- 10. Build the description based on how it was claimed
    IF p_is_auto AND p_ref_code IS NOT NULL THEN
        v_description := 'Auto-Claim via Ref ' || p_ref_code || ' — ' || v_txn.sender_network || ' — TXN: ' || p_transaction_id;
    ELSE
        v_description := 'MoMo Claim — ' || v_txn.sender_network || ' — TXN: ' || p_transaction_id;
    END IF;

    -- 11. Update momo_transactions to claimed (with auto-claim metadata)
    UPDATE public.momo_transactions
    SET status            = 'claimed',
        claimed_by        = p_user_id,
        claimed_at        = NOW(),
        claim_fee_percent = v_fee_percent,
        claim_fee_amount  = v_fee_amount,
        net_amount        = v_net_amount,
        is_auto_claimed   = p_is_auto,
        claimed_via_ref   = p_ref_code
    WHERE id = v_txn.id;

    -- 12. Credit the user's wallet
    v_new_balance := v_wallet.balance + v_net_amount;

    UPDATE public.wallets
    SET balance        = v_new_balance,
        total_credited = total_credited + v_net_amount,
        updated_at     = NOW()
    WHERE id = v_wallet.id;

    -- 13. Log a wallet transaction for history
    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount,
        description, reference, source, status
    ) VALUES (
        v_wallet.id,
        p_user_id,
        'credit',
        v_net_amount,
        v_description,
        'MOMO-' || p_transaction_id,
        'payment',
        'completed'
    );

    -- 14. Return full breakdown for notification dispatch
    RETURN jsonb_build_object(
        'success',        true,
        'amount',         v_txn.amount,
        'sender_name',    v_txn.sender_name,
        'sender_network', v_txn.sender_network,
        'fee_percent',    v_fee_percent,
        'fee_amount',     v_fee_amount,
        'net_amount',     v_net_amount,
        'new_balance',    v_new_balance,
        'transaction_id', p_transaction_id,
        'is_auto_claimed', p_is_auto,
        'claimed_via_ref', p_ref_code
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_order_retry(p_order_id uuid, p_actor_id uuid, p_actor_role text, p_charge_amount numeric DEFAULT 0, p_reference_code text DEFAULT NULL::text, p_cost_price numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_o public.orders%ROWTYPE;
  v_attempt_no int;
  v_funding_user uuid;
  v_wallet_id uuid;
  v_balance numeric;
  v_new_order_id uuid;
  v_ref text;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  IF p_actor_role NOT IN ('admin', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_actor_role');
  END IF;

  IF v_o.status = 'failed' AND p_actor_role <> 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
  END IF;

  IF v_o.status = 'refunded' AND p_actor_role = 'user' AND v_o.user_id IS DISTINCT FROM p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_owner');
  END IF;

  IF v_o.status NOT IN ('failed', 'refunded') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_retryable', 'status', v_o.status);
  END IF;

  IF v_o.last_retry_at IS NOT NULL AND v_o.last_retry_at + interval '60 seconds' > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'retry_too_soon',
      'retry_after', v_o.last_retry_at + interval '60 seconds');
  END IF;

  IF v_o.retry_count >= 3 THEN
    IF v_o.last_retry_at + interval '24 hours' > now() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'retry_locked',
        'until', v_o.last_retry_at + interval '24 hours');
    END IF;
    v_o.retry_count := 0;
  END IF;

  v_attempt_no := v_o.retry_count + 1;

  IF v_o.status = 'failed' THEN
    UPDATE public.orders SET
      status = 'pending',
      codecraft_reference = NULL,
      dakazina_reference = NULL,
      dakazina_order_code = NULL,
      ghdata_order_id = NULL,
      bundleportal_reference = NULL,
      hendylinks_order_id = NULL,
      atishare_console_reference = NULL,
      atishare_console_transaction_id = NULL,
      spfastit_reference = NULL,
      fulfillment_method = NULL,
      error_message = NULL,
      download_batch_id = NULL,
      retry_count = v_attempt_no,
      last_retry_at = now(),
      retry_from_status = 'failed',
      retried_by = p_actor_id,
      retried_by_role = p_actor_role,
      updated_at = now()
    WHERE id = p_order_id;

    INSERT INTO public.order_retry_attempts
      (source_order_id, attempt_no, mode, actor_id, actor_role, charged_amount, status)
    VALUES
      (p_order_id, v_attempt_no, 'in_place', p_actor_id, p_actor_role, 0, 'claimed');

    RETURN jsonb_build_object('ok', true, 'mode', 'in_place',
      'target_order_id', p_order_id, 'attempt_no', v_attempt_no, 'charged_amount', 0,
      'reference_code', NULL);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE retry_of_order_id = p_order_id AND status IN ('processing', 'completed')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'retry_already_in_progress');
  END IF;

  IF v_o.shop_order_id IS NOT NULL THEN
    DECLARE v_so public.shop_orders%ROWTYPE;
    BEGIN
      SELECT * INTO v_so FROM public.shop_orders WHERE id = v_o.shop_order_id;
      IF v_so.refund_method = 'paystack' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'paystack_refund_no_wallet');
      END IF;
      SELECT owner_id INTO v_funding_user FROM public.shop_profiles WHERE id = v_so.shop_id;
      IF v_funding_user IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'owner_not_found');
      END IF;
    END;
  ELSE
    v_funding_user := v_o.user_id;
    IF v_funding_user IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_wallet_user');
    END IF;
  END IF;

  IF p_charge_amount IS NULL OR p_charge_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_charge_amount');
  END IF;

  INSERT INTO public.wallets (user_id, balance) VALUES (v_funding_user, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id, balance INTO v_wallet_id, v_balance FROM public.wallets WHERE user_id = v_funding_user FOR UPDATE;

  IF v_balance < p_charge_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_balance',
      'required', p_charge_amount, 'available', v_balance);
  END IF;

  v_new_order_id := gen_random_uuid();
  v_ref := 'RETRY-' || p_order_id::text || '-' || v_attempt_no::text;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_funding_user, 'debit', p_charge_amount,
            'Retry of order ' || v_o.reference_code, v_ref, 'retry', 'completed');
  UPDATE public.wallets SET balance = balance - p_charge_amount WHERE id = v_wallet_id;

  INSERT INTO public.orders (
    id, user_id, phone_number, network, size, price, cost_price_at_time,
    status, payment_status, reference_code, category, role_at_time, source,
    shop_name, retry_of_order_id, retry_from_status, retried_by, retried_by_role,
    retry_count, last_retry_at
  ) VALUES (
    v_new_order_id, v_funding_user, v_o.phone_number, v_o.network, v_o.size,
    p_charge_amount, COALESCE(p_cost_price, v_o.cost_price_at_time),
    'pending', 'paid', COALESCE(p_reference_code, 'RTY-' || v_new_order_id::text),
    v_o.category, v_o.role_at_time, v_o.source,
    v_o.shop_name, p_order_id, 'refunded', p_actor_id, p_actor_role,
    0, NULL
  );

  UPDATE public.orders SET
    retry_count = v_attempt_no,
    last_retry_at = now(),
    retried_by = p_actor_id,
    retried_by_role = p_actor_role
  WHERE id = p_order_id;

  INSERT INTO public.order_retry_attempts
    (source_order_id, attempt_no, new_order_id, mode, actor_id, actor_role,
     charged_amount, funding_wallet_user_id, status)
  VALUES
    (p_order_id, v_attempt_no, v_new_order_id, 'new_order', p_actor_id, p_actor_role,
     p_charge_amount, v_funding_user, 'claimed');

  RETURN jsonb_build_object('ok', true, 'mode', 'new_order',
    'target_order_id', v_new_order_id, 'attempt_no', v_attempt_no,
    'charged_amount', p_charge_amount,
    'reference_code', (SELECT reference_code FROM public.orders WHERE id = v_new_order_id));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', 'duplicate_attempt');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_self_order_complete(p_order_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_o public.orders%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  IF v_o.user_id = p_actor_id THEN
    v_role := 'customer';
  ELSIF v_o.shop_order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.shop_orders so
    JOIN public.shop_profiles sp ON sp.id = so.shop_id
    WHERE so.id = v_o.shop_order_id AND sp.owner_id = p_actor_id
  ) THEN
    v_role := 'shop_owner';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'not_owner');
  END IF;

  IF v_o.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already_completed', true);
  END IF;

  IF v_o.status <> 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_eligible', 'status', v_o.status);
  END IF;

  UPDATE public.orders SET
    status = 'completed',
    self_completed_at = now(),
    self_completed_by = p_actor_id,
    self_completed_by_role = v_role,
    updated_at = now()
  WHERE id = p_order_id;

  -- Keep shop_orders in sync so the profit-audit trigger (trg_log_shop_profit,
  -- AFTER UPDATE ON shop_orders) fires for self-completed shop orders, matching
  -- every other completion path (syncShopOrderStatus / shop-order-processor.ts).
  -- Guard against clobbering a refunded shop_orders row (defensive; a refunded
  -- shop_orders row shouldn't exist for a still-'processing' orders row in
  -- practice, but avoid overwriting a terminal refunded state if it ever does).
  IF v_o.shop_order_id IS NOT NULL THEN
    UPDATE public.shop_orders SET status = 'completed', updated_at = now()
    WHERE id = v_o.shop_order_id AND status <> 'refunded';
  END IF;

  RETURN jsonb_build_object('ok', true, 'role', v_role);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_sms_campaigns(p_limit integer DEFAULT 3, p_stale_minutes integer DEFAULT 10)
 RETURNS SETOF sms_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    UPDATE sms_campaigns c
    SET status = 'processing', claimed_at = now()
    WHERE c.id IN (
        SELECT id FROM sms_campaigns
        WHERE (status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= now()))
           OR (status = 'processing' AND claimed_at < now() - make_interval(mins => p_stale_minutes))
        ORDER BY created_at
        LIMIT GREATEST(1, LEAST(p_limit, 10))
        FOR UPDATE SKIP LOCKED
    )
    RETURNING c.*;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_sms_welcome_bonus(p_shop_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_credits_text  TEXT;
    v_credits       INTEGER;
BEGIN
    -- Read admin-configured credit count; default 10, cap at 500
    SELECT value INTO v_credits_text
    FROM shop_global_settings
    WHERE key = 'sms_welcome_bonus_credits';

    BEGIN
        v_credits := v_credits_text::INTEGER;
    EXCEPTION WHEN OTHERS THEN
        v_credits := 10;
    END;

    IF v_credits IS NULL OR v_credits <= 0 OR v_credits > 500 THEN
        v_credits := 10;
    END IF;

    -- Mark bonus claimed (UPDATE returns 0 rows if already claimed → raise)
    UPDATE shop_sms_activations
    SET bonus_claimed    = true,
        bonus_claimed_at = now()
    WHERE shop_id = p_shop_id
      AND bonus_claimed = false;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ALREADY_CLAIMED';
    END IF;

    -- Credit the SMS wallet atomically
    INSERT INTO shop_sms_wallets (shop_id, credits, total_purchased, total_used)
    VALUES (p_shop_id, v_credits, v_credits, 0)
    ON CONFLICT (shop_id) DO UPDATE
    SET credits         = shop_sms_wallets.credits         + v_credits,
        total_purchased = shop_sms_wallets.total_purchased + v_credits,
        updated_at      = now();

    RETURN jsonb_build_object('success', true, 'credits_added', v_credits);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_ussd_callback_retry(p_id uuid, p_stale_after_seconds integer DEFAULT 300)
 RETURNS ussd_callback_retry_queue
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
    v_row ussd_callback_retry_queue;
begin
    update ussd_callback_retry_queue
    set attempts = attempts + 1,
        last_attempt_at = now(),
        claimed_at = now()
    where id = p_id
      and resolved = false
      and escalated = false
      and (claimed_at is null or claimed_at < now() - make_interval(secs => p_stale_after_seconds))
    returning * into v_row;
    return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_sms_campaign(p_campaign_id uuid, p_user_id uuid, p_message text, p_recipients_count integer, p_segments integer, p_credits integer, p_mode text, p_sender text, p_source text DEFAULT 'dashboard'::text, p_scheduled_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_claim_now boolean DEFAULT false, p_blocked boolean DEFAULT false, p_flagged boolean DEFAULT false, p_flag_reason text DEFAULT NULL::text, p_flag_severity text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_acct      RECORD;
    v_role      TEXT;
    v_allowed   JSONB;
    v_ledger_id UUID;
    v_balance   INTEGER;
    v_status    TEXT;
BEGIN
    SELECT a.* INTO v_acct FROM sms_accounts a WHERE a.user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
    END IF;
    IF v_acct.status <> 'active' THEN
        RAISE EXCEPTION 'ACCOUNT_SUSPENDED';
    END IF;
    IF p_mode NOT IN ('platform', 'business') OR p_mode <> v_acct.mode THEN
        RAISE EXCEPTION 'MODE_MISMATCH';
    END IF;

    -- Role allowlist re-checked atomically (admin may narrow roles at any time).
    SELECT u.role INTO v_role FROM users u WHERE u.id = p_user_id AND u.status = 'active';
    IF v_role IS NULL THEN
        RAISE EXCEPTION 'USER_NOT_ACTIVE';
    END IF;
    SELECT value INTO v_allowed FROM admin_settings WHERE key = 'user_sms_allowed_roles';
    IF v_allowed IS NULL OR jsonb_typeof(v_allowed) <> 'array'
       OR NOT (v_allowed ? v_role) THEN
        RAISE EXCEPTION 'ROLE_NOT_ALLOWED';
    END IF;

    -- Blocked attempt: audit row only, no money movement.
    IF p_blocked THEN
        INSERT INTO sms_campaigns (id, account_id, sender_used, mode_at_send, message,
            recipients_count, segments, credits_charged, status, flagged, flag_reason,
            flag_severity, source)
        VALUES (p_campaign_id, v_acct.id, NULL, p_mode, p_message,
            p_recipients_count, p_segments, 0, 'blocked', true, p_flag_reason,
            COALESCE(p_flag_severity, 'fraud'), p_source);
        RETURN jsonb_build_object('blocked', true, 'campaign_id', p_campaign_id);
    END IF;

    IF p_credits IS NULL OR p_credits <= 0 OR p_recipients_count <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;
    IF p_sender IS NULL OR length(trim(p_sender)) = 0 THEN
        -- Never fall through to an implicit provider default sender.
        RAISE EXCEPTION 'SENDER_REQUIRED';
    END IF;

    -- Reserve the debit ledger key (client retry with same UUID = no-op).
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (v_acct.id, -p_credits, 'debit', 'debit:' || p_campaign_id::text, p_campaign_id::text)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true, 'campaign_id', p_campaign_id);
    END IF;

    -- Atomic compare-and-decrement (CHECK credits >= 0 backstops).
    UPDATE sms_wallets
    SET credits = credits - p_credits,
        total_used = total_used + p_credits,
        updated_at = now()
    WHERE account_id = v_acct.id AND credits >= p_credits
    RETURNING credits INTO v_balance;
    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    UPDATE sms_credit_ledger SET balance_after = v_balance WHERE id = v_ledger_id;

    v_status := CASE WHEN p_claim_now THEN 'processing' ELSE 'queued' END;

    INSERT INTO sms_campaigns (id, account_id, sender_used, mode_at_send, message,
        recipients_count, segments, credits_charged, status, flagged, flag_reason,
        flag_severity, scheduled_at, claimed_at, source)
    VALUES (p_campaign_id, v_acct.id, trim(p_sender), p_mode, p_message,
        p_recipients_count, p_segments, p_credits, v_status, p_flagged, p_flag_reason,
        p_flag_severity, p_scheduled_at,
        CASE WHEN p_claim_now THEN now() ELSE NULL END, p_source);

    RETURN jsonb_build_object(
        'already_processed', false,
        'campaign_id', p_campaign_id,
        'account_id', v_acct.id,
        'status', v_status,
        'balance', v_balance
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_airtime_commission(p_airtime_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_wallet_id uuid;
  v_role text; v_agent_expires_at timestamptz; v_eligible boolean;
BEGIN
  UPDATE public.airtime_orders
     SET commission_credited_at = now()
   WHERE id = p_airtime_order_id
     AND status = 'completed'
     AND commission_amount IS NOT NULL
     AND commission_credited_at IS NULL
     AND source = 'api'
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Nothing to credit (already credited, not completed, no commission, or not an API order)');
  END IF;

  IF v_order.user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'No developer/buyer to credit');
  END IF;

  SELECT role, agent_expires_at
    INTO v_role, v_agent_expires_at
    FROM public.users WHERE id = v_order.user_id;

  -- Lifetime-only gate: dealer passes unconditionally (dealer_expires_at is
  -- never NULL in practice — a dealer always eventually converts to lifetime
  -- agent on expiry, see lib/effective-role.ts); agent requires a NULL
  -- agent_expires_at (lifetime agent).
  --
  -- NULL-SAFE and FAIL-CLOSED: IS NOT DISTINCT FROM never returns NULL, so an
  -- unknown/NULL role is denied, not paid (mirrors credit_commission_wallet's
  -- IS DISTINCT FROM fix in 20260903d_commission_eligibility_security_fixes.sql).
  v_eligible := (v_role IS NOT DISTINCT FROM 'dealer')
    OR (v_role IS NOT DISTINCT FROM 'agent' AND v_agent_expires_at IS NULL);
  IF NOT v_eligible THEN
    RETURN jsonb_build_object('success', true, 'message', 'Buyer not a lifetime agent/dealer — platform keeps full commission');
  END IF;

  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 40)
    INTO v_pct FROM public.admin_settings WHERE key = 'utility_commission_partner_percent';
  v_pct := LEAST(GREATEST(COALESCE(v_pct, 40), 0), 100);
  v_share := round(v_order.commission_amount * v_pct / 100.0, 4);
  IF v_share <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Share rounds to zero');
  END IF;

  INSERT INTO public.commission_wallets (owner_id, balance, total_earned) VALUES (v_order.user_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.commission_wallets WHERE owner_id = v_order.user_id FOR UPDATE;
  UPDATE public.commission_wallets
     SET balance = balance + v_share, total_earned = total_earned + v_share, updated_at = now()
   WHERE id = v_wallet_id;
  INSERT INTO public.commission_wallet_transactions
    (commission_wallet_id, airtime_order_id, type, amount, description, status)
  VALUES (v_wallet_id, p_airtime_order_id, 'commission', v_share,
          'Airtime commission: ' || v_order.network || ' ' || v_order.beneficiary_phone, 'completed');
  UPDATE public.airtime_orders SET partner_commission_amount = v_share WHERE id = p_airtime_order_id;
  RETURN jsonb_build_object('success', true, 'amount', v_share);
EXCEPTION WHEN unique_violation THEN
  UPDATE public.airtime_orders SET commission_credited_at = now() WHERE id = p_airtime_order_id;
  RETURN jsonb_build_object('success', true, 'message', 'Already credited (ledger unique)');
END $function$
;

CREATE OR REPLACE FUNCTION public.credit_commission_wallet(p_utility_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_wallet_id uuid; v_role text;
BEGIN
  UPDATE public.utility_orders
     SET commission_credited_at = now()
   WHERE id = p_utility_order_id
     AND status = 'completed'
     AND commission_amount IS NOT NULL
     AND commission_credited_at IS NULL
     AND source IN ('api', 'dashboard')
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Nothing to credit (already credited, not completed, no commission, or not an eligible source)');
  END IF;

  IF v_order.user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'No developer/buyer to credit');
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_order.user_id;
  -- NULL-SAFE and FAIL-CLOSED: a plain `v_role NOT IN (...)` yields NULL when v_role is
  -- NULL (nullable column, or no matching users row), and PL/pgSQL treats a NULL IF
  -- condition as false — which would fall THROUGH and pay commission to an unverified
  -- role. IS DISTINCT FROM is null-safe, so an unknown role is denied, not paid.
  IF v_role IS DISTINCT FROM 'agent' AND v_role IS DISTINCT FROM 'dealer' THEN
    RETURN jsonb_build_object('success', true, 'message', 'Buyer role not eligible for commission — platform keeps full commission');
  END IF;

  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 40)
    INTO v_pct FROM public.admin_settings WHERE key = 'utility_commission_partner_percent';
  v_pct := LEAST(GREATEST(COALESCE(v_pct, 40), 0), 100);
  v_share := round(v_order.commission_amount * v_pct / 100.0, 4);
  IF v_share <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Share rounds to zero');
  END IF;

  INSERT INTO public.commission_wallets (owner_id, balance, total_earned) VALUES (v_order.user_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.commission_wallets WHERE owner_id = v_order.user_id FOR UPDATE;
  UPDATE public.commission_wallets
     SET balance = balance + v_share, total_earned = total_earned + v_share, updated_at = now()
   WHERE id = v_wallet_id;
  INSERT INTO public.commission_wallet_transactions
    (commission_wallet_id, utility_order_id, type, amount, description, status)
  VALUES (v_wallet_id, p_utility_order_id, 'commission', v_share,
          'Commission: ' || v_order.biller || ' ' || v_order.account_number, 'completed');
  UPDATE public.utility_orders SET partner_commission_amount = v_share WHERE id = p_utility_order_id;
  RETURN jsonb_build_object('success', true, 'amount', v_share);
EXCEPTION WHEN unique_violation THEN
  UPDATE public.utility_orders SET commission_credited_at = now() WHERE id = p_utility_order_id;
  RETURN jsonb_build_object('success', true, 'message', 'Already credited (ledger unique)');
END $function$
;

CREATE OR REPLACE FUNCTION public.credit_lead_margin(p_order_reference text, p_upline_shop_id uuid, p_amount numeric, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_id  UUID;
  v_wallet_id UUID;
BEGIN
  IF p_order_reference IS NULL OR length(p_order_reference) = 0 OR length(p_order_reference) > 100 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid reference');
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'No margin to credit');
  END IF;

  SELECT owner_id INTO v_owner_id FROM public.shop_profiles WHERE id = p_upline_shop_id;
  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Upline shop not found');
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_owner_id FOR UPDATE;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, type, amount, description, status, credit_source, order_reference)
  VALUES
    (v_wallet_id, 'profit', p_amount,
     COALESCE(p_description, 'Sub-agent wallet purchase margin'),
     'completed', 'wallet_sub_purchase', p_order_reference);

  UPDATE public.shop_wallets
  SET balance = balance + p_amount, total_earned = total_earned + p_amount, updated_at = NOW()
  WHERE id = v_wallet_id;

  RETURN jsonb_build_object('success', true, 'message', 'Credited ' || p_amount);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already credited');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_shop_afa_profit(p_afa_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profit DECIMAL;
  v_owner_id UUID;
  v_wallet_id UUID;
  v_guest_phone TEXT;
  v_existing_tx_id UUID;
BEGIN
  SELECT
    ao.profit,
    sp.owner_id,
    ao.guest_phone
  INTO
    v_profit,
    v_owner_id,
    v_guest_phone
  FROM public.afa_orders ao
  JOIN public.shop_profiles sp ON ao.shop_id = sp.id
  WHERE ao.id = p_afa_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  IF v_profit <= 0 OR v_profit IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No profit to credit');
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  -- Lock BEFORE checking idempotency — same rule as credit_shop_profit, prevents
  -- two concurrent callers (e.g. a retried admin click) from both passing the check.
  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = v_owner_id
  FOR UPDATE;

  SELECT id INTO v_existing_tx_id
  FROM public.shop_wallet_transactions
  WHERE afa_order_id = p_afa_order_id AND type = 'profit';

  IF v_existing_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already credited');
  END IF;

  UPDATE public.shop_wallets
  SET
    balance = balance + v_profit,
    total_earned = total_earned + v_profit,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, afa_order_id, type, amount, description, status)
  VALUES
    (v_wallet_id, p_afa_order_id, 'profit', v_profit, 'AFA Registration: ' || COALESCE(v_guest_phone, 'guest'), 'completed');

  RETURN jsonb_build_object('success', true, 'message', 'Credited ' || v_profit);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_shop_order_profits(p_shop_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profit        DECIMAL;
  v_sub_owner_id  UUID;
  v_network       TEXT;
  v_package_size  TEXT;
  v_guest_phone   TEXT;
  v_status        TEXT;
  v_sub_wallet_id UUID;
  v_credited_sub  BOOLEAN := false;
  v_credited_anc  INTEGER := 0;
  v_total_anc     DECIMAL := 0;
  v_existing      UUID;
  v_split         RECORD;
  v_anc_owner     UUID;
  v_anc_wallet    UUID;
  v_has_splits    BOOLEAN;
  v_legacy_shop   UUID;
  v_legacy_profit DECIMAL;
BEGIN
  SELECT so.profit, sp.owner_id, so.network, so.package_size, so.guest_phone,
         so.status, so.parent_shop_id, so.parent_profit
  INTO   v_profit, v_sub_owner_id, v_network, v_package_size, v_guest_phone,
         v_status, v_legacy_shop, v_legacy_profit
  FROM public.shop_orders so
  JOIN public.shop_profiles sp ON so.shop_id = sp.id
  WHERE so.id = p_shop_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  v_has_splits := EXISTS (SELECT 1 FROM public.shop_order_splits WHERE order_id = p_shop_order_id);

  IF NOT v_has_splits AND v_legacy_shop IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not a sub-agent order — use credit_shop_profit');
  END IF;

  IF v_status IN ('refunded','failed') THEN
    RETURN jsonb_build_object('success', true, 'message', 'Order not creditable (status ' || v_status || ')');
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_sub_owner_id, 0, 0) ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_sub_wallet_id FROM public.shop_wallets WHERE owner_id = v_sub_owner_id FOR UPDATE;

  IF COALESCE(v_profit, 0) > 0 THEN
    SELECT id INTO v_existing FROM public.shop_wallet_transactions
    WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND shop_wallet_id = v_sub_wallet_id;
    IF v_existing IS NULL THEN
      UPDATE public.shop_wallets
      SET balance = balance + v_profit, total_earned = total_earned + v_profit, updated_at = NOW()
      WHERE id = v_sub_wallet_id;

      INSERT INTO public.shop_wallet_transactions
        (shop_wallet_id, shop_order_id, type, amount, description, status, credit_source)
      VALUES
        (v_sub_wallet_id, p_shop_order_id, 'profit', v_profit,
         'Sale: ' || v_network || ' ' || v_package_size || ' to ' || v_guest_phone, 'completed', 'order');
      v_credited_sub := true;
    END IF;
  END IF;

  FOR v_split IN
    SELECT s.beneficiary_shop_id AS beneficiary_shop_id, s.level AS level, s.profit AS profit
    FROM public.shop_order_splits s
    WHERE s.order_id = p_shop_order_id AND s.profit > 0
    UNION ALL
    SELECT v_legacy_shop, 1::SMALLINT, v_legacy_profit
    WHERE NOT v_has_splits
      AND v_legacy_shop IS NOT NULL
      AND COALESCE(v_legacy_profit, 0) > 0
    ORDER BY 2 ASC
  LOOP
    SELECT owner_id INTO v_anc_owner FROM public.shop_profiles WHERE id = v_split.beneficiary_shop_id;
    CONTINUE WHEN v_anc_owner IS NULL;

    INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
    VALUES (v_anc_owner, 0, 0) ON CONFLICT (owner_id) DO NOTHING;
    SELECT id INTO v_anc_wallet FROM public.shop_wallets WHERE owner_id = v_anc_owner FOR UPDATE;

    SELECT id INTO v_existing FROM public.shop_wallet_transactions
    WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND shop_wallet_id = v_anc_wallet;
    CONTINUE WHEN v_existing IS NOT NULL;

    UPDATE public.shop_wallets
    SET balance = balance + v_split.profit, total_earned = total_earned + v_split.profit, updated_at = NOW()
    WHERE id = v_anc_wallet;

    INSERT INTO public.shop_wallet_transactions
      (shop_wallet_id, shop_order_id, type, amount, description, status, credit_source)
    VALUES
      (v_anc_wallet, p_shop_order_id, 'profit', v_split.profit,
       'Network sale: ' || v_network || ' ' || v_package_size || ' via sub-agent (level ' || v_split.level || ')',
       'completed', 'order_parent');

    v_credited_anc := v_credited_anc + 1;
    v_total_anc := v_total_anc + v_split.profit;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'credited_sub', v_credited_sub, 'sub_amount', COALESCE(v_profit, 0),
    'credited_ancestors', v_credited_anc, 'ancestor_amount', v_total_anc,
    'parent_amount', v_total_anc,
    'message', CASE
      WHEN NOT v_credited_sub AND v_credited_anc = 0 THEN 'Already credited'
      ELSE 'Credited'
    END
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_shop_profit(p_shop_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profit DECIMAL;
  v_owner_id UUID;
  v_wallet_id UUID;
  v_shop_name TEXT;
  v_guest_phone TEXT;
  v_network TEXT;
  v_package_size TEXT;
  v_existing_tx_id UUID;
BEGIN
  -- 1. Fetch Order & Owner Details
  SELECT
    so.profit,
    sp.owner_id,
    so.network,
    so.package_size,
    so.guest_phone
  INTO
    v_profit,
    v_owner_id,
    v_network,
    v_package_size,
    v_guest_phone
  FROM public.shop_orders so
  JOIN public.shop_profiles sp ON so.shop_id = sp.id
  WHERE so.id = p_shop_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  IF v_profit <= 0 OR v_profit IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No profit to credit');
  END IF;

  -- 2. Get or Create Wallet (Atomic Upsert strategy)
  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  -- 3. Lock the wallet row BEFORE checking idempotency (was: checked first, locked
  -- never). Serializes concurrent callers for the same owner — the second one to
  -- reach here blocks until the first commits, then sees the transaction row the
  -- first inserted below.
  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = v_owner_id
  FOR UPDATE;

  -- 4. Idempotency Check: Don't credit if already credited — now race-free because
  -- it runs under the wallet lock acquired above.
  SELECT id INTO v_existing_tx_id
  FROM public.shop_wallet_transactions
  WHERE shop_order_id = p_shop_order_id AND type = 'profit';

  IF v_existing_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already credited');
  END IF;

  -- 5. Atomic Balance Update
  UPDATE public.shop_wallets
  SET
    balance = balance + v_profit,
    total_earned = total_earned + v_profit,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  -- 6. Log Transaction
  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, shop_order_id, type, amount, description, status)
  VALUES
    (v_wallet_id, p_shop_order_id, 'profit', v_profit, 'Sale: ' || v_network || ' ' || v_package_size || ' to ' || v_guest_phone, 'completed');

  RETURN jsonb_build_object('success', true, 'message', 'Credited ' || v_profit);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_shop_ussd_profit(p_shop_id uuid, p_profit numeric, p_ussd_ref text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_owner_id   UUID;
    v_wallet_id  UUID;
BEGIN
    IF p_profit <= 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'No profit to credit');
    END IF;

    -- Idempotency: skip if already credited with this ref
    IF EXISTS (
        SELECT 1 FROM public.shop_wallet_transactions WHERE ussd_ref = p_ussd_ref
    ) THEN
        RETURN jsonb_build_object('success', true, 'message', 'Already credited');
    END IF;

    -- Get shop owner
    SELECT owner_id INTO v_owner_id FROM public.shop_profiles WHERE id = p_shop_id;
    IF v_owner_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Shop not found');
    END IF;

    -- Upsert wallet
    INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
    VALUES (v_owner_id, 0, 0)
    ON CONFLICT (owner_id) DO NOTHING;

    SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_owner_id;

    -- Atomic credit
    UPDATE public.shop_wallets
    SET balance       = balance + p_profit,
        total_earned  = total_earned + p_profit,
        updated_at    = NOW()
    WHERE id = v_wallet_id;

    -- Log with idempotency ref
    INSERT INTO public.shop_wallet_transactions
        (shop_wallet_id, type, amount, description, status, ussd_ref)
    VALUES
        (v_wallet_id, 'profit', p_profit, p_description, 'completed', p_ussd_ref);

    RETURN jsonb_build_object('success', true, 'message', 'Credited ' || p_profit);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_sms_credits(p_shop_id uuid, p_credits integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    INSERT INTO shop_sms_wallets (shop_id, credits, total_purchased, total_used)
    VALUES (p_shop_id, p_credits, p_credits, 0)
    ON CONFLICT (shop_id) DO UPDATE
    SET credits          = shop_sms_wallets.credits          + p_credits,
        total_purchased  = shop_sms_wallets.total_purchased  + p_credits,
        updated_at       = now();

    RETURN jsonb_build_object('success', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_user_sms_credits(p_account_id uuid, p_credits integer, p_key text, p_kind text DEFAULT 'refund'::text, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_ledger_id UUID;
    v_balance   INTEGER;
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;
    IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
        RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
    END IF;
    IF p_kind NOT IN ('purchase', 'refund', 'bonus', 'admin_adjust') THEN
        RAISE EXCEPTION 'INVALID_KIND';
    END IF;

    -- Reserve the key. Conflict = this credit already happened.
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (p_account_id, p_credits, p_kind, p_key, p_reference)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    UPDATE sms_wallets
    SET credits    = credits + p_credits,
        total_used = CASE WHEN p_kind = 'refund'
                          THEN GREATEST(0, total_used - p_credits)
                          ELSE total_used END,
        total_purchased = CASE WHEN p_kind IN ('purchase', 'bonus')
                               THEN total_purchased + p_credits
                               ELSE total_purchased END,
        updated_at = now()
    WHERE account_id = p_account_id
    RETURNING credits INTO v_balance;

    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    UPDATE sms_credit_ledger SET balance_after = v_balance WHERE id = v_ledger_id;

    RETURN jsonb_build_object('already_processed', false, 'balance', v_balance);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.credit_utility_commission(p_utility_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_partner_id uuid; v_wallet_id uuid;
BEGIN
  UPDATE public.utility_orders
     SET commission_credited_at = now()
   WHERE id = p_utility_order_id
     AND status = 'completed'
     AND commission_amount IS NOT NULL
     AND commission_credited_at IS NULL
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Nothing to credit (already credited, not completed, or no commission)');
  END IF;

  IF v_order.shop_id IS NOT NULL THEN
    SELECT owner_id INTO v_partner_id FROM public.shop_profiles WHERE id = v_order.shop_id;
  ELSIF v_order.source IN ('api', 'dashboard') THEN
    -- Route-and-delegate: no shop_id -> the role-gated commission wallet path.
    -- This claim already fired (commission_credited_at is set), so undo it and
    -- let credit_commission_wallet perform its OWN claim + credit atomically.
    --
    -- LOAD-BEARING INVARIANT — do not split this into two separate RPC calls from
    -- application code. The unclaim below and the delegate call are safe ONLY because
    -- they execute inside this single function invocation (one transaction, row lock
    -- held throughout), so no other session can ever observe the momentarily-unclaimed
    -- row and double-credit it. Two round-trips from the app layer would commit the
    -- unclaim first and reopen exactly that race.
    UPDATE public.utility_orders SET commission_credited_at = NULL WHERE id = p_utility_order_id;
    RETURN public.credit_commission_wallet(p_utility_order_id);
  END IF;

  IF v_partner_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'No partner — platform keeps full commission');
  END IF;

  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 40)
    INTO v_pct FROM public.admin_settings WHERE key = 'utility_commission_partner_percent';
  v_pct := LEAST(GREATEST(COALESCE(v_pct, 40), 0), 100);
  v_share := round(v_order.commission_amount * v_pct / 100.0, 4);
  IF v_share <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Share rounds to zero');
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned) VALUES (v_partner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_partner_id FOR UPDATE;
  UPDATE public.shop_wallets
     SET balance = balance + v_share, total_earned = total_earned + v_share, updated_at = now()
   WHERE id = v_wallet_id;
  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, utility_order_id, type, amount, description, status)
  VALUES (v_wallet_id, p_utility_order_id, 'utility_commission', v_share,
          'Utility commission: ' || v_order.biller || ' ' || v_order.account_number, 'completed');
  UPDATE public.utility_orders SET partner_commission_amount = v_share WHERE id = p_utility_order_id;
  RETURN jsonb_build_object('success', true, 'amount', v_share);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', true, 'message', 'Already credited (ledger unique)');
END $function$
;

CREATE OR REPLACE FUNCTION public.credit_wallet_balance(p_user_id uuid, p_amount numeric)
 RETURNS TABLE(wallet_id uuid, new_balance numeric, new_total_spent numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    UPDATE public.wallets
    SET
        balance     = balance + p_amount,
        total_spent = GREATEST(0, COALESCE(total_spent, 0) - p_amount),
        updated_at  = NOW()
    WHERE user_id = p_user_id
    RETURNING id, balance, COALESCE(total_spent, 0)
    INTO v_wallet_id, v_new_balance, v_new_total_spent;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_total_spent;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.debit_sms_credits(p_shop_id uuid, p_credits integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_new_credits INTEGER;
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = p_shop_id) THEN
        RAISE EXCEPTION 'NOT_ACTIVATED';
    END IF;

    IF EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = p_shop_id AND sms_suspended = true) THEN
        RAISE EXCEPTION 'SUSPENDED';
    END IF;

    UPDATE shop_sms_wallets
    SET credits    = credits - p_credits,
        total_used = total_used + p_credits,
        updated_at = now()
    WHERE shop_id = p_shop_id AND credits >= p_credits
    RETURNING credits INTO v_new_credits;

    IF v_new_credits IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    RETURN jsonb_build_object('success', true, 'remaining', v_new_credits);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deduct_wallet_balance(p_user_id uuid, p_amount numeric)
 RETURNS TABLE(wallet_id uuid, new_balance numeric, new_total_spent numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    -- Atomic: UPDATE with WHERE balance >= amount.
    -- If balance is insufficient, no rows are updated → we raise below.
    UPDATE public.wallets
    SET
        balance = balance - p_amount,
        total_spent = COALESCE(total_spent, 0) + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND balance >= p_amount
    RETURNING id, balance, COALESCE(total_spent, 0)
    INTO v_wallet_id, v_new_balance, v_new_total_spent;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_total_spent;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_shop_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_owner_id  UUID;
    v_shop_id   UUID;
    v_wallet_id UUID;
BEGIN
    v_owner_id := auth.uid();

    IF v_owner_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
    END IF;

    SELECT id INTO v_shop_id   FROM public.shop_profiles WHERE owner_id = v_owner_id;
    SELECT id INTO v_wallet_id FROM public.shop_wallets  WHERE owner_id = v_owner_id;

    IF v_shop_id IS NULL AND v_wallet_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'No shop found to delete');
    END IF;

    IF v_wallet_id IS NOT NULL THEN
        INSERT INTO public.archived_shop_financial_records (owner_id, shop_id, wallet_id, source_table, record)
        SELECT v_owner_id, v_shop_id, v_wallet_id, 'shop_wallets', to_jsonb(w)
        FROM public.shop_wallets w WHERE w.id = v_wallet_id;

        INSERT INTO public.archived_shop_financial_records (owner_id, shop_id, wallet_id, source_table, record)
        SELECT v_owner_id, v_shop_id, v_wallet_id, 'shop_wallet_transactions', to_jsonb(t)
        FROM public.shop_wallet_transactions t WHERE t.shop_wallet_id = v_wallet_id;
    END IF;

    IF v_shop_id IS NOT NULL THEN
        INSERT INTO public.archived_shop_financial_records (owner_id, shop_id, wallet_id, source_table, record)
        SELECT v_owner_id, v_shop_id, v_wallet_id, 'shop_orders', to_jsonb(o)
        FROM public.shop_orders o WHERE o.shop_id = v_shop_id;
    END IF;

    IF v_wallet_id IS NOT NULL THEN
        DELETE FROM public.shop_wallets WHERE id = v_wallet_id;
    END IF;

    IF v_shop_id IS NOT NULL THEN
        DELETE FROM public.shop_profiles WHERE id = v_shop_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Shop deleted successfully');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.effective_owner_cost(p_price numeric, p_agent_price numeric, p_dealer_price numeric, p_role text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_role = 'dealer' AND COALESCE(p_dealer_price, 0) > 0 THEN p_dealer_price
    WHEN p_role = 'agent'  AND COALESCE(p_agent_price, 0)  > 0 THEN p_agent_price
    ELSE COALESCE(p_price, 0)
  END
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_max_payment_details()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF (SELECT COUNT(*) FROM public.shop_payment_details WHERE shop_owner_id = NEW.shop_owner_id) >= 5 THEN
        RAISE EXCEPTION 'You can only save a maximum of 5 payment details.';
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_single_default_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.is_default = TRUE THEN
        UPDATE public.shop_payment_details
        SET is_default = FALSE
        WHERE shop_owner_id = NEW.shop_owner_id
          AND id <> NEW.id;
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_sub_agent_recruit_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  current_count INTEGER;
  raw_cap TEXT;
  cap NUMERIC;
BEGIN
  IF NEW.upline_user_id IS NULL THEN
    RETURN NEW; -- legacy shop-invite rows are not subject to this cap
  END IF;

  -- Lock BEFORE counting (not after) — this is the entire fix. Two
  -- concurrent inserts for the same recruiter serialize here; the second
  -- only proceeds once the first's transaction has committed (and its row is
  -- therefore visible to this COUNT) or rolled back.
  PERFORM pg_advisory_xact_lock(hashtext('sub_agent_recruit_cap:' || NEW.upline_user_id::text));

  SELECT count(*) INTO current_count
  FROM public.sub_agents
  WHERE upline_user_id = NEW.upline_user_id;

  -- shop_global_settings.value is JSONB stored as a raw text-castable
  -- literal — mirrors the parseFloat(row.value) read convention already used
  -- in TypeScript (lib/sub-agent-create.ts, app/api/shop/withdraw/route.ts).
  SELECT value::text INTO raw_cap
  FROM public.shop_global_settings
  WHERE key = 'sub_agent_max_recruits';

  cap := NULLIF(raw_cap, '')::numeric;
  IF cap IS NULL OR cap <= 0 THEN
    cap := 5; -- DEFAULT_MAX_RECRUITS, kept in sync with lib/sub-agent-create.ts
  END IF;

  IF current_count >= cap THEN
    RAISE EXCEPTION 'SUB_AGENT_RECRUIT_CAP_EXCEEDED'
      USING HINT = 'Recruiter has reached their maximum number of sub-agents.';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_subagent_contact_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.subagent_contact_override', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF (NEW.email IS DISTINCT FROM OLD.email OR NEW.phone_number IS DISTINCT FROM OLD.phone_number)
     AND EXISTS (
       SELECT 1 FROM public.sub_agents
       WHERE user_id = NEW.id AND upline_shop_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Contact info for a sub-agent account cannot be changed directly. Contact support.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_support_thread_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('support_thread_cap:' || NEW.user_id::text));
  SELECT count(*) INTO open_count
  FROM public.support_threads
  WHERE user_id = NEW.user_id AND status = 'open';
  IF open_count >= 3 THEN
    RAISE EXCEPTION 'OPEN_THREAD_LIMIT'
      USING HINT = 'A user may have at most 3 open support threads.';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_website_request_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('website_request_cap:' || NEW.user_id::text));
  SELECT count(*) INTO open_count
  FROM public.website_requests
  WHERE user_id = NEW.user_id AND status IN ('new', 'contacted');
  IF open_count >= 1 THEN
    RAISE EXCEPTION 'OPEN_WEBSITE_REQUEST_LIMIT'
      USING HINT = 'A user may have at most 1 open website/app request or call request at a time.';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_sms_account(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user   RECORD;
    v_acct   RECORD;
BEGIN
    SELECT id, status INTO v_user FROM users WHERE id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;
    IF v_user.status <> 'active' THEN
        RAISE EXCEPTION 'USER_NOT_ACTIVE';
    END IF;

    INSERT INTO sms_accounts (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_acct FROM sms_accounts WHERE user_id = p_user_id;

    INSERT INTO sms_wallets (account_id)
    VALUES (v_acct.id)
    ON CONFLICT (account_id) DO NOTHING;

    RETURN jsonb_build_object(
        'account_id', v_acct.id,
        'mode', v_acct.mode,
        'status', v_acct.status,
        'default_sender', v_acct.default_sender
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.escalate_stale_sub_withdrawals()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count int;
BEGIN
  WITH to_escalate AS (
    SELECT swt.id
    FROM public.shop_wallet_transactions swt
    JOIN public.shop_wallets sw   ON sw.id  = swt.shop_wallet_id
    JOIN public.sub_agents   sa   ON sa.user_id = sw.owner_id
    LEFT JOIN public.shop_profiles lead ON lead.id = sa.upline_shop_id
    LEFT JOIN public.users lu           ON lu.id = lead.owner_id
    WHERE swt.status = 'shop_owner_pending'
      AND ( swt.escalate_after < now() OR lead.id IS NULL OR lead.approval_status IN ('suspended','rejected')
         OR lu.id IS NULL
         OR NOT ( (lu.role='agent' AND lu.agent_expires_at IS NULL) OR (lu.role='dealer' AND lu.dealer_expires_at > now()) ) )
    FOR UPDATE OF swt
  )
  UPDATE public.shop_wallet_transactions swt
  SET status='pending', auto_escalated=true, updated_at=now()
  FROM to_escalate te WHERE swt.id = te.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'escalated', v_count);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.expire_stale_hubtel_receive(p_older_than_minutes integer DEFAULT 10)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n integer;
BEGIN
  UPDATE public.hubtel_receive_charges
     SET status='expired'
   WHERE status='pending' AND created_at < now() - make_interval(mins => p_older_than_minutes);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$
;

CREATE OR REPLACE FUNCTION public.finalize_results_checker_sale(p_order_id uuid, p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.results_checker_inventory
  SET
    status                 = 'sold',
    reservation_expires_at = NULL,
    sold_to_user_id        = p_user_id,
    sold_at                = NOW(),
    updated_at             = NOW()
  WHERE reserved_by_order = p_order_id
    AND status = 'reserved';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.find_drifted_shop_pricing()
 RETURNS TABLE(shop_id uuid, package_id uuid, owner_id uuid, role text, selling_price numeric, owner_cost numeric, sub_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, u.role,
    sp.selling_price,
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role) AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.users u           ON u.id  = spf.owner_id
  JOIN public.data_packages dp  ON dp.id = sp.package_id
  WHERE NOT EXISTS (SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id)
    AND (
      sp.selling_price <= public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role)
      OR (sp.sub_price IS NOT NULL
          AND sp.sub_price < public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role))
    )

  UNION ALL

  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, 'sub-agent'::text AS role,
    sp.selling_price,
    up.sub_price AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.sub_agents sa     ON sa.user_id = spf.owner_id
  JOIN public.shop_pricing up   ON up.shop_id = sa.upline_shop_id AND up.package_id = sp.package_id
  WHERE up.sub_price IS NOT NULL
    AND sp.selling_price < up.sub_price

  UNION ALL

  -- New-model sub-agents only (Task 5, 2026-09-16, fix round): sa.upline_shop_id IS NULL
  -- makes this branch mutually exclusive with the old-model branch immediately above --
  -- without this guard, a sub_agents row that happens to carry BOTH upline_shop_id (old
  -- model) AND upline_user_id (new model) would be evaluated by both branches, potentially
  -- emitting a duplicated, differently-based drift alert for the same shop_pricing row the
  -- moment an admin changed a package price (confirmed live: 0 impact today only because
  -- neither branch currently flags any of the 4 shops in that overlapping state -- this
  -- guard prevents that from becoming a real, confusing double-alert later).
  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, 'subagent'::text AS role,
    sp.selling_price,
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, ru.role)
      + COALESCE(
          (SELECT sap.markup FROM public.sub_agent_pricing sap
           WHERE sap.sub_user_id = spf.owner_id AND sap.product_type = 'data' AND sap.product_ref = sp.package_id::text),
          (SELECT sadp.markup FROM public.sub_agent_default_pricing sadp
           WHERE sadp.recruiter_id = sa.upline_user_id AND sadp.product_type = 'data' AND sadp.product_ref = sp.package_id::text),
          0
        ) AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.sub_agents sa     ON sa.user_id = spf.owner_id AND sa.status = 'active' AND sa.upline_user_id IS NOT NULL AND sa.upline_shop_id IS NULL
  JOIN public.users ru          ON ru.id = sa.upline_user_id
  JOIN public.data_packages dp  ON dp.id = sp.package_id
  WHERE sp.selling_price <= (
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, ru.role)
    + COALESCE(
        (SELECT sap.markup FROM public.sub_agent_pricing sap
         WHERE sap.sub_user_id = spf.owner_id AND sap.product_type = 'data' AND sap.product_ref = sp.package_id::text),
        (SELECT sadp.markup FROM public.sub_agent_default_pricing sadp
         WHERE sadp.recruiter_id = sa.upline_user_id AND sadp.product_type = 'data' AND sadp.product_ref = sp.package_id::text),
        0
      )
  );
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_trends(p_range text DEFAULT '7d'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
        v_start := CURRENT_DATE - 6;
    END IF;

    IF v_is_hourly THEN
        SELECT json_agg(t) INTO series_json FROM (
            SELECT to_char(g.b, 'HH24:00') AS bucket,
                   COALESCE(o.revenue,0) AS revenue, COALESCE(o.orders,0) AS orders, COALESCE(o.profit,0) AS profit
            FROM generate_series(date_trunc('hour', CURRENT_DATE::timestamp), date_trunc('hour', now()), interval '1 hour') g(b)
            LEFT JOIN (
                SELECT date_trunc('hour', created_at) hb, sum(price) revenue, count(*) orders,
                       sum(price - COALESCE(cost_price_at_time,0)) profit
                FROM public.orders WHERE status='completed' AND created_at >= CURRENT_DATE GROUP BY 1
            ) o ON o.hb = g.b
            ORDER BY g.b
        ) t;
    ELSE
        SELECT json_agg(t) INTO series_json FROM (
            SELECT to_char(g.b, 'Mon DD') AS bucket,
                   COALESCE(o.revenue,0) AS revenue, COALESCE(o.orders,0) AS orders, COALESCE(o.profit,0) AS profit
            FROM generate_series(v_start::timestamp, CURRENT_DATE::timestamp, interval '1 day') g(b)
            LEFT JOIN (
                SELECT created_at::date db, sum(price) revenue, count(*) orders,
                       sum(price - COALESCE(cost_price_at_time,0)) profit
                FROM public.orders WHERE status='completed' AND created_at >= v_start GROUP BY 1
            ) o ON o.db = g.b::date
            ORDER BY g.b
        ) t;
    END IF;

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
$function$
;

CREATE OR REPLACE FUNCTION public.get_admin_recent_activity(p_limit integer DEFAULT 12)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE result json; v_limit int := LEAST(GREATEST(COALESCE(p_limit,12),1),50);
BEGIN
    SELECT COALESCE(json_agg(t), '[]'::json) INTO result FROM (
        SELECT kind, id, label, amount, status, at FROM (
            (SELECT 'order'::text AS kind, o.id::text AS id, (o.network || ' ' || o.size) AS label,
                    o.price::numeric AS amount, COALESCE(o.status,'') AS status, o.created_at AS at
             FROM public.orders o WHERE o.created_at IS NOT NULL ORDER BY o.created_at DESC LIMIT v_limit)
            UNION ALL
            (SELECT 'withdrawal'::text, w.id::text, COALESCE(NULLIF(w.description,''),'Withdrawal'),
                    w.amount::numeric, COALESCE(w.status,''), w.created_at
             FROM public.shop_wallet_transactions w WHERE w.type='withdrawal' AND w.created_at IS NOT NULL
             ORDER BY w.created_at DESC LIMIT v_limit)
            UNION ALL
            (SELECT 'signup'::text, ('user-' || substr(u.id::text, 1, 8)),
                    COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name),''),'New user'),
                    NULL::numeric, COALESCE(u.role,''), u.created_at
             FROM public.users u WHERE u.created_at IS NOT NULL ORDER BY u.created_at DESC LIMIT v_limit)
        ) unioned
        ORDER BY at DESC NULLS LAST LIMIT v_limit
    ) t;
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_orders_stats(p_user_id uuid, p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_network text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(total_count bigint, pending_count bigint, queued_count bigint, processing_count bigint, completed_count bigint, failed_count bigint, refunded_count bigint, total_amount numeric, total_data_gb numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with matched as (
    select
      o.status,
      o.price,
      o.payment_status,
      o.size
    from public.orders o
    where o.user_id = p_user_id
      and o.shop_order_id is null
      and o.created_at >= p_date_from
      and o.created_at <= p_date_to
      and (p_network is null or o.network = p_network)
      and (p_category is null or coalesce(o.category, 'data') = p_category)
      and (p_search is null or o.phone_number ilike '%' || p_search || '%')
  ),
  sized as (
    select
      status,
      price,
      payment_status,
      (regexp_match(lower(size), '([\d.]+)\s*(gb|mb)'))[1]::numeric as size_value,
      (regexp_match(lower(size), '([\d.]+)\s*(gb|mb)'))[2] as size_unit
    from matched
  )
  select
    count(*) as total_count,
    count(*) filter (where status = 'pending') as pending_count,
    count(*) filter (where status = 'queued') as queued_count,
    count(*) filter (where status = 'processing') as processing_count,
    count(*) filter (where status = 'completed') as completed_count,
    count(*) filter (where status = 'failed') as failed_count,
    count(*) filter (where status = 'refunded') as refunded_count,
    coalesce(sum(price) filter (where payment_status is distinct from 'refunded'), 0) as total_amount,
    coalesce(sum(
      case
        when size_unit = 'gb' then size_value
        when size_unit = 'mb' then size_value / 1024
        else 0
      end
    ) filter (where payment_status is distinct from 'refunded'), 0) as total_data_gb
  from sized;
$function$
;

CREATE OR REPLACE FUNCTION public.get_profit_summary(p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_prev_start_date timestamp with time zone, p_prev_end_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    -- Current Period
    v_main_revenue DECIMAL := 0;
    v_main_cost DECIMAL := 0;
    v_main_orders INT := 0;
    v_main_excluded INT := 0;

    v_shop_revenue DECIMAL := 0;
    v_shop_platform_cost DECIMAL := 0;
    v_shop_owner_profit_sum DECIMAL := 0;
    v_shop_orders INT := 0;
    v_shop_excluded INT := 0;

    -- Previous Period (for Growth)
    v_prev_main_profit DECIMAL := 0;
    v_prev_shop_platform_profit DECIMAL := 0;

    -- Totals
    v_total_revenue DECIMAL;
    v_total_cost DECIMAL;
    v_total_profit DECIMAL;
    v_profit_margin DECIMAL := 0;
    v_growth_pct DECIMAL := 0;
BEGIN
    -- MAIN: Current Period (Only Completed, Valid Cost)
    SELECT 
        COALESCE(SUM(price), 0),
        COALESCE(SUM(cost_price_at_time), 0),
        COUNT(id)
    INTO v_main_revenue, v_main_cost, v_main_orders
    FROM public.orders
    WHERE status = 'completed' AND shop_order_id IS NULL AND cost_price_at_time > 0
    AND created_at BETWEEN p_start_date AND p_end_date;

    -- MAIN: Excluded Orders
    SELECT COUNT(id) INTO v_main_excluded
    FROM public.orders
    WHERE status = 'completed' AND shop_order_id IS NULL AND (cost_price_at_time IS NULL OR cost_price_at_time <= 0)
    AND created_at BETWEEN p_start_date AND p_end_date;

    -- SHOP: Current Period
    SELECT 
        COALESCE(SUM(cost_price), 0),          -- What platform earned
        COALESCE(SUM(admin_cost_at_time), 0),  -- Platform's true cost
        COALESCE(SUM(profit), 0),              -- Owner's cut
        COUNT(id)
    INTO v_shop_revenue, v_shop_platform_cost, v_shop_owner_profit_sum, v_shop_orders
    FROM public.shop_orders
    WHERE status = 'completed' AND admin_cost_at_time IS NOT NULL AND admin_cost_at_time > 0
    AND created_at BETWEEN p_start_date AND p_end_date;

    -- SHOP: Excluded Orders
    SELECT COUNT(id) INTO v_shop_excluded
    FROM public.shop_orders
    WHERE status = 'completed' AND (admin_cost_at_time IS NULL OR admin_cost_at_time <= 0)
    AND created_at BETWEEN p_start_date AND p_end_date;

    -- PREVIOUS PERIOD (For Growth calculation)
    SELECT COALESCE(SUM(price - cost_price_at_time), 0) INTO v_prev_main_profit
    FROM public.orders
    WHERE status = 'completed' AND shop_order_id IS NULL AND cost_price_at_time > 0
    AND created_at BETWEEN p_prev_start_date AND p_prev_end_date;

    SELECT COALESCE(SUM(cost_price - admin_cost_at_time), 0) INTO v_prev_shop_platform_profit
    FROM public.shop_orders
    WHERE status = 'completed' AND admin_cost_at_time IS NOT NULL AND admin_cost_at_time > 0
    AND created_at BETWEEN p_prev_start_date AND p_prev_end_date;

    -- Compute Totals
    v_total_revenue := v_main_revenue + v_shop_revenue;
    v_total_cost := v_main_cost + v_shop_platform_cost;
    v_total_profit := (v_main_revenue - v_main_cost) + (v_shop_revenue - v_shop_platform_cost);
    
    IF v_total_revenue > 0 THEN
        v_profit_margin := ROUND((v_total_profit / v_total_revenue) * 100, 2);
    END IF;

    -- Compute Growth
    DECLARE
        v_prev_total_profit DECIMAL := v_prev_main_profit + v_prev_shop_platform_profit;
    BEGIN
        IF v_prev_total_profit > 0 THEN
            v_growth_pct := ROUND(((v_total_profit - v_prev_total_profit) / v_prev_total_profit) * 100, 2);
        ELSIF v_total_profit > 0 THEN
            v_growth_pct := 100;
        END IF;
    END;

    RETURN jsonb_build_object(
        'summary', jsonb_build_object(
            'total_revenue', v_total_revenue,
            'total_cost', v_total_cost,
            'total_profit', v_total_profit,
            'profit_margin', v_profit_margin,
            'total_orders', v_main_orders + v_shop_orders,
            'excluded_orders', v_main_excluded + v_shop_excluded,
            'growth_percent', v_growth_pct
        ),
        'main_stats', jsonb_build_object(
            'revenue', v_main_revenue,
            'cost', v_main_cost,
            'profit', v_main_revenue - v_main_cost,
            'orders', v_main_orders
        ),
        'shop_stats', jsonb_build_object(
            'revenue', v_shop_revenue,
            'platform_cost', v_shop_platform_cost,
            'platform_profit', v_shop_revenue - v_shop_platform_cost,
            'owner_profit', v_shop_owner_profit_sum,
            'orders', v_shop_orders
        )
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_profit_summary_v2(p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_prev_start_date timestamp with time zone, p_prev_end_date timestamp with time zone, p_product_types text[] DEFAULT NULL::text[], p_network text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_profit_timeseries(p_start_date timestamp with time zone, p_end_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_result JSONB;
BEGIN
    WITH dates AS (
        SELECT generate_series(
            p_start_date::date,
            p_end_date::date,
            '1 day'::interval
        )::date AS day
    ),
    main_daily AS (
        SELECT 
            DATE(created_at) as day,
            SUM(price) as main_rev,
            SUM(price - cost_price_at_time) as main_profit
        FROM public.orders
        WHERE status = 'completed' AND shop_order_id IS NULL AND cost_price_at_time > 0
        AND created_at BETWEEN p_start_date AND p_end_date
        GROUP BY DATE(created_at)
    ),
    shop_daily AS (
        SELECT 
            DATE(created_at) as day,
            SUM(cost_price) as shop_rev,
            SUM(cost_price - admin_cost_at_time) as shop_platform_profit,
            SUM(profit) as shop_owner_profit
        FROM public.shop_orders
        WHERE status = 'completed' AND admin_cost_at_time IS NOT NULL AND admin_cost_at_time > 0
        AND created_at BETWEEN p_start_date AND p_end_date
        GROUP BY DATE(created_at)
    )
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'date', TO_CHAR(d.day, 'YYYY-MM-DD'),
            'main_revenue', COALESCE(m.main_rev, 0),
            'main_profit', COALESCE(m.main_profit, 0),
            'shop_revenue', COALESCE(s.shop_rev, 0),
            'shop_platform_profit', COALESCE(s.shop_platform_profit, 0),
            'shop_owner_profit', COALESCE(s.shop_owner_profit, 0)
        ) ORDER BY d.day ASC
    ), '[]'::jsonb) INTO v_result
    FROM dates d
    LEFT JOIN main_daily m ON m.day = d.day
    LEFT JOIN shop_daily s ON s.day = d.day;

    RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_profit_timeseries_v2(p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_product_types text[] DEFAULT NULL::text[], p_network text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_shop_credit_rollups(p_owner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
    SELECT jsonb_build_object(
        'green_total', COALESCE(SUM(amount) FILTER (WHERE risk_status = 'green'), 0),
        'amber_total', COALESCE(SUM(amount) FILTER (WHERE risk_status = 'amber'), 0),
        'red_total',   COALESCE(SUM(amount) FILTER (WHERE risk_status = 'red'), 0),
        'red_count',   COUNT(*)            FILTER (WHERE risk_status = 'red')
    )
    FROM public.v_shop_profit_credit_reconciliation
    WHERE p_owner_id IS NULL OR owner_id = p_owner_id;
$function$
;

CREATE OR REPLACE FUNCTION public.get_shop_orders_by_phone(p_phone_number text, p_limit_count integer DEFAULT 20, p_shop_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, network text, package_size text, selling_price numeric, status text, created_at timestamp with time zone, guest_phone text, shop_name text, shop_slug text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        so.id,
        so.network,
        so.package_size,
        so.selling_price,
        COALESCE(retry_o.status, orig_o.status, so.status) AS status,
        so.created_at,
        so.guest_phone,
        sp.shop_name,
        sp.shop_slug
    FROM public.shop_orders   so
    JOIN public.shop_profiles sp ON so.shop_id = sp.id
    LEFT JOIN public.orders orig_o ON orig_o.shop_order_id = so.id
    LEFT JOIN LATERAL (
        SELECT o2.status
        FROM public.orders o2
        WHERE o2.retry_of_order_id = orig_o.id
        ORDER BY o2.created_at DESC
        LIMIT 1
    ) retry_o ON true
    WHERE so.guest_phone = p_phone_number
      AND (p_shop_id IS NULL OR so.shop_id = p_shop_id)

    UNION ALL

    SELECT
        ao.id,
        'AFA'::text              AS network,
        'AFA Registration'::text AS package_size,
        ao.selling_price,
        ao.status,
        ao.created_at,
        ao.guest_phone,
        sp2.shop_name,
        sp2.shop_slug
    FROM public.afa_orders ao
    JOIN public.shop_profiles sp2 ON ao.shop_id = sp2.id
    WHERE ao.shop_id IS NOT NULL
      AND ao.guest_phone = p_phone_number
      AND (p_shop_id IS NULL OR ao.shop_id = p_shop_id)

    ORDER BY created_at DESC
    LIMIT p_limit_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_shop_orders_by_phone(phone_number text, limit_count integer DEFAULT 20)
 RETURNS TABLE(id uuid, network text, package_size text, selling_price numeric, status text, created_at timestamp with time zone, guest_phone text, shop_name text, shop_slug text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  select 
    so.id,
    so.network,
    so.package_size,
    so.selling_price,
    so.status,
    so.created_at,
    so.guest_phone,
    sp.shop_name,
    sp.shop_slug
  from shop_orders so
  join shop_profiles sp on so.shop_id = sp.id
  where so.guest_phone = phone_number
  order by so.created_at desc
  limit limit_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_shop_orders_stats(p_shop_id uuid, p_tab text DEFAULT 'all'::text, p_status text DEFAULT NULL::text, p_network text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_count bigint, pending_count bigint, queued_count bigint, processing_count bigint, completed_count bigint, failed_count bigint, refunded_count bigint, revenue numeric, profit numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select
    count(*) as total_count,
    count(*) filter (where v.effective_status = 'pending') as pending_count,
    count(*) filter (where v.effective_status = 'queued') as queued_count,
    count(*) filter (where v.effective_status = 'processing') as processing_count,
    count(*) filter (where v.effective_status = 'completed') as completed_count,
    count(*) filter (where v.effective_status = 'failed') as failed_count,
    count(*) filter (where v.effective_status = 'refunded') as refunded_count,
    coalesce(sum(v.selling_price) filter (
      where v.effective_status in ('pending', 'queued', 'processing', 'completed')
    ), 0) as revenue,
    coalesce(sum(v.profit) filter (
      where v.effective_status in ('pending', 'queued', 'processing', 'completed')
    ), 0) as profit
  from public.shop_orders_effective v
  where v.shop_id = p_shop_id
    and (
      p_tab = 'all'
      or (p_tab = 'data' and v.package_id is not null)
      or (p_tab = 'airtime' and v.package_id is null)
    )
    and (p_status is null or v.effective_status = p_status)
    and (p_network is null or lower(v.network) = lower(p_network))
    and (
      p_source is null
      or (p_source = 'ussd' and v.source in ('ussd', 'ussd_shop'))
      or (p_source = 'storefront' and (v.source is null or v.source not in ('ussd', 'ussd_shop')))
    )
    and (p_search is null or v.guest_phone ilike '%' || p_search || '%')
    and (p_date_from is null or v.created_at >= p_date_from);
$function$
;

CREATE OR REPLACE FUNCTION public.get_shop_owner_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_result JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'owner_id', u.id,
            'owner_name', COALESCE(u.first_name || ' ' || u.last_name, 'Unknown'),
            'shop_name', sp.shop_name,
            'total_sales_count', COALESCE(stats.sales_count, 0),
            'total_sales_value', COALESCE(stats.sales_value, 0),
            'platform_profit', COALESCE(stats.plat_profit, 0),
            'owner_profit', COALESCE(stats.own_profit, 0),
            'wallet_balance', COALESCE(sw.balance, 0)
        ) ORDER BY stats.own_profit DESC NULLS LAST
    ), '[]'::jsonb) INTO v_result
    FROM public.shop_profiles sp
    JOIN public.users u ON u.id = sp.owner_id
    LEFT JOIN public.shop_wallets sw ON sw.owner_id = sp.owner_id
    LEFT JOIN LATERAL (
        SELECT 
            COUNT(id) as sales_count,
            SUM(selling_price) as sales_value,
            SUM(cost_price - admin_cost_at_time) as plat_profit,
            SUM(profit) as own_profit
        FROM public.shop_orders
        WHERE shop_id = sp.id AND status = 'completed' 
          AND admin_cost_at_time IS NOT NULL AND admin_cost_at_time > 0
    ) stats ON true;

    RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_shop_voucher_stats(p_shop_id uuid, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_count bigint, pending_count bigint, processing_count bigint, completed_count bigint, failed_count bigint, refunded_count bigint, revenue numeric, profit numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select
    count(*) as total_count,
    count(*) filter (where r.status = 'pending') as pending_count,
    count(*) filter (where r.status = 'processing') as processing_count,
    count(*) filter (where r.status = 'completed') as completed_count,
    count(*) filter (where r.status = 'failed') as failed_count,
    count(*) filter (where r.status = 'refunded') as refunded_count,
    coalesce(sum(r.unit_price * r.quantity) filter (
      where r.status in ('pending', 'processing', 'completed')
    ), 0) as revenue,
    coalesce(sum(r.shop_markup * r.quantity) filter (
      where r.status in ('pending', 'processing', 'completed')
    ), 0) as profit
  from public.results_checker_orders r
  where r.shop_id = p_shop_id
    and r.payment_status != 'pending_payment'
    and (p_status is null or r.status = p_status)
    and (p_search is null or r.customer_phone ilike '%' || p_search || '%')
    and (p_date_from is null or r.created_at >= p_date_from);
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_dashboard_stats(p_user_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'totalOrders', (SELECT count(*) FROM public.orders WHERE user_id = p_user_id AND shop_order_id IS NULL),
        'completedOrders', (SELECT count(*) FROM public.orders WHERE user_id = p_user_id AND status = 'completed' AND shop_order_id IS NULL),
        'processingOrders', (SELECT count(*) FROM public.orders WHERE user_id = p_user_id AND status = 'processing' AND shop_order_id IS NULL),
        'failedOrders', (SELECT count(*) FROM public.orders WHERE user_id = p_user_id AND status = 'failed' AND shop_order_id IS NULL),
        'pendingOrders', (SELECT count(*) FROM public.orders WHERE user_id = p_user_id AND status = 'pending' AND shop_order_id IS NULL),
        'walletBalance', COALESCE((SELECT balance FROM public.wallets WHERE user_id = p_user_id), 0)
    ) INTO result;
    
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_transactions_with_balance(p_user_id uuid, p_limit integer, p_offset integer, p_source_filter text DEFAULT 'all'::text, p_type_filter text DEFAULT 'all'::text, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, amount numeric, type text, description text, reference text, source text, status text, created_at timestamp with time zone, balance_before numeric, balance_after numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
    -- Ownership guard: reject cross-user snooping by authenticated callers.
    -- Service-role calls (admin routes) have auth.uid() = NULL and are allowed.
    IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'ACCESS_DENIED: You may only view your own transactions';
    END IF;

    RETURN QUERY
    WITH
    all_txns AS (
        SELECT
            t.id,
            t.amount,
            t.type,
            t.description,
            t.reference,
            t.source,
            t.status,
            t.created_at,
            -- Running sum of all *later* transactions (window function, O(n))
            COALESCE(
                SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END)
                    OVER (
                        PARTITION BY t.user_id
                        ORDER BY t.created_at DESC, t.id DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                    ),
                0
            ) AS sum_of_later_txns
        FROM wallet_transactions t
        WHERE t.user_id = p_user_id
          AND (p_source_filter = 'all' OR t.source = p_source_filter)
          AND (p_type_filter   = 'all' OR t.type   = p_type_filter)
          AND (p_start_date IS NULL    OR t.created_at >= p_start_date)
          AND (p_end_date   IS NULL    OR t.created_at <= p_end_date)
    ),
    wallet_bal AS (
        SELECT COALESCE(balance, 0) AS balance
        FROM wallets
        WHERE user_id = p_user_id
    )
    SELECT
        t.id,
        t.amount::DECIMAL,
        t.type::TEXT,
        t.description::TEXT,
        t.reference::TEXT,
        t.source::TEXT,
        t.status::TEXT,
        t.created_at,
        (w.balance
            - t.sum_of_later_txns
            - CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END
        )::DECIMAL AS balance_before,
        (w.balance - t.sum_of_later_txns)::DECIMAL AS balance_after
    FROM all_txns t, wallet_bal w
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT  p_limit
    OFFSET p_offset;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_wallet_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_bal DECIMAL := 0;
    v_user_count INT := 0;
    v_shop_bal DECIMAL := 0;
    v_shop_count INT := 0;
BEGIN
    -- Regular User Wallets (Exclude Admins if preferred, or include all valid users)
    SELECT COALESCE(SUM(w.balance), 0), COUNT(w.id) 
    INTO v_user_bal, v_user_count
    FROM public.wallets w
    JOIN public.users u ON u.id = w.user_id
    WHERE u.role NOT IN ('admin', 'sub-admin') AND w.balance > 0;

    -- Shop Owner Wallets
    SELECT COALESCE(SUM(balance), 0), COUNT(id) 
    INTO v_shop_bal, v_shop_count
    FROM public.shop_wallets
    WHERE balance > 0;

    RETURN jsonb_build_object(
        'total_user_balance', v_user_bal,
        'user_count', v_user_count,
        'total_shop_owner_balance', v_shop_bal,
        'shop_owner_count', v_shop_count
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_wallet_overview_v2()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_wallet_stats(role_filter text DEFAULT 'all'::text)
 RETURNS TABLE(total_balance numeric, total_credited numeric, total_spent numeric, user_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(SUM(w.balance), 0) as total_balance,
    COALESCE(SUM(w.total_credited), 0) as total_credited,
    COALESCE(SUM(w.total_spent), 0) as total_spent,
    COUNT(w.id) as user_count
  FROM wallets w
  JOIN users u ON w.user_id = u.id
  WHERE 
    CASE 
      WHEN role_filter = 'all' THEN true
      ELSE u.role = role_filter
    END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_users_privilege_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if auth.uid() is not null then
    if new.role is distinct from old.role then
      raise exception 'SECURITY: changing account role is not permitted for this session';
    end if;
    if new.agent_expires_at is distinct from old.agent_expires_at
       or new.dealer_expires_at is distinct from old.dealer_expires_at then
      raise exception 'SECURITY: changing reseller expiry is not permitted for this session';
    end if;
    if new.status is distinct from old.status then
      raise exception 'SECURITY: changing account status is not permitted for this session';
    end if;
    if new.pin_hash is distinct from old.pin_hash
       or new.pin_salt is distinct from old.pin_salt
       or new.pin_attempts is distinct from old.pin_attempts
       or new.pin_locked_until is distinct from old.pin_locked_until then
      raise exception 'SECURITY: app-lock PIN can only be changed through the PIN service';
    end if;
    if new.email is distinct from old.email then
      raise exception 'SECURITY: email can only be changed through account support';
    end if;
    if (new.phone_number is distinct from old.phone_number
        or new.phone_verified is distinct from old.phone_verified)
       and old.phone_verified is true then
      raise exception 'SECURITY: a verified phone number can only be changed through the recovery flow';
    end if;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_full_name  text;
  v_first_name text;
  v_last_name  text;
  v_space_pos  int;
BEGIN
  -- Prefer explicit first/last fields (email signup passes these).
  -- Fall back to full_name / name (Google OAuth sends these).
  v_full_name  := COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
      NULLIF(NEW.raw_user_meta_data->>'name',      ''),
      ''
  );

  v_first_name := COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'first_name', ''),
      SPLIT_PART(v_full_name, ' ', 1),
      ''
  );

  -- Everything after the first space becomes last_name.
  v_space_pos  := POSITION(' ' IN v_full_name);
  v_last_name  := COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'last_name', ''),
      CASE WHEN v_space_pos > 0
           THEN SUBSTRING(v_full_name FROM v_space_pos + 1)
           ELSE ''
      END,
      ''
  );

  INSERT INTO public.users (id, email, first_name, last_name, phone_number, role, status)
  VALUES (
      NEW.id,
      NEW.email,
      v_first_name,
      v_last_name,
      -- NULL (not '') when phone absent — avoids UNIQUE constraint violation
      -- for multiple OAuth users who have not provided a phone number yet.
      NULLIF(NEW.raw_user_meta_data->>'phone_number', ''),
      'customer',
      'active'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_ussd_session_step(p_session_id text, p_mobile text, p_operator text, p_platform text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    INSERT INTO public.ussd_sessions (session_id, mobile, operator, platform, steps, updated_at)
    VALUES (p_session_id, p_mobile, p_operator, p_platform, 1, NOW())
    ON CONFLICT (session_id) DO UPDATE
        SET steps = public.ussd_sessions.steps + 1,
            updated_at = NOW();
$function$
;

CREATE OR REPLACE FUNCTION public.increment_wallet_total_credited(p_user_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  UPDATE wallets
  SET
    total_credited = COALESCE(total_credited, 0) + p_amount,
    updated_at = NOW()
  WHERE user_id = p_user_id;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
    AND role IN ('admin', 'sub-admin')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.log_admin_settings_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
    IF NEW.key IN (
        'paystack_fee_percent','agent_paystack_fee_percent','dealer_paystack_fee_percent',
        'paystack_min_topup','paystack_max_topup','mtn_price_adjustment','agent_upgrade_price',
        'auto_fulfillment_enabled','ussd_enabled','phone_verification_enabled','page_access_storefront',
        'data_network_stock'
    ) AND (TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value) THEN
        INSERT INTO public.admin_settings_audit(key, old_value, new_value, changed_by, source)
        VALUES (NEW.key,
                CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END,
                NEW.value, auth.uid(), 'settings');
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_main_profit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Strict checking: ONLY on transition to 'completed' with valid cost constraint
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed')
     AND NEW.cost_price_at_time > 0 AND NEW.shop_order_id IS NULL 
  THEN
    -- Prevent Duplicate Inserts explicitly
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_profit_logs 
      WHERE transaction_type = 'main' AND transaction_id = NEW.id
    ) THEN
        INSERT INTO public.admin_profit_logs (
          transaction_type, transaction_id, channel, role_at_time, 
          selling_price, admin_cost, profit, calculation_note
        ) VALUES (
          'main', NEW.id, 'main', NEW.role_at_time,
          NEW.price, NEW.cost_price_at_time, NEW.price - NEW.cost_price_at_time,
          format('Main order: %s (selling) - %s (cost) = %s %s | role: %s', 
            NEW.price, NEW.cost_price_at_time, NEW.price - NEW.cost_price_at_time,
            CASE WHEN (NEW.price - NEW.cost_price_at_time) < 0 THEN 'LOSS' ELSE 'PROFIT' END,
            COALESCE(NEW.role_at_time, 'unknown'))
        );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_rc_profit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin_selling NUMERIC;
  v_admin_cost    NUMERIC;
BEGIN
  IF NEW.status = 'completed'
    AND (OLD.status IS NULL OR OLD.status <> 'completed')
    AND NEW.cost_price_at_time IS NOT NULL
    AND NEW.cost_price_at_time > 0
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_profit_logs
      WHERE transaction_type = 'results_checker' AND transaction_id = NEW.id
    ) THEN
      v_admin_selling := NEW.total_paid
                         - COALESCE(NEW.shop_markup, 0) * NEW.quantity
                         - COALESCE(NEW.fee_amount, 0);
      v_admin_cost    := NEW.cost_price_at_time * NEW.quantity;

      INSERT INTO public.admin_profit_logs (
        transaction_type, transaction_id, channel, role_at_time,
        selling_price, admin_cost, profit, calculation_note
      ) VALUES (
        'results_checker', NEW.id, 'results_checker', NEW.user_role,
        v_admin_selling, v_admin_cost, v_admin_selling - v_admin_cost,
        format(
          'RC admin profit: %s admin-revenue - %s cost (%sx %s) = %s %s | markup %s, fee %s excluded | ref: %s',
          v_admin_selling, v_admin_cost, NEW.quantity, COALESCE(NEW.type_name, 'unknown'),
          v_admin_selling - v_admin_cost,
          CASE WHEN (v_admin_selling - v_admin_cost) < 0 THEN 'LOSS' ELSE 'PROFIT' END,
          COALESCE(NEW.shop_markup, 0) * NEW.quantity, COALESCE(NEW.fee_amount, 0),
          COALESCE(NEW.reference_code, 'N/A')
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_shop_profit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Strict checking: ONLY on transition to 'completed' with valid admin cost
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed')
     AND NEW.admin_cost_at_time IS NOT NULL AND NEW.admin_cost_at_time > 0 
  THEN
    -- Prevent Duplicate Inserts Explicitly
    IF NOT EXISTS (
       SELECT 1 FROM public.admin_profit_logs 
       WHERE transaction_type = 'shop' AND transaction_id = NEW.id
    ) THEN
        INSERT INTO public.admin_profit_logs (
          transaction_type, transaction_id, channel, role_at_time, 
          amount_paid_to_admin, admin_cost, profit, calculation_note
        ) VALUES (
          'shop', NEW.id, 'shop', NEW.owner_role_at_time,
          NEW.cost_price, NEW.admin_cost_at_time, NEW.cost_price - NEW.admin_cost_at_time,
          format('Shop order: %s (owner paid) - %s (admin cost) = %s %s | role: %s', 
            NEW.cost_price, NEW.admin_cost_at_time, NEW.cost_price - NEW.admin_cost_at_time,
            CASE WHEN (NEW.cost_price - NEW.admin_cost_at_time) < 0 THEN 'LOSS' ELSE 'PROFIT' END,
            COALESCE(NEW.owner_role_at_time, 'unknown'))
        );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_shop_order_refunded(p_shop_order_id uuid, p_actor_id uuid, p_reason text, p_reverse_profit boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_so public.shop_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_so FROM public.shop_orders WHERE id = p_shop_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_so.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_so.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_so.status); END IF;

  IF p_reverse_profit THEN PERFORM public.reverse_shop_profit(p_shop_order_id, p_actor_id, p_reason); END IF;

  UPDATE public.shop_orders SET status='refunded', refund_method='paystack',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason WHERE id = p_shop_order_id;
  UPDATE public.orders SET status='refunded', payment_status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE shop_order_id = p_shop_order_id AND status <> 'refunded';
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE reference_code IN (SELECT reference_code FROM public.orders WHERE shop_order_id = p_shop_order_id)
      AND status <> 'refunded';
  RETURN jsonb_build_object('ok',true,'refunded',true);
END; $function$
;

CREATE OR REPLACE FUNCTION public.normalize_gh_phone(p_phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN d IS NULL THEN NULL
    WHEN length(d) = 12 AND left(d, 3) = '233' THEN '0' || substring(d FROM 4)
    WHEN length(d) = 10 AND left(d, 1) = '0'   THEN d
    ELSE NULL
  END
  FROM (SELECT regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g') AS d) s
$function$
;

CREATE OR REPLACE FUNCTION public.order_has_payment_evidence(p_order orders)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT
        EXISTS (
            SELECT 1 FROM public.wallet_transactions d
             WHERE d.user_id = p_order.user_id
               AND d.type = 'debit'
               AND (   d.reference IN (p_order.reference_code, p_order.id::text,
                                       'USSD-WALLET-' || substr(p_order.reference_code, 6))
                    OR d.reference LIKE 'RETRY-' || p_order.id::text || '%'
                    OR d.description ILIKE '%' || replace(replace(replace(p_order.reference_code, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'))
     OR EXISTS (
            SELECT 1 FROM public.order_retry_attempts a
             WHERE a.new_order_id = p_order.id AND coalesce(a.charged_amount, 0) > 0)
     OR EXISTS (
            SELECT 1 FROM public.ussd_pending_orders u
             WHERE u.hubtel_order_id IS NOT NULL AND u.status = 'fulfilled'
               AND ('USSD-DATA-' || upper(replace(u.session_id, '-', ''))) = p_order.reference_code);
$function$
;

CREATE OR REPLACE FUNCTION public.process_afa_order(p_user_id uuid, p_amount numeric, p_form_data jsonb, p_reference_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id      UUID;
    v_wallet_balance NUMERIC;
    v_new_balance    NUMERIC;
    v_transaction_id UUID;
    v_order_id       UUID;
BEGIN
    SELECT id, balance
        INTO v_wallet_id, v_wallet_balance
        FROM public.wallets
        WHERE user_id = p_user_id
        FOR UPDATE;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    IF v_wallet_balance < p_amount THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    UPDATE public.wallets
        SET
            balance     = balance - p_amount,
            total_spent = COALESCE(total_spent, 0) + p_amount,
            updated_at  = NOW()
        WHERE id = v_wallet_id
        RETURNING balance INTO v_new_balance;

    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount, description,
        reference, source, status, metadata
    ) VALUES (
        v_wallet_id, p_user_id, 'debit', p_amount,
        'MTN AFA Registration Fee',
        p_reference_code, 'purchase', 'completed',
        jsonb_build_object('category', 'afa_order', 'source', 'afa_registration')
    )
    RETURNING id INTO v_transaction_id;

    INSERT INTO public.afa_orders (
        user_id, full_name, phone, ghana_card, id_type, id_number,
        location, region, occupation, date_of_birth, notes, status,
        payment_amount, payment_method, reference_code, transaction_id
    ) VALUES (
        p_user_id,
        p_form_data->>'full_name',
        p_form_data->>'phone',
        p_form_data->>'id_number',
        'Ghana Card',
        p_form_data->>'id_number',
        p_form_data->>'location',
        p_form_data->>'region',
        'Farmer',
        (p_form_data->>'date_of_birth')::DATE,
        p_form_data->>'notes',
        'pending',
        p_amount,
        'wallet',
        p_reference_code,
        v_transaction_id
    )
    RETURNING id INTO v_order_id;

    RETURN json_build_object(
        'order_id',       v_order_id,
        'transaction_id', v_transaction_id,
        'new_balance',    v_new_balance
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.process_commission_withdrawal(p_wallet_id uuid, p_amount numeric, p_fee numeric, p_net_amount numeric, p_account_name text, p_momo_number text, p_network text, p_description text, p_owner_id uuid, p_name_verified boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wallet record; v_tx_id uuid;
BEGIN
  SELECT * INTO v_wallet FROM public.commission_wallets
   WHERE id = p_wallet_id AND owner_id = COALESCE(auth.uid(), p_owner_id) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_net_amount IS NULL OR p_net_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF p_fee IS NULL OR p_fee < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF round(p_amount - p_fee, 2) <> round(p_net_amount, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF v_wallet.balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance');
  END IF;

  UPDATE public.commission_wallets
     SET balance = balance - p_amount, total_withdrawn = COALESCE(total_withdrawn, 0) + p_amount, updated_at = now()
   WHERE id = p_wallet_id;
  INSERT INTO public.commission_wallet_transactions
    (commission_wallet_id, type, amount, fee, net_amount, description, status, momo_number, network, account_name, name_verified)
  VALUES (p_wallet_id, 'withdrawal', p_amount, p_fee, p_net_amount, p_description, 'pending', p_momo_number, p_network, p_account_name, p_name_verified)
  RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object('success', true, 'transaction_id', v_tx_id, 'net_amount', p_net_amount, 'fee', p_fee);
END $function$
;

CREATE OR REPLACE FUNCTION public.process_shop_withdrawal(p_wallet_id uuid, p_amount numeric, p_fee numeric, p_net_amount numeric, p_account_name text, p_momo_number text, p_account_number text, p_network text, p_payment_type text, p_bank_id text, p_bank_name text, p_branch text, p_description text, p_owner_id uuid DEFAULT NULL::uuid, p_name_verified boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_wallet_owner_id UUID; v_caller UUID; v_current_balance NUMERIC; v_new_balance NUMERIC;
    v_tx_id UUID; v_owner_role TEXT; v_pct NUMERIC; v_flat NUMERIC; v_computed_fee NUMERIC;
    v_fee NUMERIC; v_net NUMERIC;
BEGIN
    IF p_amount <= 0 THEN RAISE EXCEPTION 'Withdrawal amount must be greater than zero'; END IF;
    SELECT owner_id, balance INTO v_wallet_owner_id, v_current_balance
    FROM shop_wallets WHERE id = p_wallet_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
    v_caller := COALESCE(auth.uid(), p_owner_id);
    IF v_caller IS NULL OR v_caller <> v_wallet_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet'; END IF;
    IF v_current_balance < p_amount THEN RAISE EXCEPTION 'Insufficient shop wallet balance'; END IF;
    SELECT role INTO v_owner_role FROM users WHERE id = v_wallet_owner_id;
    v_owner_role := COALESCE(v_owner_role, 'customer');
    SELECT withdrawal_fee_percent, withdrawal_fee_flat INTO v_pct, v_flat
    FROM shop_profiles WHERE owner_id = v_wallet_owner_id;
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent_' || v_owner_role; END IF;
    IF v_pct IS NULL AND v_owner_role = 'subagent' THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent_customer'; END IF;
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent'; END IF;
    IF v_pct IS NULL THEN v_pct := 2; END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat_' || v_owner_role; END IF;
    IF v_flat IS NULL AND v_owner_role = 'subagent' THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat_customer'; END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat'; END IF;
    IF v_flat IS NULL THEN v_flat := 0; END IF;
    v_computed_fee := (p_amount * v_pct / 100.0) + v_flat;
    v_fee := GREATEST(COALESCE(p_fee, 0), v_computed_fee);
    v_net := p_amount - v_fee;
    IF v_net <= 0 THEN RAISE EXCEPTION 'Withdrawal amount too low to cover the processing fee'; END IF;

    v_new_balance := v_current_balance - p_amount;
    UPDATE shop_wallets
    SET balance = v_new_balance, total_withdrawn = COALESCE(total_withdrawn, 0) + p_amount, updated_at = NOW()
    WHERE id = p_wallet_id;
    INSERT INTO shop_wallet_transactions (
        shop_wallet_id, type, amount, fee, net_amount, account_name, momo_number,
        account_number, network, payment_type, bank_id, bank_name, branch,
        description, status, balance_snapshot, name_verified, sub_approval_status, escalate_after
    ) VALUES (
        p_wallet_id, 'withdrawal', p_amount, v_fee, v_net, p_account_name, p_momo_number,
        p_account_number, p_network, p_payment_type, p_bank_id, p_bank_name, p_branch,
        p_description, 'pending', v_new_balance, p_name_verified, 'not_required', NULL
    ) RETURNING id INTO v_tx_id;
    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'fee', v_fee,
        'netAmount', v_net, 'transactionId', v_tx_id, 'subOwnerPending', false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.process_ussd_wallet_payment(p_user_id uuid, p_amount numeric, p_description text, p_reference text)
 RETURNS TABLE(wallet_id uuid, new_balance numeric, already_processed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id uuid;
    v_new_balance numeric;
BEGIN
    INSERT INTO public.wallet_transactions
        (wallet_id, user_id, type, amount, description, reference, source, status)
    SELECT w.id, p_user_id, 'debit', p_amount, p_description, p_reference, 'ussd', 'pending'
    FROM public.wallets w
    WHERE w.user_id = p_user_id
    ON CONFLICT (reference) WHERE source = 'ussd' DO NOTHING
    RETURNING public.wallet_transactions.wallet_id INTO v_wallet_id;

    IF v_wallet_id IS NULL THEN
        SELECT wt.wallet_id, w.balance INTO v_wallet_id, v_new_balance
        FROM public.wallet_transactions wt
        JOIN public.wallets w ON w.id = wt.wallet_id
        WHERE wt.reference = p_reference AND wt.source = 'ussd';

        IF v_wallet_id IS NULL THEN
            RAISE EXCEPTION 'WALLET_NOT_FOUND';
        END IF;

        RETURN QUERY SELECT v_wallet_id, v_new_balance, true;
        RETURN;
    END IF;

    UPDATE public.wallets
    SET balance     = balance - p_amount,
        total_spent = COALESCE(total_spent, 0) + p_amount,
        updated_at  = NOW()
    WHERE id = v_wallet_id
      AND balance >= p_amount
    RETURNING balance INTO v_new_balance;

    IF v_new_balance IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    UPDATE public.wallet_transactions
    SET status = 'completed'
    WHERE public.wallet_transactions.wallet_id = v_wallet_id
      AND public.wallet_transactions.reference = p_reference
      AND public.wallet_transactions.source = 'ussd';

    RETURN QUERY SELECT v_wallet_id, v_new_balance, false;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_shop_admin_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only enforce restriction for standard authenticated users (shop owners).
  -- Server-side calls using the service role bypass RLS entirely and
  -- are NOT subject to this trigger guard (auth.role() will be null or 'service_role').
  IF auth.role() = 'authenticated' THEN
    -- Force sensitive admin-only columns to remain unchanged
    NEW.paystack_fee_percent      := OLD.paystack_fee_percent;
    NEW.withdrawal_fee_percent    := OLD.withdrawal_fee_percent;
    NEW.withdrawal_fee_flat       := OLD.withdrawal_fee_flat;
    NEW.min_withdrawal_amount     := OLD.min_withdrawal_amount;
    NEW.approval_status           := OLD.approval_status;
    NEW.fulfillment_mode          := OLD.fulfillment_mode;
    NEW.is_active                 := OLD.is_active;
    NEW.approved_by               := OLD.approved_by;
    NEW.approved_at               := OLD.approved_at;
    -- utilities_enabled is money-eligibility state: app/api/shop/utility-settings/route.ts
    -- gates enabling it behind an agent/dealer role check, and credit_utility_commission's
    -- shop_id branch pays commission with NO role re-check on the strength of that gate.
    -- Without pinning it here, an authenticated owner could PATCH shop_profiles directly
    -- via the REST API and self-enable, bypassing the role gate entirely. The legitimate
    -- write goes through the service-role client, which this guard does not apply to.
    NEW.utilities_enabled         := OLD.utilities_enabled;
    -- Owner pricing: only app/api/shop/pricing/route.ts (service role) may change these —
    -- it clamps negatives and enforces the fee caps; a direct write could do neither.
    NEW.airtime_fee_mtn                   := OLD.airtime_fee_mtn;
    NEW.airtime_fee_telecel               := OLD.airtime_fee_telecel;
    NEW.airtime_fee_at                    := OLD.airtime_fee_at;
    NEW.mashup_fee_percent                := OLD.mashup_fee_percent;
    NEW.results_checker_markup_customer   := OLD.results_checker_markup_customer;
    NEW.results_checker_markup_agent      := OLD.results_checker_markup_agent;
    NEW.results_checker_markup_dealer     := OLD.results_checker_markup_dealer;
    NEW.afa_fee_percent                   := OLD.afa_fee_percent;
    NEW.afa_selling_price                 := OLD.afa_selling_price;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_shop_pricing_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    -- Lock profit_margin from ever being changed after creation
    IF NEW.profit_margin != OLD.profit_margin THEN
        RAISE EXCEPTION 'profit_margin cannot be changed after creation';
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_terms_version(p_version text, p_effective_date date, p_sections jsonb, p_changelog jsonb, p_requires boolean, p_created_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.terms_versions SET is_current = false WHERE is_current = true;

  INSERT INTO public.terms_versions
    (version, effective_date, sections, changelog, requires_reacceptance, is_current, created_by, published_at)
  VALUES
    (p_version, p_effective_date, p_sections, p_changelog, p_requires, true, p_created_by, now())
  ON CONFLICT (version) DO UPDATE SET
    effective_date        = EXCLUDED.effective_date,
    sections              = EXCLUDED.sections,
    changelog             = EXCLUDED.changelog,
    requires_reacceptance = EXCLUDED.requires_reacceptance,
    is_current            = true,
    created_by            = EXCLUDED.created_by,
    published_at          = now();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purchase_sms_bundle(p_owner_id uuid, p_bundle_id uuid, p_paid_from text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop_id     UUID;
    v_credits     INTEGER;
    v_price       NUMERIC;
    v_rows        INTEGER;
    v_purchase_id UUID;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'profit') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT id INTO v_shop_id FROM shop_profiles WHERE owner_id = p_owner_id;
    IF v_shop_id IS NULL THEN
        RAISE EXCEPTION 'SHOP_NOT_FOUND';
    END IF;

    -- Must be activated first — server-side enforcement, not just UI
    IF NOT EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = v_shop_id) THEN
        RAISE EXCEPTION 'NOT_ACTIVATED';
    END IF;

    -- Price/credits come from the admin-configured bundle row only
    SELECT credits, price INTO v_credits, v_price
    FROM shop_sms_bundles
    WHERE id = p_bundle_id AND is_active = true;
    IF v_credits IS NULL THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    -- Atomic debit
    IF p_paid_from = 'wallet' THEN
        UPDATE wallets
        SET balance = balance - v_price,
            total_spent = COALESCE(total_spent, 0) + v_price,
            updated_at = now()
        WHERE user_id = p_owner_id AND balance >= v_price;
    ELSE
        UPDATE shop_wallets
        SET balance = balance - v_price,
            updated_at = now()
        WHERE owner_id = p_owner_id AND balance >= v_price;
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- Credit the SMS wallet
    INSERT INTO shop_sms_wallets (shop_id, credits, total_purchased)
    VALUES (v_shop_id, v_credits, v_credits)
    ON CONFLICT (shop_id) DO UPDATE SET
        credits         = shop_sms_wallets.credits + v_credits,
        total_purchased = shop_sms_wallets.total_purchased + v_credits,
        updated_at      = now();

    INSERT INTO shop_sms_purchases (shop_id, owner_id, bundle_id, credits, price, paid_from)
    VALUES (v_shop_id, p_owner_id, p_bundle_id, v_credits, v_price, p_paid_from)
    RETURNING id INTO v_purchase_id;

    IF p_paid_from = 'wallet' THEN
        INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
        SELECT id, p_owner_id, 'debit', v_price, 'SMS bundle: ' || v_credits || ' credits',
               'SHOPSMS-' || v_purchase_id::text, 'purchase', 'completed'
        FROM wallets WHERE user_id = p_owner_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'credits_added', v_credits, 'price', v_price);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purchase_user_sms_credits(p_user_id uuid, p_bundle_id uuid, p_paid_from text, p_payment_reference text DEFAULT NULL::text, p_verified_amount numeric DEFAULT NULL::numeric, p_client_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_acct        RECORD;
    v_bundle      RECORD;
    v_price       NUMERIC(10,2);
    v_key         TEXT;
    v_ledger_id   UUID;
    v_balance     INTEGER;
    v_purchase_id UUID;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'momo') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT a.*, w.credits AS wallet_credits
    INTO v_acct
    FROM sms_accounts a
    JOIN sms_wallets w ON w.account_id = a.id
    WHERE a.user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
    END IF;
    IF v_acct.status <> 'active' THEN
        RAISE EXCEPTION 'ACCOUNT_SUSPENDED';
    END IF;

    SELECT * INTO v_bundle FROM sms_bundles
    WHERE id = p_bundle_id AND is_active = true;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    -- v2 GUARD: a bundle can only be bought by an account in its own mode
    -- (or a 'both'-mode bundle, purchasable from either mode).
    IF v_bundle.mode <> 'both' AND v_bundle.mode <> v_acct.mode THEN
        RAISE EXCEPTION 'BUNDLE_MODE_MISMATCH';
    END IF;

    v_price := v_bundle.price;   -- v2: business_price no longer consulted

    IF p_paid_from = 'momo' THEN
        IF p_payment_reference IS NULL OR length(trim(p_payment_reference)) < 6 THEN
            RAISE EXCEPTION 'MISSING_PAYMENT_REFERENCE';
        END IF;
        IF p_verified_amount IS NULL OR p_verified_amount <> v_price THEN
            RAISE EXCEPTION 'AMOUNT_MISMATCH';
        END IF;
        v_key := 'purchase:' || p_payment_reference;
    ELSE
        IF p_client_key IS NULL OR length(trim(p_client_key)) < 8 THEN
            RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
        END IF;
        v_key := 'purchase:' || p_client_key;
    END IF;

    -- Reserve the ledger key BEFORE moving any money.
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (v_acct.id, v_bundle.credits, 'purchase', v_key, p_payment_reference)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    IF p_paid_from = 'wallet' THEN
        PERFORM deduct_wallet_balance(p_user_id, v_price);
    END IF;

    UPDATE sms_wallets
    SET credits         = credits + v_bundle.credits,
        total_purchased = total_purchased + v_bundle.credits,
        updated_at      = now()
    WHERE account_id = v_acct.id
    RETURNING credits INTO v_balance;

    UPDATE sms_credit_ledger SET balance_after = v_balance WHERE id = v_ledger_id;

    INSERT INTO sms_purchases (account_id, user_id, bundle_id, credits, price, paid_from, payment_reference)
    VALUES (v_acct.id, p_user_id, p_bundle_id, v_bundle.credits, v_price, p_paid_from, p_payment_reference)
    RETURNING id INTO v_purchase_id;

    IF p_paid_from = 'wallet' THEN
        INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
        SELECT id, p_user_id, 'debit', v_price, 'SMS credits: ' || v_bundle.credits,
               'SMSCRED-' || v_purchase_id::text, 'purchase', 'completed'
        FROM wallets WHERE user_id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'already_processed', false,
        'credits_added', v_bundle.credits,
        'price', v_price,
        'balance', v_balance
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_old_sms_messages(p_months integer DEFAULT 12, p_limit integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_count INTEGER;
BEGIN
    DELETE FROM sms_messages
    WHERE id IN (
        SELECT id FROM sms_messages
        WHERE created_at < now() - make_interval(months => GREATEST(1, p_months))
        LIMIT GREATEST(1, LEAST(p_limit, 20000))
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_phone_recovery_attempt(p_user_id uuid, p_correct boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.phone_recovery_attempts;
  v_now timestamptz := now();
  v_count integer;
  v_locked_until timestamptz;
begin
  insert into public.phone_recovery_attempts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_row
  from public.phone_recovery_attempts
  where user_id = p_user_id
  for update;

  if v_now - v_row.window_started_at > interval '1 hour' then
    v_row.attempt_count := 0;
    v_row.window_started_at := v_now;
    v_row.locked_until := null;
    v_row.hard_locked := false;
  end if;

  if v_row.hard_locked then
    update public.phone_recovery_attempts
    set window_started_at = v_row.window_started_at, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'hard_locked');
  end if;

  if v_row.locked_until is not null and v_now < v_row.locked_until then
    update public.phone_recovery_attempts
    set window_started_at = v_row.window_started_at, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'locked', 'retry_at', v_row.locked_until);
  end if;

  if p_correct then
    update public.phone_recovery_attempts
    set attempt_count = 0, window_started_at = v_now, locked_until = null,
        hard_locked = false, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'ok');
  end if;

  v_count := v_row.attempt_count + 1;

  if v_count = 3 then
    v_locked_until := v_now + interval '1 minute';
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at,
        locked_until = v_locked_until, hard_locked = false, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'locked', 'retry_at', v_locked_until);
  elsif v_count = 6 then
    v_locked_until := v_now + interval '2 minutes';
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at,
        locked_until = v_locked_until, hard_locked = false, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'locked', 'retry_at', v_locked_until);
  elsif v_count >= 9 then
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at,
        locked_until = null, hard_locked = true, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'hard_locked');
  else
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'wrong', 'attempt_count', v_count);
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.redeem_sub_invite(p_code text, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invite     public.shop_invites%ROWTYPE;
  v_existing   public.sub_agents%ROWTYPE;
  v_has_shop   boolean;
  v_inviter    uuid;
  v_inviter_sa public.sub_agents%ROWTYPE;
  v_depth      integer;
BEGIN
  IF p_code IS NULL OR length(btrim(p_code)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_user');
  END IF;

  SELECT * INTO v_existing FROM public.sub_agents WHERE user_id = p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_member', true,
      'status', v_existing.status, 'upline_shop_id', v_existing.upline_shop_id);
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.shop_profiles WHERE owner_id = p_user_id) INTO v_has_shop;
  IF v_has_shop THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_shop_owner');
  END IF;

  SELECT * INTO v_invite FROM public.shop_invites WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'invite_not_found'); END IF;
  IF v_invite.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invite_revoked'); END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invite_expired'); END IF;
  IF v_invite.max_uses IS NOT NULL AND v_invite.used_count >= v_invite.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invite_exhausted'); END IF;

  SELECT owner_id INTO v_inviter FROM public.shop_profiles WHERE id = v_invite.shop_id;
  IF v_inviter IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'upline_missing');
  END IF;
  IF v_inviter = p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_self_recruit');
  END IF;

  v_depth := public.sub_chain_depth_above(v_invite.shop_id);
  IF v_depth >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'max_depth_reached');
  END IF;

  SELECT * INTO v_inviter_sa FROM public.sub_agents WHERE user_id = v_inviter;
  IF FOUND THEN
    IF v_inviter_sa.status <> 'active' OR NOT v_inviter_sa.may_recruit THEN
      RETURN jsonb_build_object('ok', false, 'error', 'inviter_cannot_recruit');
    END IF;
  END IF;

  INSERT INTO public.sub_agents (user_id, upline_shop_id, status, joined_via_invite)
    VALUES (p_user_id, v_invite.shop_id, 'pending', v_invite.id);
  UPDATE public.shop_invites SET used_count = used_count + 1 WHERE id = v_invite.id;

  RETURN jsonb_build_object('ok', true, 'created', true, 'status', 'pending', 'upline_shop_id', v_invite.shop_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', true, 'already_member', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_afa_order_wallet(p_afa_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ao public.afa_orders%ROWTYPE;
  v_wallet_id uuid;
  v_ref text;
  v_amount numeric;
BEGIN
  SELECT * INTO v_ao FROM public.afa_orders WHERE id = p_afa_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'order_not_found'); END IF;
  IF v_ao.status = 'refunded' THEN RETURN jsonb_build_object('ok', true, 'already_refunded', true); END IF;
  IF v_ao.status NOT IN ('pending', 'processing', 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refundable', 'status', v_ao.status); END IF;
  IF v_ao.shop_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shop_linked_use_owner_wallet'); END IF;
  IF v_ao.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_wallet_user'); END IF;
  IF COALESCE(v_ao.payment_method, 'momo') <> 'wallet' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_wallet_paid'); END IF;

  -- cost_price is only populated on shop/ussd_shop rows; dashboard/API/USSD
  -- wallet-debited rows record the debited amount in payment_amount instead.
  v_amount := COALESCE(v_ao.cost_price, v_ao.payment_amount);
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_amount_to_refund'); END IF;

  v_ref := 'REFUND-AFA-WALLET-' || p_afa_order_id::text;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_ao.user_id FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance) VALUES (v_ao.user_id, 0) RETURNING id INTO v_wallet_id;
  END IF;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_ao.user_id, 'credit', v_amount,
            'Refund for AFA registration ' || p_afa_order_id::text, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_amount,
         total_spent = GREATEST(0, total_spent - v_amount) WHERE id = v_wallet_id;

  UPDATE public.afa_orders SET status = 'refunded', refund_method = 'wallet',
         refunded_by = p_actor_id, refunded_at = now(), refund_reason = p_reason, updated_at = now()
    WHERE id = p_afa_order_id;

  RETURN jsonb_build_object('ok', true, 'refunded', true, 'amount', v_amount);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok', true, 'already_refunded', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_airtime_wallet(p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_o public.airtime_orders%ROWTYPE; v_ref text; v_wallet_id uuid; v_new_balance numeric;
BEGIN
  SELECT * INTO v_o FROM public.airtime_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
  IF v_o.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_o.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status); END IF;
  IF v_o.user_id IS NULL OR v_o.shop_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','not_retail_airtime'); END IF;

  v_ref := 'REFUND-AIRTIME-' || p_order_id::text;
  INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.total_paid,
            'Refund for airtime order ' || v_o.reference_code, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_o.total_paid,
         total_spent = GREATEST(0, total_spent - v_o.total_paid) WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE id = p_order_id;
  RETURN jsonb_build_object('ok',true,'refunded',true,'amount',v_o.total_paid,'new_balance',v_new_balance);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok',true,'already_refunded',true);
END $function$
;

CREATE OR REPLACE FUNCTION public.refund_order_wallet(p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_o public.orders%ROWTYPE;
    v_ref text;
    v_wallet_id uuid;
BEGIN
    SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
    IF v_o.payment_status = 'refunded' OR v_o.status = 'refunded' THEN
        RETURN jsonb_build_object('ok',true,'already_refunded',true);
    END IF;
    IF v_o.status NOT IN ('pending','processing','failed') THEN
        RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status);
    END IF;
    IF v_o.user_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','no_wallet_user'); END IF;

    v_ref := 'REFUND-ORDER-' || p_order_id::text;
    SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;
    IF v_wallet_id IS NULL THEN
        INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0) RETURNING id INTO v_wallet_id;
    END IF;

    INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.price, 'Refund for order ' || v_o.reference_code, v_ref, 'refund', 'completed');
    UPDATE public.wallets SET balance = balance + v_o.price, total_spent = GREATEST(0, total_spent - v_o.price) WHERE id = v_wallet_id;
    UPDATE public.orders SET status='refunded', payment_status='refunded', refunded_by=p_actor_id,
        refunded_at=now(), refund_reason=p_reason, updated_at=now() WHERE id = p_order_id;

    BEGIN
        IF NOT public.order_has_payment_evidence(v_o) THEN
            INSERT INTO public.security_events (event_type, reference, expected_amount, order_type, detail)
            VALUES ('refund_without_payment_trace', v_o.reference_code, v_o.price, 'data',
                    jsonb_build_object('order_id', v_o.id, 'user_id', v_o.user_id, 'source', v_o.source,
                                       'payment_method', v_o.payment_method, 'refunded_by', p_actor_id,
                                       'refund_reference', v_ref));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object('ok',true,'refunded',true,'amount',v_o.price);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok',true,'already_refunded',true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_shop_withdrawal(p_tx_id uuid, p_admin_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_wallet_id UUID;
    v_amount NUMERIC;
    v_status TEXT;
    v_type TEXT;
    v_new_balance NUMERIC;
BEGIN
    SELECT shop_wallet_id, amount, status, type
      INTO v_wallet_id, v_amount, v_status, v_type
    FROM shop_wallet_transactions
    WHERE id = p_tx_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Withdrawal transaction not found';
    END IF;
    IF v_type <> 'withdrawal' THEN
        RAISE EXCEPTION 'Not a withdrawal transaction';
    END IF;

    IF v_status = 'reversed' THEN
        RETURN jsonb_build_object('success', true, 'alreadyRefunded', true);
    END IF;
    IF v_status NOT IN ('pending', 'failed') THEN
        RAISE EXCEPTION 'Cannot refund a payout in status % — only pending or failed withdrawals are refundable', v_status;
    END IF;

    UPDATE shop_wallets
    SET balance = balance + v_amount,
        total_withdrawn = GREATEST(COALESCE(total_withdrawn, 0) - v_amount, 0),
        updated_at = NOW()
    WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    UPDATE shop_wallet_transactions
    SET status = 'reversed',
        failure_reason = LEFT(COALESCE(p_reason, 'Refunded by admin'), 500),
        processed_by = p_admin_id,
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_tx_id;

    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'refunded', v_amount);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_sms_credits(p_shop_id uuid, p_credits integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE shop_sms_wallets
    SET credits    = credits + p_credits,
        total_used = GREATEST(0, total_used - p_credits),
        updated_at = now()
    WHERE shop_id = p_shop_id;

    RETURN jsonb_build_object('success', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_ussd_wallet(p_user_id uuid, p_amount numeric, p_reference text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id   UUID;
    v_new_balance NUMERIC;
BEGIN
    SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.wallet_transactions
        WHERE reference = p_reference AND source = 'refund'
    ) THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    INSERT INTO public.wallet_transactions
        (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES
        (v_wallet_id, p_user_id, 'credit', p_amount, p_description, p_reference, 'refund', 'completed');

    UPDATE public.wallets
        SET balance        = balance + p_amount,
            total_credited = COALESCE(total_credited, 0) + p_amount,
            updated_at     = NOW()
        WHERE id = v_wallet_id
        RETURNING balance INTO v_new_balance;

    RETURN jsonb_build_object('already_processed', false, 'new_balance', v_new_balance);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_utility_wallet(p_utility_order_id uuid, p_actor_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_order record; v_ref text; v_wallet_id uuid; v_new_balance numeric;
BEGIN
  UPDATE public.utility_orders
     SET status = 'refunded', payment_status = 'refunded',
         refunded_by = p_actor_id, refunded_at = now(), refund_reason = p_reason,
         updated_at = now()
   WHERE id = p_utility_order_id
     AND payment_method IN ('wallet','ussd_wallet','ussd_momo')
     AND shop_id IS NULL
     AND status IN ('pending','failed')
     AND payment_status = 'paid'
     AND user_id IS NOT NULL
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    SELECT * INTO v_order FROM public.utility_orders WHERE id = p_utility_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
    END IF;
    IF v_order.status = 'refunded' OR v_order.payment_status = 'refunded' THEN
      RETURN jsonb_build_object('success', true, 'already_refunded', true);
    END IF;
    IF v_order.user_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'No wallet owner');
    END IF;
    IF v_order.shop_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_wallet_payment');
    END IF;
    IF v_order.payment_method NOT IN ('wallet','ussd_wallet','ussd_momo') THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_wallet_payment');
    END IF;
    IF v_order.payment_status <> 'paid' THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_paid', 'payment_status', v_order.payment_status);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'not_refundable', 'status', v_order.status);
  END IF;

  v_ref := 'REFUND-' || v_order.reference_code;

  INSERT INTO public.wallets (user_id, balance) VALUES (v_order.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_order.user_id FOR UPDATE;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_order.user_id, 'credit', v_order.amount,
            'Refund for utility order ' || v_order.reference_code, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_order.amount,
         total_spent = GREATEST(0, total_spent - v_order.amount) WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

  RETURN jsonb_build_object('success', true, 'refunded', true, 'amount', v_order.amount, 'new_balance', v_new_balance);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', true, 'already_refunded', true);
END $function$
;

CREATE OR REPLACE FUNCTION public.register_numbers_manual(p_phones text[], p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_canon   text[];
  v_orders  integer := 0;
  v_shop    integer := 0;
BEGIN
  SELECT array_agg(DISTINCT n) INTO v_canon
  FROM (SELECT public.normalize_gh_phone(x) AS n FROM unnest(p_phones) AS x) s
  WHERE n IS NOT NULL;

  IF v_canon IS NULL OR array_length(v_canon, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_valid_phones');
  END IF;

  INSERT INTO public.number_registrations (phone_number, network, status, source, registered_at)
  SELECT p, 'MTN', 'registered', 'admin', now() FROM unnest(v_canon) AS p
  ON CONFLICT (phone_number) DO UPDATE
    SET status = 'registered', registered_at = now();

  UPDATE public.orders o
     SET status = 'pending', updated_at = now()
   WHERE o.status = 'queued'
     AND public.normalize_gh_phone(o.phone_number) = ANY (v_canon);
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  UPDATE public.shop_orders so
     SET status = 'pending', updated_at = now()
   WHERE so.status = 'queued'
     AND public.normalize_gh_phone(so.guest_phone) = ANY (v_canon);
  GET DIAGNOSTICS v_shop = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'registered', array_length(v_canon, 1), 'released_orders', v_orders, 'released_shop_orders', v_shop);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_commission_withdrawal(p_transaction_id uuid, p_admin_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_tx record;
BEGIN
  UPDATE public.commission_wallet_transactions
     SET status = 'failed', admin_note = p_note, processed_by = p_admin_id, processed_at = now(), updated_at = now()
   WHERE id = p_transaction_id AND type = 'withdrawal' AND status = 'pending'
  RETURNING * INTO v_tx;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_pending');
  END IF;

  UPDATE public.commission_wallets
     SET balance = balance + v_tx.amount, total_withdrawn = GREATEST(0, COALESCE(total_withdrawn, 0) - v_tx.amount), updated_at = now()
   WHERE id = v_tx.commission_wallet_id;
  INSERT INTO public.commission_wallet_transactions (commission_wallet_id, type, amount, description, status)
  VALUES (v_tx.commission_wallet_id, 'withdrawal_reversal', v_tx.amount, 'Withdrawal rejected: ' || COALESCE(p_note, ''), 'completed');

  RETURN jsonb_build_object('success', true, 'refunded', v_tx.amount);
END $function$
;

CREATE OR REPLACE FUNCTION public.release_expired_rc_reservations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.results_checker_inventory inv
  SET status = 'available', reserved_by_order = NULL, reservation_expires_at = NULL, updated_at = NOW()
  WHERE inv.status = 'reserved'
    AND inv.reservation_expires_at < NOW()
    AND NOT EXISTS (
      SELECT 1 FROM public.results_checker_orders o
      WHERE o.id = inv.reserved_by_order
        AND o.payment_status = 'completed'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.release_registration_batch(p_batch_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_batch   public.number_registration_batches%ROWTYPE;
  v_orders  integer := 0;
  v_shop    integer := 0;
BEGIN
  SELECT * INTO v_batch FROM public.number_registration_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'batch_not_found');
  END IF;

  UPDATE public.number_registration_batches
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = p_actor_id
   WHERE id = p_batch_id;

  UPDATE public.number_registrations
     SET status = 'registered', registered_at = now()
   WHERE batch_id = p_batch_id AND status <> 'registered';

  UPDATE public.orders o
     SET status = 'pending', updated_at = now()
   WHERE o.status = 'queued'
     AND public.normalize_gh_phone(o.phone_number) IN (
       SELECT phone_number FROM public.number_registrations WHERE batch_id = p_batch_id
     );
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  UPDATE public.shop_orders so
     SET status = 'pending', updated_at = now()
   WHERE so.status = 'queued'
     AND public.normalize_gh_phone(so.guest_phone) IN (
       SELECT phone_number FROM public.number_registrations WHERE batch_id = p_batch_id
     );
  GET DIAGNOSTICS v_shop = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'released_orders', v_orders, 'released_shop_orders', v_shop);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_sub_withdrawal(p_actor_id uuid, p_tx_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx public.shop_wallet_transactions%ROWTYPE;
  v_owner uuid; v_upline uuid; v_lead uuid; v_lead_eligible boolean;
BEGIN
  SELECT * INTO v_tx FROM public.shop_wallet_transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'withdrawal' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_tx.status <> 'shop_owner_pending' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending_owner'); END IF;
  SELECT sw.owner_id INTO v_owner FROM public.shop_wallets sw WHERE sw.id = v_tx.shop_wallet_id;
  SELECT sa.upline_shop_id INTO v_upline FROM public.sub_agents sa WHERE sa.user_id = v_owner;
  SELECT owner_id INTO v_lead FROM public.shop_profiles WHERE id = v_upline;
  IF v_lead IS NULL OR v_lead <> p_actor_id THEN RETURN jsonb_build_object('ok', false, 'error', 'not_your_sub'); END IF;

  -- Lead must still be eligible to exercise approval authority. A suspended /
  -- rejected shop, or a Lead who is no longer a lifetime agent or active dealer,
  -- has no say — the row auto-escalates to admin via the escalation cron.
  SELECT COALESCE(
      (lu.role = 'agent'  AND lu.agent_expires_at IS NULL)
   OR (lu.role = 'dealer' AND lu.dealer_expires_at > now()), false)
  INTO v_lead_eligible
  FROM public.shop_profiles lp JOIN public.users lu ON lu.id = lp.owner_id
  WHERE lp.id = v_upline AND lp.approval_status NOT IN ('suspended','rejected');
  v_lead_eligible := COALESCE(v_lead_eligible, false);
  IF NOT v_lead_eligible THEN
    -- The Lead may have become ineligible AFTER submitting (e.g. dealer expiry),
    -- so the row could still carry its original +48h escalate_after. Pull it
    -- forward so the escalation cron forwards it to admin on the next tick
    -- instead of leaving the sub's funds in limbo. Row is already FOR UPDATE.
    UPDATE public.shop_wallet_transactions SET escalate_after = now(), updated_at = now() WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', false, 'error', 'lead_ineligible');
  END IF;

  IF p_action = 'approve' THEN
    UPDATE public.shop_wallet_transactions
    SET status='pending', sub_approval_status='approved', sub_approved_by=p_actor_id, sub_approval_note=p_note, updated_at=now()
    WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', true, 'action', 'approved');
  ELSIF p_action = 'reject' THEN
    UPDATE public.shop_wallets
    SET balance = balance + v_tx.amount, total_withdrawn = GREATEST(0, COALESCE(total_withdrawn,0) - v_tx.amount), updated_at=now()
    WHERE id = v_tx.shop_wallet_id;
    UPDATE public.shop_wallet_transactions
    SET status='reversed', sub_approval_status='rejected', sub_approved_by=p_actor_id, sub_approval_note=p_note, updated_at=now()
    WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', true, 'action', 'rejected');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resubmit_withdrawal(p_transaction_id uuid, p_account_name text, p_momo_number text, p_network text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_current_note TEXT;
    v_new_note     TEXT;
BEGIN
    -- Get the current admin note
    SELECT admin_note INTO v_current_note
    FROM public.shop_wallet_transactions
    WHERE id = p_transaction_id
      AND status = 'rejected'
      AND shop_wallet_id IN (
          SELECT id FROM public.shop_wallets WHERE owner_id = auth.uid()
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Resubmission failed: transaction not found, not rejected, or does not belong to you.';
    END IF;

    -- Build the hardcoded audit trail note server-side
    v_new_note := '[RESUBMITTED] Previously rejected: "' || COALESCE(v_current_note, 'No reason given') || '". New payment details provided.';

    -- Perform the extremely restricted update
    UPDATE public.shop_wallet_transactions
    SET
        status       = 'pending',
        account_name = p_account_name,
        momo_number  = p_momo_number,
        network      = p_network,
        admin_note   = v_new_note,
        updated_at   = NOW()
    WHERE id = p_transaction_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resubmit_withdrawal(p_transaction_id uuid, p_account_name text, p_momo_number text, p_network text, p_admin_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    UPDATE public.shop_wallet_transactions
    SET
        status       = 'pending',
        account_name = p_account_name,
        momo_number  = p_momo_number,
        network      = p_network,
        admin_note   = p_admin_note,
        updated_at   = NOW()
    WHERE id = p_transaction_id
      -- Must currently be rejected
      AND status = 'rejected'
      -- Must actually belong to the calling user
      AND shop_wallet_id IN (
          SELECT id FROM public.shop_wallets WHERE owner_id = auth.uid()
      );

    -- If no row was updated, raise an error so the client knows
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Resubmission failed: transaction not found, not rejected, or does not belong to you.';
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_lead_margin(p_shop_order_id uuid DEFAULT NULL::uuid, p_order_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_tx public.shop_wallet_transactions%ROWTYPE; v_rev_source text; v_already boolean;
BEGIN
  IF p_shop_order_id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.shop_wallet_transactions
      WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND credit_source = 'order_parent'
      ORDER BY created_at LIMIT 1;
  ELSIF p_order_reference IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.shop_wallet_transactions
      WHERE order_reference = p_order_reference AND type = 'profit' AND credit_source = 'wallet_sub_purchase'
      ORDER BY created_at LIMIT 1;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'no_key');
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'nothing_to_reverse', true); END IF;
  v_rev_source := v_tx.credit_source || '_reversal';

  -- Lock the wallet BEFORE checking already-reversed (was: checked first, locked
  -- after) — closes the same class of TOCTOU fixed above in credit_shop_profit.
  PERFORM 1 FROM public.shop_wallets WHERE id = v_tx.shop_wallet_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM public.shop_wallet_transactions
    WHERE shop_wallet_id = v_tx.shop_wallet_id AND type = 'profit_reversal' AND credit_source = v_rev_source
      AND ((p_shop_order_id IS NOT NULL AND shop_order_id = p_shop_order_id)
        OR (p_order_reference IS NOT NULL AND order_reference = p_order_reference))
  ) INTO v_already;

  IF v_already THEN
    RETURN jsonb_build_object('ok', true, 'already_reversed', true);
  END IF;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, shop_order_id, type, amount, status, description, credit_source, order_reference)
  VALUES (v_tx.shop_wallet_id, v_tx.shop_order_id, 'profit_reversal', v_tx.amount, 'completed',
     'Lead margin reversal for refunded sub-agent order', v_rev_source, v_tx.order_reference);
  UPDATE public.shop_wallets SET balance = balance - v_tx.amount,
      total_earned = GREATEST(0, total_earned - v_tx.amount), updated_at = now()
  WHERE id = v_tx.shop_wallet_id;
  RETURN jsonb_build_object('ok', true, 'reversed', true, 'amount', v_tx.amount);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_shop_afa_profit(p_afa_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_id UUID;
  v_wallet_id UUID;
  v_profit_tx_id UUID;
  v_amount DECIMAL;
  v_existing_reversal_id UUID;
  v_new_balance DECIMAL;
BEGIN
  SELECT sp.owner_id
  INTO v_owner_id
  FROM public.afa_orders ao
  JOIN public.shop_profiles sp ON ao.shop_id = sp.id
  WHERE ao.id = p_afa_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = v_owner_id
  FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    -- No wallet exists at all, so nothing could ever have been credited.
    RETURN jsonb_build_object('success', false, 'message', 'No profit to reverse');
  END IF;

  -- Find the original profit row for this order.
  SELECT id, amount INTO v_profit_tx_id, v_amount
  FROM public.shop_wallet_transactions
  WHERE afa_order_id = p_afa_order_id AND type = 'profit';

  IF v_profit_tx_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No profit to reverse');
  END IF;

  -- Idempotency check runs under the wallet lock acquired above.
  SELECT id INTO v_existing_reversal_id
  FROM public.shop_wallet_transactions
  WHERE afa_order_id = p_afa_order_id AND type = 'profit_reversal';

  IF v_existing_reversal_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already reversed');
  END IF;

  UPDATE public.shop_wallets
  SET
    balance = balance - v_amount,
    total_earned = GREATEST(0, total_earned - v_amount),
    updated_at = NOW()
  WHERE id = v_wallet_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, afa_order_id, type, amount, description, status)
  VALUES
    (v_wallet_id, p_afa_order_id, 'profit_reversal', v_amount, 'AFA Registration cancelled — profit reversed', 'completed');

  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Reversed ' || v_amount || ' — wallet balance is now negative (' || v_new_balance || ')');
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Reversed ' || v_amount);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_shop_profit(p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_profit numeric; v_owner uuid; v_wallet_id uuid;
BEGIN
  SELECT so.profit, sp.owner_id INTO v_profit, v_owner
    FROM public.shop_orders so JOIN public.shop_profiles sp ON sp.id = so.shop_id
    WHERE so.id = p_shop_order_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;

  SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN RETURN jsonb_build_object('ok',true,'already_reversed',true); END IF;

  IF EXISTS (SELECT 1 FROM public.shop_wallet_transactions
             WHERE shop_order_id = p_shop_order_id AND type = 'profit_reversal') THEN
    RETURN jsonb_build_object('ok',true,'already_reversed',true); END IF;

  INSERT INTO public.shop_wallet_transactions (shop_wallet_id, shop_order_id, type, amount, status)
    VALUES (v_wallet_id, p_shop_order_id, 'profit_reversal', v_profit, 'completed');
  UPDATE public.shop_wallets SET balance = balance - v_profit,
         total_earned = GREATEST(0, total_earned - v_profit) WHERE id = v_wallet_id;
  RETURN jsonb_build_object('ok',true,'reversed',true,'amount',v_profit);
END; $function$
;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rotate_shop_invite(p_actor_id uuid, p_shop_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner   uuid;
  v_code    text;
  v_attempt int := 0;
BEGIN
  -- Ownership re-check: the actor must own this shop.
  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = p_shop_id;
  IF v_owner IS NULL OR v_owner <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_shop');
  END IF;

  -- Retire every currently-active invite for this shop.
  UPDATE public.shop_invites
  SET revoked_at = now()
  WHERE shop_id = p_shop_id AND revoked_at IS NULL;

  -- Mint one fresh unlimited, non-expiring code; retry on UNIQUE(code) collision.
  LOOP
    v_attempt := v_attempt + 1;
    v_code := left(
      translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_'),
      12
    );
    BEGIN
      INSERT INTO public.shop_invites (shop_id, code, max_uses, expires_at)
      VALUES (p_shop_id, v_code, NULL, NULL);
      RETURN jsonb_build_object('ok', true, 'code', v_code);
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 5 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'code_generation_failed');
      END IF;
    END;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.save_shop_payment_detail_if_under_limit(p_owner_id uuid, p_account_name text, p_momo_number text, p_account_number text, p_network text, p_payment_type text, p_bank_id text, p_limit integer DEFAULT 5)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_count int;
    -- The caller may lower the cap, never raise it.
    v_limit int := LEAST(GREATEST(COALESCE(p_limit, 5), 0), 5);
BEGIN
    IF auth.uid() IS NOT NULL AND auth.uid() != p_owner_id THEN
        RAISE EXCEPTION 'ACCESS_DENIED: You may only save your own payment details';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('shop_payment_details:' || p_owner_id::text, 0));

    SELECT COUNT(*) INTO v_count
    FROM public.shop_payment_details
    WHERE shop_owner_id = p_owner_id;

    IF v_count >= v_limit THEN
        -- At the limit: no insert. The withdraw route's post-withdrawal auto-save
        -- ignores this; POST /api/shop/payment-details reports it to the owner.
        RETURN false;
    END IF;

    INSERT INTO public.shop_payment_details (
        shop_owner_id, account_name, momo_number, account_number,
        network, payment_type, bank_id, is_default
    ) VALUES (
        p_owner_id, p_account_name, p_momo_number, p_account_number,
        p_network, p_payment_type, p_bank_id, v_count = 0
    );
    RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_sub_agent_state(p_actor_id uuid, p_sub_user_id uuid, p_action text, p_ceiling numeric DEFAULT NULL::numeric, p_is_admin boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sa    public.sub_agents%ROWTYPE;
  v_owner uuid;
BEGIN
  SELECT * INTO v_sa FROM public.sub_agents WHERE user_id = p_sub_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'sub_not_found'); END IF;

  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_sa.upline_shop_id;
  IF NOT p_is_admin AND (v_owner IS NULL OR v_owner <> p_actor_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_sub');
  END IF;

  IF p_action = 'approve' THEN
    IF v_sa.status = 'suspended' THEN RETURN jsonb_build_object('ok', false, 'error', 'suspended'); END IF;
    UPDATE public.sub_agents SET status='active', approved_by=p_actor_id, approved_at=now(), updated_at=now()
      WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'suspend' THEN
    UPDATE public.sub_agents SET status='suspended', updated_at=now() WHERE user_id=p_sub_user_id;
    UPDATE public.shop_profiles SET is_active=false, updated_at=now() WHERE owner_id=p_sub_user_id;
    UPDATE public.shop_invites SET revoked_at = now()
      WHERE shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = p_sub_user_id)
        AND revoked_at IS NULL;

  ELSIF p_action = 'reactivate' THEN
    UPDATE public.sub_agents SET status='active', updated_at=now() WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'set_ceiling' THEN
    IF p_ceiling IS NOT NULL AND p_ceiling < 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_ceiling'); END IF;
    UPDATE public.sub_agents SET markup_ceiling=p_ceiling, updated_at=now() WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'grant_recruit' THEN
    IF public.sub_chain_depth_above(v_sa.upline_shop_id) >= 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'max_depth_reached');
    END IF;
    UPDATE public.sub_agents SET may_recruit=true, updated_at=now() WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'revoke_recruit' THEN
    UPDATE public.sub_agents SET may_recruit=false, updated_at=now() WHERE user_id=p_sub_user_id;
    UPDATE public.shop_invites SET revoked_at = now()
      WHERE shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = p_sub_user_id)
        AND revoked_at IS NULL;

  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
  END IF;

  RETURN jsonb_build_object('ok', true, 'action', p_action);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.settle_afa_refund_to_owner(p_afa_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ao public.afa_orders%ROWTYPE;
  v_owner uuid;
  v_wallet_id uuid;
  v_ref text;
BEGIN
  SELECT * INTO v_ao FROM public.afa_orders WHERE id = p_afa_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'order_not_found'); END IF;
  IF v_ao.status = 'refunded' THEN RETURN jsonb_build_object('ok', true, 'already_refunded', true); END IF;
  IF v_ao.status NOT IN ('pending', 'processing', 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refundable', 'status', v_ao.status); END IF;
  IF v_ao.shop_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_shop_linked'); END IF;
  IF v_ao.cost_price IS NULL OR v_ao.cost_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_cost_to_refund'); END IF;

  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_ao.shop_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'owner_not_found'); END IF;

  v_ref := 'REFUND-AFA-OWNER-' || p_afa_order_id::text;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance) VALUES (v_owner, 0) RETURNING id INTO v_wallet_id;
  END IF;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_owner, 'credit', v_ao.cost_price,
            'AFA order refund (cost) ' || p_afa_order_id::text, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_ao.cost_price WHERE id = v_wallet_id;

  UPDATE public.afa_orders SET status = 'refunded', refund_method = 'owner_wallet',
         refunded_by = p_actor_id, refunded_at = now(), refund_reason = p_reason, updated_at = now()
    WHERE id = p_afa_order_id;

  RETURN jsonb_build_object('ok', true, 'settled', true, 'amount', v_ao.cost_price);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok', true, 'already_refunded', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.settle_shop_refund_to_owner(p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_so public.shop_orders%ROWTYPE; v_owner uuid; v_wallet_id uuid; v_ref text;
BEGIN
  SELECT * INTO v_so FROM public.shop_orders WHERE id = p_shop_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_so.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_so.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_so.status); END IF;

  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_so.shop_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','owner_not_found'); END IF;

  v_ref := 'REFUND-SHOP-OWNER-' || p_shop_order_id::text;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance) VALUES (v_owner, 0) RETURNING id INTO v_wallet_id; END IF;

  -- credit COST ONLY to owner's personal retail wallet; profit stays in shop_wallets (kept, NOT reversed)
  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_owner, 'credit', v_so.cost_price,
            'Shop order refund (cost) ' || p_shop_order_id::text, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_so.cost_price WHERE id = v_wallet_id;

  UPDATE public.shop_orders SET status='refunded', refund_method='owner_wallet',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason WHERE id = p_shop_order_id;
  UPDATE public.orders SET status='refunded', payment_status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE shop_order_id = p_shop_order_id AND status <> 'refunded';
  -- storefront airtime mirror row shares reference_code (SHOP-*) with the orders mirror row
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE reference_code IN (SELECT reference_code FROM public.orders WHERE shop_order_id = p_shop_order_id)
      AND status <> 'refunded';

  RETURN jsonb_build_object('ok',true,'settled',true,'amount',v_so.cost_price);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',true,'already_refunded',true);
END; $function$
;

CREATE OR REPLACE FUNCTION public.settle_sms_campaign(p_campaign_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_camp        RECORD;
    v_failed      INTEGER;
    v_undispatched INTEGER;
    v_refund      INTEGER;
    v_final       TEXT;
    v_credit      JSONB;
BEGIN
    SELECT * INTO v_camp FROM sms_campaigns
    WHERE id = p_campaign_id AND status = 'processing'
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('settled', false, 'reason', 'NOT_PROCESSING');
    END IF;

    SELECT COUNT(*) FILTER (WHERE status = 'failed'),
           COUNT(*) FILTER (WHERE status = 'queued')
    INTO v_failed, v_undispatched
    FROM sms_messages WHERE campaign_id = p_campaign_id;

    -- Undispatched rows at settle time (dispatcher aborted): mark failed so
    -- they are refunded and never silently lost.
    IF v_undispatched > 0 THEN
        UPDATE sms_messages
        SET status = 'failed', status_detail = 'not dispatched', status_updated_at = now()
        WHERE campaign_id = p_campaign_id AND status = 'queued';
        v_failed := v_failed + v_undispatched;
    END IF;

    v_refund := v_failed * v_camp.segments;
    v_final  := CASE
        WHEN v_failed = 0 THEN 'completed'
        WHEN v_failed >= v_camp.recipients_count THEN 'failed'
        ELSE 'partial'
    END;

    IF v_refund > 0 THEN
        v_credit := credit_user_sms_credits(
            v_camp.account_id, v_refund,
            'refund:' || p_campaign_id::text, 'refund', p_campaign_id::text);
    END IF;

    UPDATE sms_campaigns
    SET status = v_final, settled_at = now()
    WHERE id = p_campaign_id;

    RETURN jsonb_build_object('settled', true, 'final_status', v_final,
        'failed_count', v_failed, 'refunded_credits', COALESCE(v_refund, 0));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.shop_sms_usage_breakdown(p_shop_id uuid)
 RETURNS TABLE(source text, credits bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT l.source, COALESCE(SUM(l.credits_used), 0)::bigint
  FROM public.shop_sms_logs l
  WHERE l.shop_id = p_shop_id
  GROUP BY l.source;
$function$
;

CREATE OR REPLACE FUNCTION public.sub_chain_depth_above(p_shop_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_depth   INTEGER := 0;
  v_shop    UUID := p_shop_id;
  v_owner   UUID;
  v_upline  UUID;
  i         INTEGER;
BEGIN
  FOR i IN 1..3 LOOP
    SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_shop;
    IF v_owner IS NULL THEN RETURN v_depth; END IF;

    SELECT upline_shop_id INTO v_upline FROM public.sub_agents WHERE user_id = v_owner;
    IF v_upline IS NULL THEN RETURN v_depth; END IF;

    v_depth := v_depth + 1;
    v_shop  := v_upline;
  END LOOP;

  RETURN v_depth;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.toggle_fulfillment_supplier_network(p_supplier_key text, p_network text, p_enable boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_raw jsonb;
  v_current jsonb;
  v_new jsonb;
  v_key text;
  v_allowed CONSTANT text[] := ARRAY[
    'networks', 'codecraft_networks', 'xpress_networks', 'ghdata_networks',
    'agentportal_networks', 'bundleportal_networks', 'hendylinks_networks',
    'atishare_console_networks', 'spfastit_networks'
  ];
BEGIN
  IF NOT (p_supplier_key = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'invalid_supplier_key: %', p_supplier_key;
  END IF;
  IF p_network IS NULL OR length(trim(p_network)) = 0 THEN
    RAISE EXCEPTION 'invalid_network';
  END IF;

  PERFORM 1 FROM public.admin_settings WHERE key = 'fulfillment_settings' FOR UPDATE;

  SELECT value INTO v_raw FROM public.admin_settings WHERE key = 'fulfillment_settings';

  IF v_raw IS NULL THEN
    v_current := '{}'::jsonb;
  ELSIF jsonb_typeof(v_raw) = 'string' THEN
    v_current := COALESCE(NULLIF(v_raw #>> '{}', ''), '{}')::jsonb;
  ELSE
    v_current := v_raw;
  END IF;

  v_new := v_current;
  FOREACH v_key IN ARRAY v_allowed LOOP
    IF v_key = p_supplier_key THEN
      v_new := jsonb_set(
        v_new, ARRAY[v_key],
        COALESCE(v_new -> v_key, '{}'::jsonb) || jsonb_build_object(p_network, p_enable),
        true
      );
    ELSIF p_enable THEN
      v_new := jsonb_set(
        v_new, ARRAY[v_key],
        COALESCE(v_new -> v_key, '{}'::jsonb) || jsonb_build_object(p_network, false),
        true
      );
    END IF;
  END LOOP;

  INSERT INTO public.admin_settings (key, value)
  VALUES ('fulfillment_settings', to_jsonb(v_new::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN v_new;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_commission_wallet(p_owner_id uuid, p_amount numeric, p_destination text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wallet record; v_shop_wallet_id uuid; v_main_wallet_id uuid;
BEGIN
  IF p_destination NOT IN ('main', 'shop') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_destination');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_wallet FROM public.commission_wallets WHERE owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_commission_wallet');
  END IF;
  IF v_wallet.balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance');
  END IF;

  IF p_destination = 'shop' THEN
    -- Deliberately requires a PRE-EXISTING shop wallet (unlike 'main' below,
    -- which auto-creates) — a commission holder with no storefront has no
    -- shop wallet to receive into, and we don't want to silently create one.
    SELECT id INTO v_shop_wallet_id FROM public.shop_wallets WHERE owner_id = p_owner_id FOR UPDATE;
    IF v_shop_wallet_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_shop_wallet');
    END IF;
  END IF;

  UPDATE public.commission_wallets SET balance = balance - p_amount, updated_at = now() WHERE id = v_wallet.id;
  INSERT INTO public.commission_wallet_transactions (commission_wallet_id, type, amount, description, status)
  VALUES (v_wallet.id, CASE WHEN p_destination = 'main' THEN 'transfer_out_main' ELSE 'transfer_out_shop' END,
          p_amount, 'Transfer to ' || CASE WHEN p_destination = 'main' THEN 'main wallet' ELSE 'shop wallet' END, 'completed');

  IF p_destination = 'main' THEN
    -- Deliberate auto-creation: every user has (or should have) a main
    -- wallet, so upsert-then-credit rather than failing the transfer.
    -- credit_wallet_balance() is NOT used here — it applies refund
    -- semantics (erodes total_spent) and writes no wallet_transactions row,
    -- which would leave a balance jump with nothing in the user's ledger
    -- explaining it. Credit and ledger explicitly instead.
    INSERT INTO public.wallets (user_id, balance) VALUES (p_owner_id, 0) ON CONFLICT (user_id) DO NOTHING;
    SELECT id INTO v_main_wallet_id FROM public.wallets WHERE user_id = p_owner_id FOR UPDATE;
    UPDATE public.wallets SET balance = balance + p_amount, updated_at = now() WHERE id = v_main_wallet_id;
    INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, source, status)
    VALUES (v_main_wallet_id, p_owner_id, 'credit', p_amount, 'Transfer from commission wallet', 'commission', 'completed');
  ELSE
    -- Balance only — this amount was already counted in
    -- commission_wallets.total_earned; adding it to shop_wallets.total_earned
    -- too would double-count it and blur the commission/shop separation.
    UPDATE public.shop_wallets SET balance = balance + p_amount, updated_at = now()
     WHERE id = v_shop_wallet_id;
    INSERT INTO public.shop_wallet_transactions (shop_wallet_id, type, amount, description, status)
    VALUES (v_shop_wallet_id, 'commission_transfer_in', p_amount, 'Transfer from commission wallet', 'completed');
  END IF;

  RETURN jsonb_build_object('success', true, 'destination', p_destination, 'amount', p_amount);
END $function$
;

CREATE OR REPLACE FUNCTION public.trg_sub_agent_earning_by_paystack_reference()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.apply_sub_agent_earning_sync(COALESCE(NEW.paystack_reference, NEW.id::text), NEW.status, TG_TABLE_NAME);
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_sub_agent_earning_by_reference_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.apply_sub_agent_earning_sync(NEW.reference_code, NEW.status, TG_TABLE_NAME);
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_guest_push_subscriptions_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_push_subscriptions_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_support_threads_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_utility_orders_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_website_requests_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_shop_customer_from_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.shop_id IS NULL OR NEW.guest_phone IS NULL OR NEW.guest_phone = '' THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.shop_customers (shop_id, phone, total_orders, total_spent, first_order_at, last_order_at)
    VALUES (NEW.shop_id, NEW.guest_phone, 1, COALESCE(NEW.selling_price, 0), NEW.created_at, NEW.created_at)
    ON CONFLICT (shop_id, phone) DO UPDATE SET
        total_orders  = shop_customers.total_orders + 1,
        total_spent   = shop_customers.total_spent + COALESCE(NEW.selling_price, 0),
        last_order_at = GREATEST(shop_customers.last_order_at, NEW.created_at),
        updated_at    = now();

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_shop_customer_from_rc_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.shop_id IS NULL OR NEW.customer_phone IS NULL OR NEW.customer_phone = '' THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.shop_customers (shop_id, phone, total_orders, total_spent, first_order_at, last_order_at)
    VALUES (
        NEW.shop_id, NEW.customer_phone, 1,
        COALESCE(NEW.unit_price, 0) * COALESCE(NEW.quantity, 1),
        NEW.created_at, NEW.created_at
    )
    ON CONFLICT (shop_id, phone) DO UPDATE SET
        total_orders  = shop_customers.total_orders + 1,
        total_spent   = shop_customers.total_spent + (COALESCE(NEW.unit_price, 0) * COALESCE(NEW.quantity, 1)),
        last_order_at = GREATEST(shop_customers.last_order_at, NEW.created_at),
        updated_at    = now();

    RETURN NEW;
END;
$function$
;
