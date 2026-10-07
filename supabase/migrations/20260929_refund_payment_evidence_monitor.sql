-- AUDIT F1 (option A — MONITORING ONLY, never blocks a refund).
-- refund_order_wallet credits an order's price back to the user's wallet. The 2026-09-24 fix
-- removed the root cause (clients can no longer create orders, so a forged unpaid order can't
-- exist), so blocking refunds on a payment-evidence check would only add risk. Instead, after a
-- successful refund, if the order has NO recognisable payment evidence, write a security_events
-- row ('refund_without_payment_trace') for admin review.
--
-- Evidence rule — validated against every order refunded in the 60 days to 2026-09-29
-- (376 orders: web/api/ussd, momo/wallet): 0 false positives. Evidence is ANY of:
--   * a wallet debit for this user whose reference is the order's reference_code or id, the
--     USSD wallet form 'USSD-WALLET-<rest>', 'RETRY-<order id>…', or whose description names
--     the reference_code;
--   * an admin retry that created this order and charged something (order_retry_attempts);
--   * a paid Hubtel USSD session that produced it (ussd_pending_orders fulfilled with a Hubtel id).

CREATE OR REPLACE FUNCTION public.order_has_payment_evidence(p_order public.orders)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT
        EXISTS (
            SELECT 1 FROM public.wallet_transactions d
             WHERE d.user_id = p_order.user_id
               AND d.type = 'debit'
               AND (   d.reference IN (p_order.reference_code, p_order.id::text,
                                       'USSD-WALLET-' || substr(p_order.reference_code, 6))
                    OR d.reference LIKE 'RETRY-' || p_order.id::text || '%'
                    OR d.description ILIKE '%' || replace(replace(replace(p_order.reference_code, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'))
     OR EXISTS (
            SELECT 1 FROM public.order_retry_attempts a
             WHERE a.new_order_id = p_order.id AND coalesce(a.charged_amount, 0) > 0)
     OR EXISTS (
            SELECT 1 FROM public.ussd_pending_orders u
             WHERE u.hubtel_order_id IS NOT NULL AND u.status = 'fulfilled'
               AND ('USSD-DATA-' || upper(replace(u.session_id, '-', ''))) = p_order.reference_code);
$function$;

REVOKE EXECUTE ON FUNCTION public.order_has_payment_evidence(public.orders) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_has_payment_evidence(public.orders) TO service_role;

-- refund_order_wallet: body identical to the live definition, plus the monitoring block before
-- the final RETURN. The block runs in its own sub-transaction and swallows every error, so a
-- monitoring failure can never undo or fail the refund.
CREATE OR REPLACE FUNCTION public.refund_order_wallet(p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_o public.orders%ROWTYPE;
    v_ref text;
    v_wallet_id uuid;
BEGIN
    SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
    IF v_o.payment_status = 'refunded' OR v_o.status = 'refunded' THEN
        RETURN jsonb_build_object('ok',true,'already_refunded',true);
    END IF;
    IF v_o.status NOT IN ('pending','processing','failed') THEN
        RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status);
    END IF;
    IF v_o.user_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','no_wallet_user'); END IF;

    v_ref := 'REFUND-ORDER-' || p_order_id::text;
    SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;
    IF v_wallet_id IS NULL THEN
        INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0) RETURNING id INTO v_wallet_id;
    END IF;

    INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.price, 'Refund for order ' || v_o.reference_code, v_ref, 'refund', 'completed');
    UPDATE public.wallets SET balance = balance + v_o.price, total_spent = GREATEST(0, total_spent - v_o.price) WHERE id = v_wallet_id;
    UPDATE public.orders SET status='refunded', payment_status='refunded', refunded_by=p_actor_id,
        refunded_at=now(), refund_reason=p_reason, updated_at=now() WHERE id = p_order_id;

    -- F1 monitoring (never blocks, never fails the refund).
    BEGIN
        IF NOT public.order_has_payment_evidence(v_o) THEN
            INSERT INTO public.security_events (event_type, reference, expected_amount, order_type, detail)
            VALUES ('refund_without_payment_trace', v_o.reference_code, v_o.price, 'data',
                    jsonb_build_object('order_id', v_o.id, 'user_id', v_o.user_id, 'source', v_o.source,
                                       'payment_method', v_o.payment_method, 'refunded_by', p_actor_id,
                                       'refund_reference', v_ref));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object('ok',true,'refunded',true,'amount',v_o.price);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok',true,'already_refunded',true);
END;
$function$;

-- CREATE OR REPLACE keeps existing grants; re-assert server-only anyway.
REVOKE EXECUTE ON FUNCTION public.refund_order_wallet(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_order_wallet(uuid, uuid, text) TO service_role;
