-- supabase/migrations/20260705c_money_core_security_fixes.sql
-- =============================================================================
-- Stage-4 remediation of the sub-agent money core (adversarial review w4kbb0row).
-- Fixes (severity):
--   A CRITICAL/HIGH — refunds were NOT sub-aware: the Lead's margin credit
--     ('order_parent' storefront / 'wallet_sub_purchase' wallet) was never
--     reversed on refund → Lead kept money for a voided sale (wallet self-refund
--     pump). New reverse_lead_margin() wired into all 3 refund RPCs.
--   C HIGH — adjust_shop_pricing_for_role_change repriced SUB shops on role tiers
--     (corrupts their retail); its trigger twin excludes them. Add the exclusion
--     + explicit REVOKE (defense-in-depth; live ACL was already service_role-only).
--   E MED — credit_shop_order_profits had no status guard → an unauth charge-status
--     replay could credit a refunded order. Skip refunded/failed orders.
--   G — effective_owner_cost existed in prod but in NO repo file (fresh-env break).
--     Define it here (idempotent) + REVOKE from anon/authenticated (was over-granted).
--   I LOW — global reprice trigger rejected agent/dealer_price = 0, but the admin
--     routes use 0 as a legal "unpriced" sentinel → blocked legit repricing.
-- =============================================================================

-- ── G: effective_owner_cost — canonical definition in-repo + lock the surface ──
CREATE OR REPLACE FUNCTION public.effective_owner_cost(
  p_price        numeric,
  p_agent_price  numeric,
  p_dealer_price numeric,
  p_role         text
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_role = 'dealer' AND COALESCE(p_dealer_price, 0) > 0 THEN p_dealer_price
    WHEN p_role = 'agent'  AND COALESCE(p_agent_price, 0)  > 0 THEN p_agent_price
    ELSE COALESCE(p_price, 0)
  END
$$;
REVOKE ALL ON FUNCTION public.effective_owner_cost(numeric, numeric, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.effective_owner_cost(numeric, numeric, numeric, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.effective_owner_cost(numeric, numeric, numeric, text) TO service_role;

-- ── A: reverse the Lead's margin credit for a refunded sub-agent order ──────────
-- Handles BOTH shapes: storefront ('order_parent', keyed by shop_order_id) and
-- wallet ('wallet_sub_purchase', keyed by order_reference). Idempotent.
CREATE OR REPLACE FUNCTION public.reverse_lead_margin(
  p_shop_order_id   uuid DEFAULT NULL,
  p_order_reference text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx         public.shop_wallet_transactions%ROWTYPE;
  v_rev_source text;
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

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'nothing_to_reverse', true);
  END IF;

  v_rev_source := v_tx.credit_source || '_reversal';

  -- Idempotency: reversal already recorded for this exact credit?
  IF EXISTS (
    SELECT 1 FROM public.shop_wallet_transactions
    WHERE shop_wallet_id = v_tx.shop_wallet_id
      AND type = 'profit_reversal'
      AND credit_source = v_rev_source
      AND ( (p_shop_order_id IS NOT NULL AND shop_order_id = p_shop_order_id)
         OR (p_order_reference IS NOT NULL AND order_reference = p_order_reference) )
  ) THEN
    RETURN jsonb_build_object('ok', true, 'already_reversed', true);
  END IF;

  -- Lock the Lead wallet, debit, and record the reversal.
  PERFORM 1 FROM public.shop_wallets WHERE id = v_tx.shop_wallet_id FOR UPDATE;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, shop_order_id, type, amount, status, description, credit_source, order_reference)
  VALUES
    (v_tx.shop_wallet_id, v_tx.shop_order_id, 'profit_reversal', v_tx.amount, 'completed',
     'Lead margin reversal for refunded sub-agent order', v_rev_source, v_tx.order_reference);

  UPDATE public.shop_wallets
  SET balance = balance - v_tx.amount,
      total_earned = GREATEST(0, total_earned - v_tx.amount),
      updated_at = now()
  WHERE id = v_tx.shop_wallet_id;

  RETURN jsonb_build_object('ok', true, 'reversed', true, 'amount', v_tx.amount);
END;
$function$;
REVOKE ALL ON FUNCTION public.reverse_lead_margin(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_lead_margin(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_lead_margin(uuid, text) TO service_role;

-- ── A: wire reverse_lead_margin into the 3 refund paths ─────────────────────────
-- reverse_shop_profit (storefront Paystack path) — reproduce deployed body + reversal
CREATE OR REPLACE FUNCTION public.reverse_shop_profit(p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_profit numeric; v_owner uuid; v_wallet_id uuid; v_status text; v_bal numeric; v_shortfall numeric;
BEGIN
  SELECT so.profit, so.status, sp.owner_id INTO v_profit, v_status, v_owner
    FROM public.shop_orders so JOIN public.shop_profiles sp ON sp.id = so.shop_id
    WHERE so.id = p_shop_order_id FOR UPDATE OF so;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_status = 'completed' THEN RETURN jsonb_build_object('ok',false,'error','cannot_reverse_completed'); END IF;

  -- Reverse the Lead's wholesale margin credit for sub-agent orders (idempotent, no-op otherwise)
  PERFORM public.reverse_lead_margin(p_shop_order_id := p_shop_order_id);

  SELECT id, balance INTO v_wallet_id, v_bal FROM public.shop_wallets WHERE owner_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'already_reversed',true,'shortfall',COALESCE(v_profit,0)); END IF;

  IF EXISTS (SELECT 1 FROM public.shop_wallet_transactions
             WHERE shop_order_id = p_shop_order_id AND type = 'profit_reversal'
               AND (credit_source IS NULL OR credit_source NOT LIKE '%\_reversal')) THEN
    RETURN jsonb_build_object('ok',true,'already_reversed',true,'shortfall',0); END IF;

  v_profit := COALESCE(v_profit, 0);
  v_shortfall := GREATEST(0, v_profit - GREATEST(v_bal, 0));

  INSERT INTO public.shop_wallet_transactions (shop_wallet_id, shop_order_id, type, amount, status, description)
    VALUES (v_wallet_id, p_shop_order_id, 'profit_reversal', v_profit, 'completed',
            'Profit reversal for refunded shop order ' || p_shop_order_id::text
            || CASE WHEN v_shortfall > 0 THEN ' (shortfall ' || round(v_shortfall, 2)::text || ' — owner already withdrew; balance now owed)' ELSE '' END);
  UPDATE public.shop_wallets SET balance = balance - v_profit,
         total_earned = GREATEST(0, total_earned - v_profit) WHERE id = v_wallet_id;
  RETURN jsonb_build_object('ok',true,'reversed',true,'amount',v_profit,'shortfall',v_shortfall,'new_balance',v_bal - v_profit);
END; $function$;

-- settle_shop_refund_to_owner (storefront settle path) — reproduce deployed body + reversal
CREATE OR REPLACE FUNCTION public.settle_shop_refund_to_owner(p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_so public.shop_orders%ROWTYPE; v_owner uuid; v_wallet_id uuid; v_ref text;
BEGIN
  SELECT * INTO v_so FROM public.shop_orders WHERE id = p_shop_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_so.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_so.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_so.status); END IF;
  IF v_so.cost_price IS NULL OR v_so.cost_price < 0 THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_cost_price'); END IF;

  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_so.shop_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','owner_not_found'); END IF;

  -- Reverse the Lead's margin for sub-agent orders — else settle overpays by parent_profit.
  PERFORM public.reverse_lead_margin(p_shop_order_id := p_shop_order_id);

  v_ref := 'REFUND-SHOP-OWNER-' || p_shop_order_id::text;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance) VALUES (v_owner, 0) RETURNING id INTO v_wallet_id; END IF;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_owner, 'credit', v_so.cost_price,
            'Shop order refund (cost) ' || p_shop_order_id::text, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_so.cost_price WHERE id = v_wallet_id;

  UPDATE public.shop_orders SET status='refunded', refund_method='owner_wallet',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason WHERE id = p_shop_order_id;
  UPDATE public.orders SET status='refunded', payment_status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE shop_order_id = p_shop_order_id AND status <> 'refunded';
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE shop_id = v_so.shop_id
      AND reference_code IN (SELECT reference_code FROM public.orders WHERE shop_order_id = p_shop_order_id)
      AND status <> 'refunded';

  RETURN jsonb_build_object('ok',true,'settled',true,'amount',v_so.cost_price);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',true,'already_refunded',true);
END; $function$;

-- refund_order_wallet (wallet-mode path) — reproduce deployed body + Lead reversal
CREATE OR REPLACE FUNCTION public.refund_order_wallet(p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_o public.orders%ROWTYPE; v_ref text; v_wallet_id uuid;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
  IF v_o.payment_status = 'refunded' OR v_o.status = 'refunded' THEN
    RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_o.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status); END IF;
  IF v_o.user_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','no_wallet_user'); END IF;

  -- Reverse the Lead's wallet-mode margin credit for this order (idempotent, no-op otherwise).
  PERFORM public.reverse_lead_margin(p_order_reference := v_o.reference_code);

  v_ref := 'REFUND-ORDER-' || p_order_id::text;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0) RETURNING id INTO v_wallet_id; END IF;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.price,
            'Refund for order ' || v_o.reference_code, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_o.price,
         total_spent = GREATEST(0, total_spent - v_o.price) WHERE id = v_wallet_id;

  UPDATE public.orders SET status='refunded', payment_status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE id = p_order_id;

  RETURN jsonb_build_object('ok',true,'refunded',true,'amount',v_o.price);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',true,'already_refunded',true);
END; $function$;

-- ── E: credit_shop_order_profits — never credit a refunded/failed order ─────────
CREATE OR REPLACE FUNCTION public.credit_shop_order_profits(p_shop_order_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_profit DECIMAL; v_parent_profit DECIMAL; v_parent_shop_id UUID; v_status TEXT;
  v_sub_owner_id UUID; v_parent_owner_id UUID; v_network TEXT; v_package_size TEXT; v_guest_phone TEXT;
  v_sub_wallet_id UUID; v_parent_wallet_id UUID;
  v_credited_sub BOOLEAN := false; v_credited_parent BOOLEAN := false; v_existing UUID;
BEGIN
  SELECT so.profit, so.parent_profit, so.parent_shop_id, so.status,
         sp.owner_id, pp.owner_id, so.network, so.package_size, so.guest_phone
  INTO   v_profit, v_parent_profit, v_parent_shop_id, v_status,
         v_sub_owner_id, v_parent_owner_id, v_network, v_package_size, v_guest_phone
  FROM public.shop_orders so
  JOIN public.shop_profiles sp ON so.shop_id = sp.id
  LEFT JOIN public.shop_profiles pp ON so.parent_shop_id = pp.id
  WHERE so.id = p_shop_order_id;

  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Order not found'); END IF;
  IF v_parent_shop_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not a sub-agent order — use credit_shop_profit'); END IF;
  -- E: refunded/failed orders must never be (re-)credited.
  IF v_status IN ('refunded','failed') THEN
    RETURN jsonb_build_object('success', true, 'message', 'Order not creditable (status ' || v_status || ')'); END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_sub_owner_id, 0, 0), (v_parent_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  SELECT id INTO v_sub_wallet_id    FROM public.shop_wallets WHERE owner_id = v_sub_owner_id    FOR UPDATE;
  SELECT id INTO v_parent_wallet_id FROM public.shop_wallets WHERE owner_id = v_parent_owner_id FOR UPDATE;

  IF COALESCE(v_profit, 0) > 0 THEN
    SELECT id INTO v_existing FROM public.shop_wallet_transactions
    WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND shop_wallet_id = v_sub_wallet_id;
    IF v_existing IS NULL THEN
      UPDATE public.shop_wallets SET balance = balance + v_profit, total_earned = total_earned + v_profit, updated_at = NOW() WHERE id = v_sub_wallet_id;
      INSERT INTO public.shop_wallet_transactions (shop_wallet_id, shop_order_id, type, amount, description, status, credit_source)
      VALUES (v_sub_wallet_id, p_shop_order_id, 'profit', v_profit,
         'Sale: ' || v_network || ' ' || v_package_size || ' to ' || v_guest_phone, 'completed', 'order');
      v_credited_sub := true;
    END IF;
  END IF;

  IF COALESCE(v_parent_profit, 0) > 0 THEN
    SELECT id INTO v_existing FROM public.shop_wallet_transactions
    WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND shop_wallet_id = v_parent_wallet_id;
    IF v_existing IS NULL THEN
      UPDATE public.shop_wallets SET balance = balance + v_parent_profit, total_earned = total_earned + v_parent_profit, updated_at = NOW() WHERE id = v_parent_wallet_id;
      INSERT INTO public.shop_wallet_transactions (shop_wallet_id, shop_order_id, type, amount, description, status, credit_source)
      VALUES (v_parent_wallet_id, p_shop_order_id, 'profit', v_parent_profit,
         'Network sale: ' || v_network || ' ' || v_package_size || ' via sub-agent', 'completed', 'order_parent');
      v_credited_parent := true;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true,
    'credited_sub', v_credited_sub, 'sub_amount', COALESCE(v_profit, 0),
    'credited_parent', v_credited_parent, 'parent_amount', COALESCE(v_parent_profit, 0),
    'message', CASE WHEN NOT v_credited_sub AND NOT v_credited_parent THEN 'Already credited' ELSE 'Credited' END);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.credit_shop_order_profits(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_shop_order_profits(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_shop_order_profits(UUID) TO service_role;

-- ── C: role-change reprice must SKIP sub shops (their basis is wholesale) + REVOKE
CREATE OR REPLACE FUNCTION public.adjust_shop_pricing_for_role_change(
    p_user_id UUID, p_old_role TEXT, p_new_role TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_shop_id UUID; v_is_sub BOOLEAN; v_updated_count INTEGER := 0; rec RECORD;
    v_old_cost DECIMAL(12,2); v_new_cost DECIMAL(12,2); v_profit DECIMAL(12,2);
    v_new_price DECIMAL(12,2); v_new_sub DECIMAL(12,2);
BEGIN
    -- A sub-agent's shop_pricing is priced against their upline's wholesale sub_price,
    -- NOT a platform role tier — repricing it on role tiers corrupts their retail rows.
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
        IF v_new_sub IS NOT NULL AND v_new_sub < v_new_cost + 0.01 THEN
            v_new_sub := ROUND(v_new_cost + 0.01, 2);
        END IF;

        UPDATE public.shop_pricing SET selling_price = v_new_price, sub_price = v_new_sub WHERE id = rec.pricing_id;
        v_updated_count := v_updated_count + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'updated', v_updated_count,
        'message', format('Adjusted %s pricing rows from %s to %s cost tier', v_updated_count, p_old_role, p_new_role));
END;
$$;
REVOKE ALL ON FUNCTION public.adjust_shop_pricing_for_role_change(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_shop_pricing_for_role_change(UUID, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_shop_pricing_for_role_change(UUID, TEXT, TEXT) TO service_role;

-- ── I: global reprice trigger — 0 is a legal "unpriced" tier, don't reject it ──
CREATE OR REPLACE FUNCTION public.auto_update_shop_pricing_on_platform_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
    -- Only the customer price must be strictly positive; agent/dealer = 0 means
    -- "tier unpriced" (effective_owner_cost falls back to customer). Rejecting 0
    -- here blocked legitimate platform repricing of such packages.
    IF NEW.price <= 0 THEN
        RAISE EXCEPTION 'Invalid platform price detected';
    END IF;

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
$function$;
