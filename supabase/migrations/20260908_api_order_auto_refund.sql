-- supabase/migrations/20260908_api_order_auto_refund.sql
-- API Order Auto-Refund on Definitive Failure. Adds the refund-audit columns
-- utility_orders needs (mirroring airtime_orders' existing refund_reason/
-- refunded_by/refunded_at), widens refund_utility_wallet to accept and
-- persist them (backward-compatible: new params default NULL, so the
-- existing single-arg call site in lib/utility-fulfillment.ts's
-- manualRefundUtility keeps working unmodified), and adds new_balance to
-- both refund RPCs' success return so callers don't need a second query.
--
-- NOTE on refund_airtime_wallet: live (confirmed via
-- pg_get_functiondef before this migration) still had the pre-20260714-fix
-- get-or-create pattern (SELECT ... FOR UPDATE; IF NULL THEN INSERT) despite
-- 20260714_refund_wallet_race_fix being recorded as applied in migration
-- history — a drift between recorded history and actual live state. This
-- migration's CREATE OR REPLACE restores the race-safe
-- `INSERT ... ON CONFLICT (user_id) DO NOTHING` pattern (matching the repo's
-- 20260714 migration file) in addition to the intended new_balance addition,
-- so live now matches repo intent again.
--
-- NOTE on refund_utility_wallet: CREATE OR REPLACE with a WIDER argument
-- list does NOT replace the existing single-arg function in Postgres — it
-- creates a second overload, since functions are identified by full
-- signature (name + arg types), not just name. That left both
-- refund_utility_wallet(uuid) and refund_utility_wallet(uuid,uuid,text) live
-- simultaneously, making any 1-arg call ambiguous and breaking the existing
-- manualRefundUtility call site. The old single-arg overload is dropped
-- below so only the widened, default-backward-compatible version remains.

ALTER TABLE public.utility_orders
  ADD COLUMN IF NOT EXISTS refund_reason text,
  ADD COLUMN IF NOT EXISTS refunded_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- ── refund_utility_wallet — widened, CREATE OR REPLACE ──────────────────────
CREATE OR REPLACE FUNCTION public.refund_utility_wallet(
  p_utility_order_id uuid, p_actor_id uuid DEFAULT NULL, p_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order record; v_ref text; v_wallet_id uuid; v_new_balance numeric;
BEGIN
  UPDATE public.utility_orders
     SET status = 'refunded', payment_status = 'refunded',
         refunded_by = p_actor_id, refunded_at = now(), refund_reason = p_reason,
         updated_at = now()
   WHERE id = p_utility_order_id
     AND payment_method IN ('wallet','ussd_wallet','ussd_momo')
     AND shop_id IS NULL
     AND status IN ('pending','failed')
     AND payment_status = 'paid'
     AND user_id IS NOT NULL
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    SELECT * INTO v_order FROM public.utility_orders WHERE id = p_utility_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
    END IF;
    IF v_order.status = 'refunded' OR v_order.payment_status = 'refunded' THEN
      RETURN jsonb_build_object('success', true, 'already_refunded', true);
    END IF;
    IF v_order.user_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'No wallet owner');
    END IF;
    IF v_order.shop_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_wallet_payment');
    END IF;
    IF v_order.payment_method NOT IN ('wallet','ussd_wallet','ussd_momo') THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_wallet_payment');
    END IF;
    IF v_order.payment_status <> 'paid' THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_paid', 'payment_status', v_order.payment_status);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'not_refundable', 'status', v_order.status);
  END IF;

  v_ref := 'REFUND-' || v_order.reference_code;

  INSERT INTO public.wallets (user_id, balance) VALUES (v_order.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_order.user_id FOR UPDATE;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_order.user_id, 'credit', v_order.amount,
            'Refund for utility order ' || v_order.reference_code, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_order.amount,
         total_spent = GREATEST(0, total_spent - v_order.amount) WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

  RETURN jsonb_build_object('success', true, 'refunded', true, 'amount', v_order.amount, 'new_balance', v_new_balance);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', true, 'already_refunded', true);
END $$;

-- Drop the pre-existing single-arg overload — see note at top of file.
DROP FUNCTION IF EXISTS public.refund_utility_wallet(uuid);

-- ── refund_airtime_wallet — additive new_balance on the success path only ───
CREATE OR REPLACE FUNCTION public.refund_airtime_wallet(
  p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_o public.airtime_orders%ROWTYPE; v_ref text; v_wallet_id uuid; v_new_balance numeric;
BEGIN
  SELECT * INTO v_o FROM public.airtime_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
  IF v_o.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_o.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status); END IF;
  IF v_o.user_id IS NULL OR v_o.shop_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','not_retail_airtime'); END IF;

  v_ref := 'REFUND-AIRTIME-' || p_order_id::text;
  INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.total_paid,
            'Refund for airtime order ' || v_o.reference_code, v_ref, 'refund', 'completed');
  UPDATE public.wallets SET balance = balance + v_o.total_paid,
         total_spent = GREATEST(0, total_spent - v_o.total_paid) WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE id = p_order_id;
  RETURN jsonb_build_object('ok',true,'refunded',true,'amount',v_o.total_paid,'new_balance',v_new_balance);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok',true,'already_refunded',true);
END $$;

REVOKE ALL ON FUNCTION public.refund_utility_wallet(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_airtime_wallet(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_utility_wallet(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_airtime_wallet(uuid, uuid, text) TO service_role;
