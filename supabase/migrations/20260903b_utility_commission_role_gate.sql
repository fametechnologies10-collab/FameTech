-- 20260903b_utility_commission_role_gate.sql
-- Branch 2: restrict utility commission EARNING (not API key issuance) to
-- agent/dealer roles, checked at credit time (not purchase time) so the
-- existing role-expiry system's demotions/promotions are always honored.
-- Shop-attributed orders (shop_id branch) are UNCHANGED — no role check is
-- added there; the storefront enable-toggle is the sole enforcement point
-- for shop-attributed commission (see app/api/shop/utility-settings/route.ts).

-- ── credit_commission_wallet — MODIFIED twice over its 20260901c version:
--    (1) claim widened from source = 'api' to source IN ('api','dashboard')
--        so one function serves both non-shop sources;
--    (2) NEW role check at credit time — not agent/dealer means the platform
--        keeps 100%, matching the existing "no partner" fallback exactly (the
--        claim above has already committed, so the order stays correctly
--        marked credited/done — there is simply no partner share to pay).
CREATE OR REPLACE FUNCTION public.credit_commission_wallet(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  IF v_role NOT IN ('agent', 'dealer') THEN
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
END $$;

-- ── credit_utility_commission — MODIFIED: the delegating ELSIF now matches
--    source IN ('api','dashboard') instead of source = 'api'. The shop_id
--    branch below it is copied VERBATIM from 20260901c — unchanged.
CREATE OR REPLACE FUNCTION public.credit_utility_commission(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;

REVOKE ALL ON FUNCTION public.credit_commission_wallet(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.credit_utility_commission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_commission_wallet(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_utility_commission(uuid) TO service_role;
