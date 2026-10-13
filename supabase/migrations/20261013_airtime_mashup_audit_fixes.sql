-- 20261013_airtime_mashup_audit_fixes.sql
--
-- Database half of the 2026-10-12 airtime / mashup audit. Everything here is BACKWARD COMPATIBLE
-- with the code that is currently deployed (every route that touches these objects uses the
-- service role or an RPC), so it can be applied BEFORE the matching code release.
--
--   1. airtime_orders is server-read-only (customers could SELECT their own rows directly through
--      PostgREST, which returned supplier + margin columns regardless of what the API returns).
--   2. refund_airtime_wallet refuses an order that is still in flight at the supplier.
--   3. refund_mashup_order: ONE atomic refund (status flip + wallet credit + ledger row).
--   4. wallet RPCs reject negative amounts (defence in depth: service-role only today).
--   5. Mashup packages are admin-only to write, matching app/api/admin/mtn-mashup/packages.

-- ── 1. airtime_orders: no direct client reads ───────────────────────────────────────────────────
-- Every reader goes through an API route using the SERVICE ROLE (app/api/commission/transactions was
-- the one reader on a cookie/RLS client and now reads via the service role). Verified: no browser-side
-- query, no realtime channel and no SECURITY INVOKER view/function used by clients reads this table
-- (admin_airtime_stats is INVOKER but is only ever called with the service role).
-- The existing SELECT policy is left in place; with no table privilege it is simply unreachable.
REVOKE SELECT ON public.airtime_orders FROM anon, authenticated;

-- ── 2. refund_airtime_wallet: never refund an order the supplier may already have delivered ────
-- Previously a 'processing' order that had been dispatched to KingFlexyGH/Hubtel could be refunded;
-- if the supplier then delivered, the customer had BOTH the refund and the airtime (the finalize
-- path only raised an admin alert). The admin must run Sync first (or mark it failed manually).
CREATE OR REPLACE FUNCTION public.refund_airtime_wallet(p_order_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_o public.airtime_orders%ROWTYPE; v_ref text; v_wallet_id uuid; v_new_balance numeric;
BEGIN
  SELECT * INTO v_o FROM public.airtime_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','order_not_found'); END IF;
  IF v_o.status = 'refunded' THEN RETURN jsonb_build_object('ok',true,'already_refunded',true); END IF;
  IF v_o.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','not_refundable','status',v_o.status); END IF;
  IF v_o.user_id IS NULL OR v_o.shop_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','not_retail_airtime'); END IF;
  IF v_o.status = 'processing'
     AND v_o.fulfillment_service IN ('kingflexy-commission','hubtel-commission') THEN
    RETURN jsonb_build_object('ok',false,'error','in_flight_at_provider','status',v_o.status); END IF;

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
END $function$;

-- ── 3. refund_mashup_order (empty search_path; every relation is schema-qualified): atomic refund-once for Special MTN Mashup data orders ───────────────
-- The route used to (a) flip the order to refunded, THEN (b) call credit_wallet_balance. If (b)
-- failed the order was already marked refunded, a retry fell into the "already refunded" branch and
-- reported success, and the customer was never credited. Here the order row is locked FOR UPDATE and
-- the status flip, wallet credit and ledger row commit or roll back together.
CREATE OR REPLACE FUNCTION public.refund_mashup_order(p_order_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_o public.orders%ROWTYPE; v_wallet_id uuid; v_new_balance numeric;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id AND category = 'mtn_mashup' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'order_not_found'); END IF;

  IF v_o.payment_status = 'refunded' THEN
    -- Already refunded: only re-stamp the note; never credit twice.
    UPDATE public.orders SET fulfillment_note = COALESCE(p_note, fulfillment_note), updated_at = now()
      WHERE id = p_order_id;
    RETURN jsonb_build_object('ok', true, 'already_refunded', true,
                              'user_id', v_o.user_id, 'reference_code', v_o.reference_code);
  END IF;

  IF v_o.payment_status IS DISTINCT FROM 'paid' OR v_o.user_id IS NULL OR COALESCE(v_o.price, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refundable', 'status', v_o.status);
  END IF;

  INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;

  UPDATE public.wallets
     SET balance = balance + v_o.price,
         total_spent = GREATEST(0, COALESCE(total_spent, 0) - v_o.price),
         updated_at = now()
   WHERE id = v_wallet_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.price,
            'Refund: Special MTN Mashup order ' || p_order_id::text,
            'mashup-refund-' || p_order_id::text, 'refund', 'completed');

  UPDATE public.orders
     SET status = 'failed', payment_status = 'refunded', fulfillment_note = p_note, updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'refunded', true, 'user_id', v_o.user_id,
                            'amount', v_o.price, 'reference_code', v_o.reference_code,
                            'new_balance', v_new_balance);
END $function$;

REVOKE ALL ON FUNCTION public.refund_mashup_order(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_mashup_order(uuid, text) TO service_role;

-- ── 4. wallet RPCs: reject negative amounts ─────────────────────────────────────────────────────
-- A negative p_amount to deduct_wallet_balance CREDITS the wallet (balance - (-x)), and a negative
-- p_amount to credit_wallet_balance debits it without the balance check. Both are service-role only
-- today, but the guard belongs in the function so a future caller bug cannot mint money.
-- (Zero is still allowed: free/fully-discounted flows legitimately pass 0.)
CREATE OR REPLACE FUNCTION public.deduct_wallet_balance(p_user_id uuid, p_amount numeric)
 RETURNS TABLE(wallet_id uuid, new_balance numeric, new_total_spent numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    IF p_amount IS NULL OR p_amount < 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE public.wallets
    SET
        balance = balance - p_amount,
        total_spent = COALESCE(total_spent, 0) + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND balance >= p_amount
    RETURNING id, balance, COALESCE(total_spent, 0)
    INTO v_wallet_id, v_new_balance, v_new_total_spent;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_total_spent;
END;
$function$;

CREATE OR REPLACE FUNCTION public.credit_wallet_balance(p_user_id uuid, p_amount numeric)
 RETURNS TABLE(wallet_id uuid, new_balance numeric, new_total_spent numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    IF p_amount IS NULL OR p_amount < 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE public.wallets
    SET
        balance     = balance + p_amount,
        total_spent = GREATEST(0, COALESCE(total_spent, 0) - p_amount),
        updated_at  = NOW()
    WHERE user_id = p_user_id
    RETURNING id, balance, COALESCE(total_spent, 0)
    INTO v_wallet_id, v_new_balance, v_new_total_spent;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_total_spent;
END;
$function$;

-- ── 5. data_packages: Special MTN Mashup rows are admin-only to write ───────────────────────────
-- The mashup package API requires role = 'admin', but the table's own policies let any 'sub-admin'
-- write every package (including mashup cost/agent/dealer prices) directly through PostgREST with
-- their own JWT. RESTRICTIVE policies are ANDed with the existing permissive ones, so they narrow
-- access for mashup rows only and leave every other package untouched.
DROP POLICY IF EXISTS "Mashup packages: admin-only insert" ON public.data_packages;
DROP POLICY IF EXISTS "Mashup packages: admin-only update" ON public.data_packages;
DROP POLICY IF EXISTS "Mashup packages: admin-only delete" ON public.data_packages;

CREATE POLICY "Mashup packages: admin-only insert" ON public.data_packages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    category IS DISTINCT FROM 'mtn_mashup'
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  );

CREATE POLICY "Mashup packages: admin-only update" ON public.data_packages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    category IS DISTINCT FROM 'mtn_mashup'
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  )
  WITH CHECK (
    category IS DISTINCT FROM 'mtn_mashup'
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  );

CREATE POLICY "Mashup packages: admin-only delete" ON public.data_packages
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    category IS DISTINCT FROM 'mtn_mashup'
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  );
