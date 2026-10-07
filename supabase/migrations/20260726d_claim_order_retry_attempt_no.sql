-- ============================================================================
-- MIGRATION: claim_order_retry — derive attempt_no from the ledger, not
--            the resettable retry_count
-- Date:      2026-07-26
-- Problem:   order_retry_attempts has UNIQUE (source_order_id, attempt_no),
--            but attempt_no was computed as `v_o.retry_count + 1`. retry_count
--            is intentionally reset to 0 once a 24h lockout elapses (to open
--            up a fresh cycle of 3 attempts). The 4th real attempt therefore
--            recomputed attempt_no = 1, which collides with the attempt-1 row
--            from the FIRST cycle's INSERT INTO order_retry_attempts. The
--            unique_violation is caught by the function's own EXCEPTION
--            handler and surfaced as an opaque 'duplicate_attempt' error,
--            silently and permanently disabling retry for that order after
--            the first lockout cycle. (Fails safe — no partial charge or
--            orphaned row, since Postgres rolls back the whole transaction —
--            but retry never works again for that order.)
-- Fix:       Derive attempt_no from MAX(attempt_no) + 1 over the permanent
--            order_retry_attempts ledger for this order, which never resets.
--            retry_count keeps doing exactly what it does today for the
--            cooldown/cap/lockout logic (60s gap, 3-attempt cap, 24h lockout,
--            reset-after-lockout) — only the attempt_no derivation changes.
--            The SELECT ... FOR UPDATE on the orders row above already
--            serializes concurrent callers for the same order, so this
--            MAX(attempt_no) read is race-safe without its own lock.
-- Only the attempt_no derivation changes; every other line is identical to
-- 20260726c_claim_order_retry_shop_owner.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_order_retry(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_charge_amount numeric DEFAULT 0,
  p_reference_code text DEFAULT NULL,
  p_cost_price numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o public.orders%ROWTYPE;
  v_attempt_no int;
  v_funding_user uuid;
  v_wallet_id uuid;
  v_balance numeric;
  v_new_order_id uuid;
  v_ref text;
  v_is_owner boolean;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  IF p_actor_role NOT IN ('admin', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_actor_role');
  END IF;

  IF v_o.status = 'failed' AND p_actor_role <> 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
  END IF;

  IF v_o.status = 'refunded' AND p_actor_role = 'user' THEN
    v_is_owner := (v_o.user_id IS NOT DISTINCT FROM p_actor_id);
    IF NOT v_is_owner AND v_o.shop_order_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.shop_orders so
        JOIN public.shop_profiles sp ON sp.id = so.shop_id
        WHERE so.id = v_o.shop_order_id AND sp.owner_id = p_actor_id
      ) INTO v_is_owner;
    END IF;
    IF NOT v_is_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_owner');
    END IF;
  END IF;

  IF v_o.status NOT IN ('failed', 'refunded') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_retryable', 'status', v_o.status);
  END IF;

  IF v_o.last_retry_at IS NOT NULL AND v_o.last_retry_at + interval '60 seconds' > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'retry_too_soon',
      'retry_after', v_o.last_retry_at + interval '60 seconds');
  END IF;

  IF v_o.retry_count >= 3 THEN
    IF v_o.last_retry_at + interval '24 hours' > now() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'retry_locked',
        'until', v_o.last_retry_at + interval '24 hours');
    END IF;
    -- lockout elapsed: open a fresh cycle of 3 (attempt_no keeps counting up independently)
    v_o.retry_count := 0;
  END IF;

  SELECT COALESCE(MAX(attempt_no), 0) + 1
    INTO v_attempt_no
    FROM public.order_retry_attempts
   WHERE source_order_id = p_order_id;

  IF v_o.status = 'failed' THEN
    UPDATE public.orders SET
      status = 'pending',
      codecraft_reference = NULL,
      dakazina_reference = NULL,
      ghdata_order_id = NULL,
      fulfillment_method = NULL,
      error_message = NULL,
      retry_count = v_o.retry_count + 1,
      last_retry_at = now(),
      retry_from_status = 'failed',
      retried_by = p_actor_id,
      retried_by_role = p_actor_role,
      updated_at = now()
    WHERE id = p_order_id;

    INSERT INTO public.order_retry_attempts
      (source_order_id, attempt_no, mode, actor_id, actor_role, charged_amount, status)
    VALUES
      (p_order_id, v_attempt_no, 'in_place', p_actor_id, p_actor_role, 0, 'claimed');

    RETURN jsonb_build_object('ok', true, 'mode', 'in_place',
      'target_order_id', p_order_id, 'attempt_no', v_attempt_no, 'charged_amount', 0,
      'reference_code', NULL);
  END IF;

  IF v_o.shop_order_id IS NOT NULL THEN
    DECLARE v_so public.shop_orders%ROWTYPE;
    BEGIN
      SELECT * INTO v_so FROM public.shop_orders WHERE id = v_o.shop_order_id;
      IF v_so.refund_method = 'paystack' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'paystack_refund_no_wallet');
      END IF;
      SELECT owner_id INTO v_funding_user FROM public.shop_profiles WHERE id = v_so.shop_id;
      IF v_funding_user IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'owner_not_found');
      END IF;
    END;
  ELSE
    v_funding_user := v_o.user_id;
    IF v_funding_user IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_wallet_user');
    END IF;
  END IF;

  IF p_charge_amount IS NULL OR p_charge_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_charge_amount');
  END IF;

  INSERT INTO public.wallets (user_id, balance) VALUES (v_funding_user, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id, balance INTO v_wallet_id, v_balance FROM public.wallets WHERE user_id = v_funding_user FOR UPDATE;

  IF v_balance < p_charge_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_balance',
      'required', p_charge_amount, 'available', v_balance);
  END IF;

  v_new_order_id := gen_random_uuid();
  v_ref := 'RETRY-' || p_order_id::text || '-' || v_attempt_no::text;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_funding_user, 'debit', p_charge_amount,
            'Retry of order ' || v_o.reference_code, v_ref, 'retry', 'completed');
  UPDATE public.wallets SET balance = balance - p_charge_amount WHERE id = v_wallet_id;

  INSERT INTO public.orders (
    id, user_id, phone_number, network, size, price, cost_price_at_time,
    status, payment_status, reference_code, category, role_at_time, source,
    shop_name, retry_of_order_id, retry_from_status, retried_by, retried_by_role,
    retry_count, last_retry_at
  ) VALUES (
    v_new_order_id, v_funding_user, v_o.phone_number, v_o.network, v_o.size,
    p_charge_amount, COALESCE(p_cost_price, v_o.cost_price_at_time),
    'pending', 'paid', COALESCE(p_reference_code, 'RTY-' || v_new_order_id::text),
    v_o.category, v_o.role_at_time, v_o.source,
    v_o.shop_name, p_order_id, 'refunded', p_actor_id, p_actor_role,
    0, NULL
  );

  UPDATE public.orders SET
    retry_count = v_o.retry_count + 1,
    last_retry_at = now(),
    retried_by = p_actor_id,
    retried_by_role = p_actor_role
  WHERE id = p_order_id;

  INSERT INTO public.order_retry_attempts
    (source_order_id, attempt_no, new_order_id, mode, actor_id, actor_role,
     charged_amount, funding_wallet_user_id, status)
  VALUES
    (p_order_id, v_attempt_no, v_new_order_id, 'new_order', p_actor_id, p_actor_role,
     p_charge_amount, v_funding_user, 'claimed');

  RETURN jsonb_build_object('ok', true, 'mode', 'new_order',
    'target_order_id', v_new_order_id, 'attempt_no', v_attempt_no,
    'charged_amount', p_charge_amount,
    'reference_code', (SELECT reference_code FROM public.orders WHERE id = v_new_order_id));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', 'duplicate_attempt');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_order_retry(uuid, uuid, text, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_retry(uuid, uuid, text, numeric, text, numeric) TO service_role;

NOTIFY pgrst, 'reload schema';
