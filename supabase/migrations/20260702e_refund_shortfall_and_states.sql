-- 20260702e_refund_shortfall_and_states.sql
-- Paystack refund robustness:
--  * reverse_shop_profit now REPORTS a `shortfall` (profit the owner had already withdrawn) and
--    allows the shop wallet to go negative = a recorded debt recovered from future earnings.
--  * mark_shop_order_refunded surfaces that shortfall so the webhook can alert admins.
-- (refund_method state values 'paystack_failed'/'paystack_attention' are written by the webhook.)

CREATE OR REPLACE FUNCTION public.reverse_shop_profit(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profit numeric; v_owner uuid; v_wallet_id uuid; v_status text; v_bal numeric; v_shortfall numeric;
BEGIN
  SELECT so.profit, so.status, sp.owner_id INTO v_profit, v_status, v_owner
    FROM public.shop_orders so JOIN public.shop_profiles sp ON sp.id = so.shop_id
    WHERE so.id = p_shop_order_id FOR UPDATE OF so;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_status = 'completed' THEN RETURN jsonb_build_object('ok',false,'error','cannot_reverse_completed'); END IF;

  SELECT id, balance INTO v_wallet_id, v_bal FROM public.shop_wallets WHERE owner_id = v_owner FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'already_reversed',true,'shortfall',COALESCE(v_profit,0)); END IF;

  IF EXISTS (SELECT 1 FROM public.shop_wallet_transactions
             WHERE shop_order_id = p_shop_order_id AND type = 'profit_reversal') THEN
    RETURN jsonb_build_object('ok',true,'already_reversed',true,'shortfall',0); END IF;

  v_profit := COALESCE(v_profit, 0);
  -- Shortfall = the portion of the profit the owner had already withdrawn (current balance can't cover).
  v_shortfall := GREATEST(0, v_profit - GREATEST(v_bal, 0));

  INSERT INTO public.shop_wallet_transactions (shop_wallet_id, shop_order_id, type, amount, status, description)
    VALUES (v_wallet_id, p_shop_order_id, 'profit_reversal', v_profit, 'completed',
            'Profit reversal for refunded shop order ' || p_shop_order_id::text
            || CASE WHEN v_shortfall > 0 THEN ' (shortfall ' || round(v_shortfall, 2)::text || ' — owner already withdrew; balance now owed)' ELSE '' END);
  -- Allow the balance to go NEGATIVE = the owner owes this; recovered from future profit credits.
  UPDATE public.shop_wallets SET balance = balance - v_profit,
         total_earned = GREATEST(0, total_earned - v_profit) WHERE id = v_wallet_id;
  RETURN jsonb_build_object('ok',true,'reversed',true,'amount',v_profit,'shortfall',v_shortfall,'new_balance',v_bal - v_profit);
END; $$;

CREATE OR REPLACE FUNCTION public.mark_shop_order_refunded(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text, p_reverse_profit boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_so public.shop_orders%ROWTYPE; v_rev jsonb; v_shortfall numeric := 0;
BEGIN
  SELECT * INTO v_so FROM public.shop_orders WHERE id = p_shop_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_so.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true,'shortfall',0); END IF;
  IF v_so.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_so.status); END IF;

  IF p_reverse_profit THEN
    v_rev := public.reverse_shop_profit(p_shop_order_id, p_actor_id, p_reason);
    v_shortfall := COALESCE((v_rev->>'shortfall')::numeric, 0);
  END IF;

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
  RETURN jsonb_build_object('ok',true,'refunded',true,'shortfall',v_shortfall);
END; $$;

REVOKE ALL ON FUNCTION public.reverse_shop_profit(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_shop_order_refunded(uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_shop_profit(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_shop_order_refunded(uuid,uuid,text,boolean) TO service_role;
