-- supabase/migrations/20260707_number_registration.sql
-- =============================================================================
-- MTN Number Registration + 'queued' order status.
--
-- New supplier (DataKazina) rule: MTN recipient numbers must be pre-registered
-- with the supplier before they can receive data. Unregistered MTN numbers are
-- held in a new 'queued' order status (invisible to all fulfillment machinery),
-- exported to the supplier as Excel, and only released to 'pending' (→ existing
-- auto-fulfill cron) after the supplier confirms registration.
--
-- Ships INERT: the gate toggle 'number_registration_gate_enabled' seeds FALSE.
-- While off, orders flow exactly as today; new MTN numbers are still tracked.
--
-- CRITICAL (requirement #3): the release path flips ONLY status='queued' rows to
-- 'pending'. A queued order the customer already refunded is status='refunded',
-- so it is NEVER re-activated — the refund stands and it is never re-fulfilled.
-- =============================================================================

-- ── 0. Canonical Ghana phone normalizer (shared by gate + release) ───────────
-- orders.phone_number / shop_orders.guest_phone store 0XXXXXXXXX OR 233XXXXXXXXX.
-- number_registrations stores the canonical 0XXXXXXXXX. This IMMUTABLE helper
-- lets the release UPDATE match either stored format against the canonical list.
CREATE OR REPLACE FUNCTION public.normalize_gh_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN d IS NULL THEN NULL
    WHEN length(d) = 12 AND left(d, 3) = '233' THEN '0' || substring(d FROM 4)
    WHEN length(d) = 10 AND left(d, 1) = '0'   THEN d
    ELSE NULL
  END
  FROM (SELECT regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g') AS d) s
$$;
-- Least-privilege: only server-side callers need this. The SECURITY DEFINER RPCs
-- below call it as their definer, so restricting to service_role is sufficient.
REVOKE ALL ON FUNCTION public.normalize_gh_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_gh_phone(text) TO service_role;

-- ── 1. Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.number_registration_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename       text NOT NULL,
  network        text NOT NULL DEFAULT 'MTN',
  number_count   integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted', 'confirmed')),
  idempotency_key text UNIQUE,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by   uuid,
  confirmed_at   timestamptz
);

CREATE TABLE IF NOT EXISTS public.number_registrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  text NOT NULL UNIQUE,            -- canonical 0XXXXXXXXX
  network       text NOT NULL DEFAULT 'MTN',
  status        text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'submitted', 'registered')),
  batch_id      uuid REFERENCES public.number_registration_batches(id) ON DELETE SET NULL,
  source        text NOT NULL DEFAULT 'order'
                  CHECK (source IN ('backfill', 'order', 'admin')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  registered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_number_registrations_status  ON public.number_registrations(status);
CREATE INDEX IF NOT EXISTS idx_number_registrations_batch   ON public.number_registrations(batch_id);

-- RLS: admin/sub-admin only (mirrors phone_blacklist). Gate lookups use the
-- service-role client which bypasses RLS; there is no user-facing read path.
ALTER TABLE public.number_registration_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_registrations         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nr_batches_admin_only ON public.number_registration_batches;
CREATE POLICY nr_batches_admin_only ON public.number_registration_batches
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin','sub-admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin','sub-admin')));

DROP POLICY IF EXISTS nr_registrations_admin_only ON public.number_registrations;
CREATE POLICY nr_registrations_admin_only ON public.number_registrations
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin','sub-admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin','sub-admin')));

REVOKE ALL ON public.number_registration_batches FROM anon;
REVOKE ALL ON public.number_registrations         FROM anon;

-- ── 2. Add 'queued' to order status CHECK constraints ────────────────────────
ALTER TABLE public.orders       DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders       ADD  CONSTRAINT orders_status_check
  CHECK (status IN ('pending','queued','processing','completed','failed','refunded'));

ALTER TABLE public.shop_orders  DROP CONSTRAINT IF EXISTS shop_orders_status_check;
ALTER TABLE public.shop_orders  ADD  CONSTRAINT shop_orders_status_check
  CHECK (status IN ('pending','queued','processing','completed','failed','refunded'));

-- ── 3. Release RPC: mark a batch registered → release its queued orders ──────
-- Flips batch→confirmed, its numbers→registered, and ALL matching orders that
-- are STILL 'queued' → 'pending'. Refunded/completed/etc. are never touched.
CREATE OR REPLACE FUNCTION public.release_registration_batch(
  p_batch_id uuid,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_batch   public.number_registration_batches%ROWTYPE;
  v_orders  integer := 0;
  v_shop    integer := 0;
BEGIN
  SELECT * INTO v_batch FROM public.number_registration_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'batch_not_found');
  END IF;

  -- Mark the batch and its numbers registered (idempotent — safe to re-run).
  UPDATE public.number_registration_batches
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = p_actor_id
   WHERE id = p_batch_id;

  UPDATE public.number_registrations
     SET status = 'registered', registered_at = now()
   WHERE batch_id = p_batch_id AND status <> 'registered';

  -- Release queued retail/mirror orders. status='queued' filter => refunded rows skipped.
  UPDATE public.orders o
     SET status = 'pending', updated_at = now()
   WHERE o.status = 'queued'
     AND public.normalize_gh_phone(o.phone_number) IN (
       SELECT phone_number FROM public.number_registrations WHERE batch_id = p_batch_id
     );
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  -- Release queued shop_orders (guest storefront rows).
  UPDATE public.shop_orders so
     SET status = 'pending', updated_at = now()
   WHERE so.status = 'queued'
     AND public.normalize_gh_phone(so.guest_phone) IN (
       SELECT phone_number FROM public.number_registrations WHERE batch_id = p_batch_id
     );
  GET DIAGNOSTICS v_shop = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'released_orders', v_orders,
    'released_shop_orders', v_shop
  );
END;
$$;
REVOKE ALL ON FUNCTION public.release_registration_batch(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_registration_batch(uuid, uuid) TO service_role;

-- ── 4. Manual registration RPC: register ad-hoc numbers → release their orders ─
CREATE OR REPLACE FUNCTION public.register_numbers_manual(
  p_phones  text[],
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_canon   text[];
  v_orders  integer := 0;
  v_shop    integer := 0;
BEGIN
  -- Canonicalize + drop nulls/dupes.
  SELECT array_agg(DISTINCT n) INTO v_canon
  FROM (SELECT public.normalize_gh_phone(x) AS n FROM unnest(p_phones) AS x) s
  WHERE n IS NOT NULL;

  IF v_canon IS NULL OR array_length(v_canon, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_valid_phones');
  END IF;

  -- Upsert as registered.
  INSERT INTO public.number_registrations (phone_number, network, status, source, registered_at)
  SELECT p, 'MTN', 'registered', 'admin', now() FROM unnest(v_canon) AS p
  ON CONFLICT (phone_number) DO UPDATE
    SET status = 'registered', registered_at = now();

  UPDATE public.orders o
     SET status = 'pending', updated_at = now()
   WHERE o.status = 'queued'
     AND public.normalize_gh_phone(o.phone_number) = ANY (v_canon);
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  UPDATE public.shop_orders so
     SET status = 'pending', updated_at = now()
   WHERE so.status = 'queued'
     AND public.normalize_gh_phone(so.guest_phone) = ANY (v_canon);
  GET DIAGNOSTICS v_shop = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'registered', array_length(v_canon, 1),
    'released_orders', v_orders,
    'released_shop_orders', v_shop
  );
END;
$$;
REVOKE ALL ON FUNCTION public.register_numbers_manual(text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_numbers_manual(text[], uuid) TO service_role;

-- ── 5. Refund RPC gating: add 'queued' to the refundable status set ──────────
-- Queued orders are paid-but-unfulfilled → must be refundable exactly like
-- pending. Reproduces the LATEST deployed bodies (20260705c / 20260702e) with
-- only the status gate widened from (pending,processing,failed) to
-- (pending,queued,processing,failed).

-- 5a. refund_order_wallet (retail wallet path) — base body 20260705c.
CREATE OR REPLACE FUNCTION public.refund_order_wallet(p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_o public.orders%ROWTYPE; v_ref text; v_wallet_id uuid;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
  IF v_o.payment_status = 'refunded' OR v_o.status = 'refunded' THEN
    RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_o.status NOT IN ('pending','queued','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status); END IF;
  IF v_o.user_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','no_wallet_user'); END IF;

  PERFORM public.reverse_lead_margin(p_order_reference := v_o.reference_code);

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
END; $function$;

-- 5b. settle_shop_refund_to_owner (shop owner-wallet path) — base body 20260705c.
CREATE OR REPLACE FUNCTION public.settle_shop_refund_to_owner(p_shop_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_so public.shop_orders%ROWTYPE; v_owner uuid; v_wallet_id uuid; v_ref text;
BEGIN
  SELECT * INTO v_so FROM public.shop_orders WHERE id = p_shop_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_so.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_so.status NOT IN ('pending','queued','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_so.status); END IF;
  IF v_so.cost_price IS NULL OR v_so.cost_price < 0 THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_cost_price'); END IF;

  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_so.shop_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','owner_not_found'); END IF;

  PERFORM public.reverse_lead_margin(p_shop_order_id := p_shop_order_id);

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
  UPDATE public.airtime_orders SET status='refunded',
         refunded_by=p_actor_id, refunded_at=now(), refund_reason=p_reason, updated_at=now()
    WHERE shop_id = v_so.shop_id
      AND reference_code IN (SELECT reference_code FROM public.orders WHERE shop_order_id = p_shop_order_id)
      AND status <> 'refunded';

  RETURN jsonb_build_object('ok',true,'settled',true,'amount',v_so.cost_price);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',true,'already_refunded',true);
END; $function$;

-- 5c. mark_shop_order_refunded (Paystack path finalizer) — base body 20260702e.
CREATE OR REPLACE FUNCTION public.mark_shop_order_refunded(
  p_shop_order_id uuid, p_actor_id uuid, p_reason text, p_reverse_profit boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_so public.shop_orders%ROWTYPE; v_rev jsonb; v_shortfall numeric := 0;
BEGIN
  SELECT * INTO v_so FROM public.shop_orders WHERE id = p_shop_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','shop_order_not_found'); END IF;
  IF v_so.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true,'shortfall',0); END IF;
  IF v_so.status NOT IN ('pending','queued','processing','failed') THEN
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

REVOKE ALL ON FUNCTION public.refund_order_wallet(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_shop_refund_to_owner(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_shop_order_refunded(uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_order_wallet(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_shop_refund_to_owner(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_shop_order_refunded(uuid,uuid,text,boolean) TO service_role;

-- ── 6. Seed the gate toggle OFF (track-first rollout) ────────────────────────
INSERT INTO public.admin_settings (key, value)
VALUES ('number_registration_gate_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 7. Backfill: seed all existing MTN recipient numbers as one 'submitted' batch
-- (These are the numbers being sent to the supplier now. Marking this batch
-- 'Registered' in the admin console flips every historical customer to registered.)
DO $$
DECLARE
  v_batch_id uuid;
  v_count    integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.number_registration_batches WHERE idempotency_key = 'backfill-2026-07-07') THEN
    INSERT INTO public.number_registration_batches (filename, network, status, idempotency_key, number_count)
    VALUES ('mtn-backfill-2026-07-07.xlsx', 'MTN', 'submitted', 'backfill-2026-07-07', 0)
    RETURNING id INTO v_batch_id;

    WITH mtn_nums AS (
      SELECT DISTINCT public.normalize_gh_phone(phone_number) AS phone
      FROM public.orders WHERE network = 'MTN'
      UNION
      SELECT DISTINCT public.normalize_gh_phone(guest_phone)
      FROM public.shop_orders WHERE network = 'MTN' AND guest_phone IS NOT NULL
    )
    INSERT INTO public.number_registrations (phone_number, network, status, batch_id, source, submitted_at)
    SELECT phone, 'MTN', 'submitted', v_batch_id, 'backfill', now()
    FROM mtn_nums WHERE phone IS NOT NULL
    ON CONFLICT (phone_number) DO NOTHING;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE public.number_registration_batches SET number_count = v_count WHERE id = v_batch_id;
  END IF;
END $$;
