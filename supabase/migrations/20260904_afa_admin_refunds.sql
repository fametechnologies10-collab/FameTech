-- ============================================================
-- Admin AFA refunds: distinct status + two refund RPCs
-- ============================================================

-- 1. Widen status to add 'refunded' — additive, every existing value kept.
-- Distinct from 'cancelled' so a refund never crosses the existing
-- cancelled-triggers-profit-reversal logic in the status PATCH route.
ALTER TABLE public.afa_orders DROP CONSTRAINT IF EXISTS afa_orders_status_check;
ALTER TABLE public.afa_orders ADD CONSTRAINT afa_orders_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text]));

-- 2. Shop-linked AFA refund: credit COST ONLY to the shop owner's PERSONAL
-- retail wallet (public.wallets — NOT shop_wallets). Profit already credited
-- via credit_shop_afa_profit into shop_wallets is deliberately NOT reversed,
-- matching settle_shop_refund_to_owner's behavior for shop_orders exactly
-- ("same as a failed order" — the owner keeps their markup, refunds the
-- guest themselves out of band, we cover the platform's cost share).
CREATE OR REPLACE FUNCTION public.settle_afa_refund_to_owner(
    p_afa_order_id uuid,
    p_actor_id uuid,
    p_reason text DEFAULT NULL::text
)
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
$function$;

REVOKE EXECUTE ON FUNCTION public.settle_afa_refund_to_owner(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.settle_afa_refund_to_owner(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.settle_afa_refund_to_owner(uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_afa_refund_to_owner(uuid, uuid, text) TO service_role;

-- 3. Non-shop, wallet-paid AFA refund: credit the ORIGINAL applicant's wallet
-- back the amount actually debited. Applies to web/api (always wallet) and
-- USSD orders where payment_method = 'wallet'.
CREATE OR REPLACE FUNCTION public.refund_afa_order_wallet(
    p_afa_order_id uuid,
    p_actor_id uuid,
    p_reason text DEFAULT NULL::text
)
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
$function$;

REVOKE EXECUTE ON FUNCTION public.refund_afa_order_wallet(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_afa_order_wallet(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.refund_afa_order_wallet(uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.refund_afa_order_wallet(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
