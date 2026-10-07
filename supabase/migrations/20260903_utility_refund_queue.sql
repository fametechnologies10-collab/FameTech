-- 20260903_utility_refund_queue.sql
-- Branch 1: widen refund_utility_wallet's payment_method match to cover
-- ussd_wallet/ussd_momo for registered non-shop users, and add the manual
-- refund queue for everything that still doesn't qualify (guest/shop-
-- attributed orders — storefront hubtel_receive, ussd_shop, guest ussd).

CREATE TABLE IF NOT EXISTS public.utility_refund_queue (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    utility_order_id   uuid NOT NULL REFERENCES public.utility_orders(id),
    source             text NOT NULL,
    biller             text NOT NULL,
    amount             numeric NOT NULL,
    momo_number        text,
    shop_id            uuid REFERENCES public.shop_profiles(id),
    user_id            uuid REFERENCES public.users(id), -- carried so Task 3's SMS gate can
        -- match "storefront/ussd_shop, no user_id" exactly, not just source — a registered
        -- user checking out through their OWN shop's ussd_shop flow still lands here
        -- (shop_id takes precedence) but must NOT get the refund SMS.
    reason             text,
    status             text NOT NULL DEFAULT 'pending', -- pending | refunded | dismissed
    refunded_by        uuid REFERENCES public.users(id),
    refunded_at        timestamptz,
    refund_reference   text,
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- One queue row per order — the admin Refund button is idempotent: a second
-- click on an already-queued order must not pile up duplicate queue rows.
CREATE UNIQUE INDEX IF NOT EXISTS utility_refund_queue_order_uniq
    ON public.utility_refund_queue (utility_order_id);

CREATE INDEX IF NOT EXISTS utility_refund_queue_status_idx
    ON public.utility_refund_queue (status, created_at DESC);

ALTER TABLE public.utility_refund_queue ENABLE ROW LEVEL SECURITY;
-- No public policies — service_role/admin tooling only, mirrors ussd_refund_queue.

-- ── Widen refund_utility_wallet's claim guard ────────────────────────────────
-- Was: payment_method = 'wallet'. Now also matches ussd_wallet/ussd_momo, but
-- ONLY for non-shop orders (shop_id IS NULL) — a shop-attributed order must
-- never be wallet-refunded to the BUYER, since the shop (not the buyer) is
-- the commission partner on that order. The existing user_id IS NOT NULL
-- guard already excludes every guest order (storefront always inserts
-- user_id: null; a guest ussd order likewise has no user_id).
CREATE OR REPLACE FUNCTION public.refund_utility_wallet(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order record; v_ref text; v_wallet_id uuid;
BEGIN
  UPDATE public.utility_orders
     SET status = 'refunded', payment_status = 'refunded', updated_at = now()
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
         total_spent = GREATEST(0, total_spent - v_order.amount) WHERE id = v_wallet_id;

  RETURN jsonb_build_object('success', true, 'refunded', true, 'amount', v_order.amount);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', true, 'already_refunded', true);
END $$;

REVOKE ALL ON FUNCTION public.refund_utility_wallet(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_utility_wallet(uuid) TO service_role;
REVOKE ALL ON public.utility_refund_queue FROM PUBLIC, anon, authenticated;
