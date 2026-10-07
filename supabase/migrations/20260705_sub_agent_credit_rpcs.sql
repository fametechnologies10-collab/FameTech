-- supabase/migrations/20260705_sub_agent_credit_rpcs.sql
-- =============================================================================
-- Sub-Agents money core (spec §7.4) — the two atomic credit RPCs.
--
--  credit_shop_order_profits(order_id) : storefront mode — credits the SUB's retail
--    profit AND the LEAD's wholesale margin for one shop_orders row, in one
--    transaction, idempotent PER WALLET. (The legacy credit_shop_profit idempotency
--    key is wallet-agnostic — (shop_order_id, type) — which would let the sub's
--    credit block the Lead's; this RPC scopes the check by shop_wallet_id.)
--
--  credit_lead_margin(reference, upline_shop_id, amount) : wallet mode — a sub buys
--    data from their own wallet at the Lead's sub_price; the Lead earns
--    (sub_price − owner_cost). Idempotent on (credit_source, order_reference) with a
--    partial UNIQUE index as the concurrency backstop.
--
-- Both are SECURITY DEFINER, service_role-only (clients can never mint credits).
-- =============================================================================

-- 0. Wallet-mode idempotency key: a dedicated reference column + unique backstop.
ALTER TABLE public.shop_wallet_transactions
  ADD COLUMN IF NOT EXISTS order_reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_wallet_tx_source_ref
  ON public.shop_wallet_transactions (credit_source, order_reference)
  WHERE order_reference IS NOT NULL;

-- 1. Storefront mode: two-party credit for one sub shop order.
CREATE OR REPLACE FUNCTION public.credit_shop_order_profits(p_shop_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profit         DECIMAL;   -- sub's retail markup (may be 0 — no-markup default)
  v_parent_profit  DECIMAL;   -- Lead's wholesale margin
  v_parent_shop_id UUID;
  v_sub_owner_id   UUID;
  v_parent_owner_id UUID;
  v_network        TEXT;
  v_package_size   TEXT;
  v_guest_phone    TEXT;
  v_sub_wallet_id  UUID;
  v_parent_wallet_id UUID;
  v_credited_sub    BOOLEAN := false;
  v_credited_parent BOOLEAN := false;
  v_existing UUID;
BEGIN
  SELECT so.profit, so.parent_profit, so.parent_shop_id,
         sp.owner_id, pp.owner_id,
         so.network, so.package_size, so.guest_phone
  INTO   v_profit, v_parent_profit, v_parent_shop_id,
         v_sub_owner_id, v_parent_owner_id,
         v_network, v_package_size, v_guest_phone
  FROM public.shop_orders so
  JOIN public.shop_profiles sp ON so.shop_id = sp.id
  LEFT JOIN public.shop_profiles pp ON so.parent_shop_id = pp.id
  WHERE so.id = p_shop_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  IF v_parent_shop_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not a sub-agent order — use credit_shop_profit');
  END IF;

  -- Ensure both wallets exist, then lock rows in a STABLE ORDER (sub first, then
  -- parent) so two concurrent calls cannot deadlock.
  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_sub_owner_id, 0, 0), (v_parent_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  SELECT id INTO v_sub_wallet_id    FROM public.shop_wallets WHERE owner_id = v_sub_owner_id    FOR UPDATE;
  SELECT id INTO v_parent_wallet_id FROM public.shop_wallets WHERE owner_id = v_parent_owner_id FOR UPDATE;

  -- 1a. Sub's retail profit (skip at 0 markup — nothing to credit, not an error)
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

  -- 1b. Lead's wholesale margin
  IF COALESCE(v_parent_profit, 0) > 0 THEN
    SELECT id INTO v_existing FROM public.shop_wallet_transactions
    WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND shop_wallet_id = v_parent_wallet_id;
    IF v_existing IS NULL THEN
      UPDATE public.shop_wallets
      SET balance = balance + v_parent_profit, total_earned = total_earned + v_parent_profit, updated_at = NOW()
      WHERE id = v_parent_wallet_id;

      INSERT INTO public.shop_wallet_transactions
        (shop_wallet_id, shop_order_id, type, amount, description, status, credit_source)
      VALUES
        (v_parent_wallet_id, p_shop_order_id, 'profit', v_parent_profit,
         'Network sale: ' || v_network || ' ' || v_package_size || ' via sub-agent', 'completed', 'order_parent');
      v_credited_parent := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'credited_sub', v_credited_sub, 'sub_amount', COALESCE(v_profit, 0),
    'credited_parent', v_credited_parent, 'parent_amount', COALESCE(v_parent_profit, 0),
    'message', CASE
      WHEN NOT v_credited_sub AND NOT v_credited_parent THEN 'Already credited'
      ELSE 'Credited'
    END
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_shop_order_profits(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_shop_order_profits(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_shop_order_profits(UUID) TO service_role;

-- 2. Wallet mode: credit the Lead's margin on a sub's wallet-funded purchase.
CREATE OR REPLACE FUNCTION public.credit_lead_margin(
  p_order_reference TEXT,
  p_upline_shop_id  UUID,
  p_amount          NUMERIC,
  p_description     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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

  -- Idempotency: the tx insert hits uq_shop_wallet_tx_source_ref on replay.
  -- Insert FIRST, then update the balance — a duplicate aborts before any credit.
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
$$;

REVOKE ALL ON FUNCTION public.credit_lead_margin(TEXT, UUID, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_lead_margin(TEXT, UUID, NUMERIC, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_lead_margin(TEXT, UUID, NUMERIC, TEXT) TO service_role;

-- 3. Config seeds (same home as data_profit_max_*: shop_global_settings)
INSERT INTO public.shop_global_settings (key, value) VALUES
  ('sub_min_margin', '0.01'),
  ('sub_markup_ceiling_default', '10')
ON CONFLICT (key) DO NOTHING;
