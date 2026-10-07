-- ============================================================================
-- 20260710e_refund_ussd_wallet.sql
-- Final-review fix (pre-enable blocker): refund_utility_wallet only accepted
-- payment_method='wallet', but USSD wallet-paid utility orders carry
-- 'ussd_wallet' (same main-wallet debit, user_id always set). Airtime's refund
-- RPC has no payment-method restriction, so this was a parity regression that
-- stranded failed USSD-wallet utility orders with no refund rail.
-- Widen the atomic claim + the disambiguation branch to both wallet methods.
-- Everything else is byte-identical to 20260709b (already in prod).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.refund_utility_wallet(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order record; v_ref text; v_wallet_id uuid;
BEGIN
  -- Atomic claim: only one caller ever refunds; guest orders never match (user_id IS NOT NULL guard).
  UPDATE public.utility_orders
     SET status = 'refunded', payment_status = 'refunded', updated_at = now()
   WHERE id = p_utility_order_id
     AND payment_method IN ('wallet','ussd_wallet')
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
    IF v_order.payment_method NOT IN ('wallet','ussd_wallet') THEN
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
         total_spent = GREATEST(0, total_spent - v_order.amount) WHERE id = v_wallet_id;

  RETURN jsonb_build_object('success', true, 'refunded', true, 'amount', v_order.amount);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', true, 'already_refunded', true);
END $$;

REVOKE ALL ON FUNCTION public.refund_utility_wallet(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_utility_wallet(uuid) TO service_role;
