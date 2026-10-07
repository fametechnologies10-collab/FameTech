-- supabase/migrations/20260809c_chain_credit_rpc.sql
-- =============================================================================
-- Chain-aware profit credit (spec §6, §3.2). Replaces the two-party body of
-- credit_shop_order_profits with a walk over shop_order_splits.
--
-- DOUBLE-CREDIT GUARD: when an order HAS splits rows, ancestors are credited from
-- shop_order_splits ONLY. shop_orders.parent_profit is a compatibility MIRROR of
-- the level-1 row and is NOT read in that case — reading both would double-credit.
--
-- LEGACY FALLBACK: orders created before shop_order_splits existed have
-- parent_shop_id/parent_profit and no splits row. Those are credited from the
-- legacy columns exactly as the old RPC did. The two sources are EITHER/OR, never
-- combined, which is what preserves the double-credit guarantee. This also covers
-- orders written by old code after this migration but before the new code deploys.
--
-- STATUS GUARD (preserved from 20260705c_money_core_security_fixes.sql, finding E):
-- the true baseline immediately before this migration is the STATUS-GUARDED version
-- of credit_shop_order_profits (20260705c, not the older 20260705 file), which closed
-- "no status guard -> an unauth charge-status replay could credit a refunded order."
-- Refunded/failed orders return success:true "not creditable" so they are never
-- (re-)credited. Check order matches 20260705c:245-250 EXACTLY: NOT FOUND -> "Not a
-- sub-agent order" -> status guard. The sub-agent-order check runs FIRST on purpose
-- (function-applicability before business-state, and it keeps a misrouted/replayed
-- call against a non-sub-agent order paging admins instead of being silently
-- swallowed by the status guard) — do not reorder these two checks.
--
-- Same signature + grants as before, so every existing caller is unchanged.
-- Idempotent per wallet, exactly as the original.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.credit_shop_order_profits(p_shop_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  -- Source selection is EITHER/OR (see header): splits when present, legacy
  -- columns otherwise. Never both — that is the double-credit guarantee.
  v_has_splits := EXISTS (SELECT 1 FROM public.shop_order_splits WHERE order_id = p_shop_order_id);

  IF NOT v_has_splits AND v_legacy_shop IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not a sub-agent order — use credit_shop_profit');
  END IF;

  -- PRESERVED FROM 20260705c (finding E): refunded/failed orders must NEVER be
  -- (re-)credited. Without this, an unauthenticated charge-status replay can credit
  -- a voided sale with real money. This guard predates the chain rewrite — do not
  -- drop it when regenerating this function. Placement is deliberate: it runs AFTER
  -- the "Not a sub-agent order" check, matching 20260705c:245-250 exactly, so a
  -- misrouted/replayed call against a non-sub-agent order still pages admins
  -- (success:false) instead of being silently swallowed as "not creditable" — do
  -- not hoist this earlier again, even though no wallet is touched either way.
  IF v_status IN ('refunded','failed') THEN
    RETURN jsonb_build_object('success', true, 'message', 'Order not creditable (status ' || v_status || ')');
  END IF;

  -- Lock the LEAF wallet first, then ancestors in ascending level order. A stable
  -- global order (leaf -> level 1 -> level 2) is what prevents deadlocks between
  -- two concurrent credits that share an ancestor.
  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_sub_owner_id, 0, 0) ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_sub_wallet_id FROM public.shop_wallets WHERE owner_id = v_sub_owner_id FOR UPDATE;

  -- 1. The selling leaf's own retail profit (0 markup is legal — skip, not an error).
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

  -- 2. Every ancestor. Source is either/or (see header): the splits rows when the
  --    order has them, else the legacy parent_* columns for a pre-migration order.
  --    The second branch's WHERE is false whenever v_has_splits is true, so the two
  --    can never both contribute.
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

    -- Per-wallet idempotency, exactly as the original two-party RPC.
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
    -- Retained for the existing log line in lib/shop-service.ts:202.
    'parent_amount', v_total_anc,
    'message', CASE
      WHEN NOT v_credited_sub AND v_credited_anc = 0 THEN 'Already credited'
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
