-- ============================================================================
-- 20260714_refund_wallet_race_fix.sql
-- Money-safety fix (prod debt surfaced during the utility-bills build).
--
-- BUG: refund_order_wallet / refund_airtime_wallet / settle_shop_refund_to_owner
-- all did a "SELECT ... FOR UPDATE; IF NULL THEN INSERT" get-or-create on the
-- destination wallet. When the target user/owner has NO wallet row yet and TWO
-- refunds for DIFFERENT orders of that same user run concurrently, both SELECTs
-- see NULL (nothing to lock — the row doesn't exist), both INSERT, and the loser
-- hits a unique_violation on wallets.user_id. The function's
-- `EXCEPTION WHEN unique_violation` handler then rolls the WHOLE transaction back
-- (including the order-status UPDATE) and returns already_refunded=true — so the
-- caller is told the refund succeeded while NO money was credited and the order
-- stays un-refunded. Silent money loss.
--
-- FIX: replace get-or-create with `INSERT ... ON CONFLICT (user_id) DO NOTHING`
-- followed by `SELECT ... FOR UPDATE`. Now the concurrent INSERT no-ops instead
-- of raising, both callers lock the same (now-existing) wallet row and serialize
-- correctly. This mirrors the fix already shipped for refund_utility_wallet
-- (20260709b / 20260710e). The `EXCEPTION WHEN unique_violation` handler is KEPT
-- — it is still the legitimate idempotency backstop for the refund-reference
-- unique index (a genuine duplicate refund), which is the only unique_violation
-- that can now fire. Everything else in each function is byte-identical to
-- 20260702b (already in prod). CREATE OR REPLACE preserves grants; the
-- REVOKE/GRANT block is re-asserted at the end for defence in depth.
-- ============================================================================

-- ── Retail data/mashup-data order refund → buyer wallet ──────────────────────
CREATE OR REPLACE FUNCTION public.refund_order_wallet(
  p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  v_ref := 'REFUND-ORDER-' || p_order_id::text;
  -- Race-safe get-or-create (see file header).
  INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;

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
END; $$;

-- ── Retail airtime/mashup-airtime order refund → buyer wallet ────────────────
CREATE OR REPLACE FUNCTION public.refund_airtime_wallet(
  p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_o public.airtime_orders%ROWTYPE; v_ref text; v_wallet_id uuid;
BEGIN
  SELECT * INTO v_o FROM public.airtime_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
  IF v_o.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_o.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status); END IF;
  IF v_o.user_id IS NULL OR v_o.shop_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','not_retail_airtime'); END IF;

  v_ref := 'REFUND-AIRTIME-' || p_order_id::text;
  -- Race-safe get-or-create (see file header).
  INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.total_paid,
            'Refund for airtime order ' || v_o.reference_code, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_o.total_paid,
         total_spent = GREATEST(0, total_spent - v_o.total_paid) WHERE id = v_wallet_id;
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE id = p_order_id;
  RETURN jsonb_build_object('ok',true,'refunded',true,'amount',v_o.total_paid);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',true,'already_refunded',true);
END; $$;

-- ── Settle shop refund to owner's PERSONAL wallet at COST (profit KEPT) ───────
CREATE OR REPLACE FUNCTION public.settle_shop_refund_to_owner(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  -- Race-safe get-or-create (see file header).
  INSERT INTO public.wallets (user_id, balance) VALUES (v_owner, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_owner FOR UPDATE;

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
END; $$;

-- ── Re-assert lock-down: service_role only (CREATE OR REPLACE preserves grants; belt-and-braces) ──
DO $$ DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'refund_order_wallet(uuid,uuid,text)','refund_airtime_wallet(uuid,uuid,text)',
    'settle_shop_refund_to_owner(uuid,uuid,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role;', fn);
  END LOOP;
END $$;
