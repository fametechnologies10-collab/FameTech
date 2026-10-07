-- Security-audit fix pass for Branch 2 (utility commission eligibility).
--
-- 1. CRITICAL: protect_shop_admin_columns() never pinned utilities_enabled, so an
--    authenticated shop owner could PATCH shop_profiles directly via the Supabase REST API
--    (shop_profiles_update_combined RLS policy allows self-updates; the authenticated grant
--    has no column restriction) and self-enable utility commission eligibility, bypassing the
--    agent/dealer role gate in app/api/shop/utility-settings/route.ts entirely.
-- 2. HIGH: credit_commission_wallet's role check used `v_role NOT IN ('agent','dealer')`,
--    which evaluates to NULL (not TRUE) when v_role is NULL, and PL/pgSQL treats a NULL IF
--    condition as false — falling through the guard and paying commission to a NULL-role
--    buyer. Replaced with a null-safe, fail-closed `IS DISTINCT FROM` condition.
-- 3. Documentation: credit_utility_commission's claim/unclaim/re-claim delegation to
--    credit_commission_wallet is only safe because both steps run inside the same PL/pgSQL
--    invocation/transaction. Expanded the comment to make that invariant explicit.

-- 1. CRITICAL — pin utilities_enabled alongside the other admin-only shop_profiles columns.
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
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. HIGH — fail-closed, null-safe role check.
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
END $$;

-- 3. Documentation — expand the claim/unclaim/re-claim comment to make the single-transaction
--    invariant explicit. No statement changes.
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
END $$;

REVOKE ALL ON FUNCTION public.credit_commission_wallet(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.credit_utility_commission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_commission_wallet(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_utility_commission(uuid) TO service_role;
