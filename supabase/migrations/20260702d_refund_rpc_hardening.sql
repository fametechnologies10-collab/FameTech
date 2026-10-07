-- 20260702d_refund_rpc_hardening.sql
-- Post-review hardening of the refund RPCs from 20260702b:
--  * reverse_shop_profit: add required `description` (shop_wallet_transactions.description is NOT NULL —
--    the omission threw on every Paystack refund), add a completed-order guard, lock shop_orders FOR UPDATE.
--  * settle_shop_refund_to_owner: guard NULL/negative cost_price; scope the airtime mirror by shop_id.
--  * mark_shop_order_refunded: scope the airtime mirror by shop_id.

CREATE OR REPLACE FUNCTION public.reverse_shop_profit(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profit numeric; v_owner uuid; v_wallet_id uuid; v_status text;
BEGIN
  SELECT so.profit, so.status, sp.owner_id INTO v_profit, v_status, v_owner
    FROM public.shop_orders so JOIN public.shop_profiles sp ON sp.id = so.shop_id
    WHERE so.id = p_shop_order_id FOR UPDATE OF so;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  -- Never reverse profit on a legitimately delivered (completed) order.
  IF v_status = 'completed' THEN RETURN jsonb_build_object('ok',false,'error','cannot_reverse_completed'); END IF;

  SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN RETURN jsonb_build_object('ok',true,'already_reversed',true); END IF;

  IF EXISTS (SELECT 1 FROM public.shop_wallet_transactions
             WHERE shop_order_id = p_shop_order_id AND type = 'profit_reversal') THEN
    RETURN jsonb_build_object('ok',true,'already_reversed',true); END IF;

  INSERT INTO public.shop_wallet_transactions (shop_wallet_id, shop_order_id, type, amount, status, description)
    VALUES (v_wallet_id, p_shop_order_id, 'profit_reversal', COALESCE(v_profit,0), 'completed',
            'Profit reversal for refunded shop order ' || p_shop_order_id::text);
  UPDATE public.shop_wallets SET balance = balance - COALESCE(v_profit,0),
         total_earned = GREATEST(0, total_earned - COALESCE(v_profit,0)) WHERE id = v_wallet_id;
  RETURN jsonb_build_object('ok',true,'reversed',true,'amount',COALESCE(v_profit,0));
END; $$;

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
  IF v_so.cost_price IS NULL OR v_so.cost_price < 0 THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_cost_price'); END IF;

  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_so.shop_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','owner_not_found'); END IF;

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
  -- Scope the airtime mirror by shop_id + reference_code (avoids any SHOP-<ref> suffix collision across shops).
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE shop_id = v_so.shop_id
      AND reference_code IN (SELECT reference_code FROM public.orders WHERE shop_order_id = p_shop_order_id)
      AND status <> 'refunded';

  RETURN jsonb_build_object('ok',true,'settled',true,'amount',v_so.cost_price);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',true,'already_refunded',true);
END; $$;

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
    WHERE shop_id = v_so.shop_id
      AND reference_code IN (SELECT reference_code FROM public.orders WHERE shop_order_id = p_shop_order_id)
      AND status <> 'refunded';
  RETURN jsonb_build_object('ok',true,'refunded',true);
END; $$;

REVOKE ALL ON FUNCTION public.reverse_shop_profit(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_shop_refund_to_owner(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_shop_order_refunded(uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_shop_profit(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_shop_refund_to_owner(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_shop_order_refunded(uuid,uuid,text,boolean) TO service_role;
