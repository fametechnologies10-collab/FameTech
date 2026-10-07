-- ============================================================================
-- MIGRATION: claim_order_retry — also clear dakazina_order_code on in-place retry
-- Date:      2026-08-20
--
-- Bug: 20260820_orders_dakazina_order_code.sql added orders.dakazina_order_code (DataKazina's
-- own ORDER-.../BULK-... identifier, stored alongside the incoming_api_ref we send) without
-- teaching this RPC's in-place retry branch to null it. That is EXACTLY the omission the
-- "Adding a new supplier" checklist in .claude/skills/kingflexy-fulfillment/SKILL.md item 2
-- exists to prevent, and which has now bitten Bundle Portal (2026-08-16) and HendyLinks
-- (2026-08-19) before this.
--
-- Effect without this fix: an order that failed via DataKazina and is retried in-place keeps
-- a stale dakazina_order_code after fulfillment_method has been nulled/reassigned to another
-- supplier. Not independently exploitable today, because app/api/webhooks/dakazina/route.ts
-- gates every match on fulfillment_method='datakazina' — but that gate is the ONLY thing
-- standing between a stale code and a late DataKazina webhook resolving an order that now
-- belongs to a different supplier. Closed here for defence in depth and consistency with the
-- five reference columns already cleared.
--
-- Fix: add dakazina_order_code to the in-place UPDATE's NULL-out list. Function body
-- otherwise byte-identical to
-- 20260820_claim_order_retry_clear_bundleportal_and_hendylinks_reference.sql.
--
-- Deliberately NOT changed here: v_attempt_no is still derived from the resettable
-- retry_count rather than from MAX(order_retry_attempts.attempt_no). That is a separate,
-- pre-existing defect (a 4th retry cycle after the 24h lockout recomputes attempt_no = 1 and
-- collides with UNIQUE(source_order_id, attempt_no), returning duplicate_attempt forever).
-- It fails safe — no money moves, no double dispatch — and fixing it changes retry
-- semantics, so it is being raised separately rather than bundled into a reference-clearing
-- migration.
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

  IF v_o.status = 'refunded' AND p_actor_role = 'user' AND v_o.user_id IS DISTINCT FROM p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_owner');
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
    -- Lockout elapsed — open a fresh cycle of 3.
    v_o.retry_count := 0;
  END IF;

  v_attempt_no := v_o.retry_count + 1;

  IF v_o.status = 'failed' THEN
    -- ── In-place retry: no wallet movement ─────────────────────────────────
    UPDATE public.orders SET
      status = 'pending',
      codecraft_reference = NULL,
      dakazina_reference = NULL,
      dakazina_order_code = NULL,
      ghdata_order_id = NULL,
      bundleportal_reference = NULL,
      hendylinks_order_id = NULL,
      fulfillment_method = NULL,
      error_message = NULL,
      download_batch_id = NULL,
      retry_count = v_attempt_no,
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

  -- ── Refunded retry: fresh order row, charged to the mirrored wallet ───────
  -- Money-safety guard: a prior retry that already succeeded/is in flight must
  -- not be charged for again.
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE retry_of_order_id = p_order_id AND status IN ('processing', 'completed')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'retry_already_in_progress');
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
    retry_count = v_attempt_no,
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
