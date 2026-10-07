-- 20260702b_refund_rpcs.sql
-- Idempotent refund RPCs. All SECURITY DEFINER, service_role-only.
-- Idempotency: SELECT ... FOR UPDATE row lock + status re-check + (for wallet ledgers)
-- the unique index uq_wallet_tx_refund_reference on (reference) WHERE source='refund' AND reference LIKE 'REFUND-%'.

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
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0) RETURNING id INTO v_wallet_id; END IF;

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

-- ── Reverse a shop owner's already-credited profit (Paystack refund path) ────
CREATE OR REPLACE FUNCTION public.reverse_shop_profit(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END; $$;

-- ── Mark shop order refunded (Paystack path) — external refund already done ───
CREATE OR REPLACE FUNCTION public.mark_shop_order_refunded(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text, p_reverse_profit boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END; $$;

-- ── Lock down: service_role only ─────────────────────────────────────────────
DO $$ DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'refund_order_wallet(uuid,uuid,text)','refund_airtime_wallet(uuid,uuid,text)',
    'reverse_shop_profit(uuid,uuid,text)','settle_shop_refund_to_owner(uuid,uuid,text)',
    'mark_shop_order_refunded(uuid,uuid,text,boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role;', fn);
  END LOOP;
END $$;
