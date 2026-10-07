-- ============================================================================
-- 20260709b_utility_rpcs.sql
-- Utility Bill Payments — Task A2: the money layer.
-- Two SECURITY DEFINER RPCs are the ONLY way money moves for utilities:
--   * credit_utility_commission — splits Hubtel's callback-reported commission
--     into the existing shop_wallets rail (partner earnings).
--   * refund_utility_wallet — returns face value to the buyer's MAIN wallet.
-- Both are idempotent (atomic single-UPDATE claim + RETURNING, mirroring the
-- claim style already used by fulfillment/refund RPCs in this project) so a
-- second call never double-credits. service_role-only; no grant widening.
-- Purely additive + re-runnable (CREATE OR REPLACE). DO NOT apply here —
-- reviewed and applied to prod by the controller.
-- ============================================================================

-- ── Commission split: Hubtel commission → partner's shop wallet ──────────────
-- Partner = shop owner for shop_id sales, or the api_key owner (user_id) for
-- source='api' sales. Platform keeps 100% when there is no partner. Share %
-- comes from admin_settings.key='utility_commission_partner_percent', clamped
-- 0..100, defaulting to 40 (matches the seed in 20260709_utility_bills.sql).
CREATE OR REPLACE FUNCTION public.credit_utility_commission(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_partner_id uuid; v_wallet_id uuid;
BEGIN
  -- Atomic claim: only one caller ever credits
  UPDATE public.utility_orders
     SET commission_credited_at = now()
   WHERE id = p_utility_order_id
     AND status = 'completed'
     AND commission_amount IS NOT NULL
     AND commission_credited_at IS NULL
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Nothing to credit (already credited, not completed, or no commission)');
  END IF;

  -- Partner resolution: shop sale -> shop owner; api sale -> key owner (user_id)
  IF v_order.shop_id IS NOT NULL THEN
    SELECT owner_id INTO v_partner_id FROM public.shop_profiles WHERE id = v_order.shop_id;
  ELSIF v_order.source = 'api' THEN
    v_partner_id := v_order.user_id;
  END IF;
  IF v_partner_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'No partner — platform keeps full commission');
  END IF;

  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 40)
    INTO v_pct FROM public.admin_settings WHERE key = 'utility_commission_partner_percent';
  v_pct := LEAST(GREATEST(COALESCE(v_pct, 40), 0), 100);
  v_share := round(v_order.commission_amount * v_pct / 100.0, 4);
  IF v_share <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Share rounds to zero');
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned) VALUES (v_partner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_partner_id FOR UPDATE;
  UPDATE public.shop_wallets
     SET balance = balance + v_share, total_earned = total_earned + v_share, updated_at = now()
   WHERE id = v_wallet_id;
  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, utility_order_id, type, amount, description, status)
  VALUES (v_wallet_id, p_utility_order_id, 'utility_commission', v_share,
          'Utility commission: ' || v_order.biller || ' ' || v_order.account_number, 'completed');
  UPDATE public.utility_orders SET partner_commission_amount = v_share WHERE id = p_utility_order_id;
  RETURN jsonb_build_object('success', true, 'amount', v_share);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', true, 'message', 'Already credited (ledger unique)');
END $$;

-- ── Wallet refund: return face value to the buyer's MAIN wallet ──────────────
-- Mirrors public.refund_airtime_wallet (supabase/migrations/20260702b_refund_rpcs.sql,
-- hardened in 20260702d_refund_rpc_hardening.sql): locked wallet row,
-- wallet_transactions ledger row with source='refund' + reference
-- 'REFUND-<reference_code>' — reference_code already starts 'UTIL-', giving
-- 'REFUND-UTIL-...', which composes with the scoped unique index
-- uq_wallet_tx_refund_reference ON wallet_transactions(reference)
-- WHERE source='refund' AND reference LIKE 'REFUND-%'
-- from 20260702a_refund_status_and_columns.sql — then balance credit.
-- Only single-arg here (no p_actor_id/p_reason) — utility_orders (Task A1) has
-- no refunded_by/refunded_at/refund_reason columns to record them against.
-- The claim itself uses the single-UPDATE-RETURNING atomic-claim style from
-- credit_utility_commission above (rather than refund_airtime_wallet's
-- SELECT..FOR UPDATE-then-final-UPDATE shape) so a guest order (user_id IS
-- NULL) can never be claimed into 'refunded' without a wallet actually being
-- credited — user_id IS NOT NULL is part of the claim's WHERE guard, and a
-- second call on an already-refunded order reports already_refunded without
-- crediting again.
CREATE OR REPLACE FUNCTION public.refund_utility_wallet(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order record; v_ref text; v_wallet_id uuid;
BEGIN
  -- Atomic claim: only one caller ever refunds; guest orders never match (user_id IS NOT NULL guard).
  UPDATE public.utility_orders
     SET status = 'refunded', payment_status = 'refunded', updated_at = now()
   WHERE id = p_utility_order_id
     AND payment_method = 'wallet'
     AND status IN ('pending','failed')
     AND payment_status = 'paid'
     AND user_id IS NOT NULL
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    -- Disambiguate the reason for reporting purposes only — no further mutation.
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
    IF v_order.payment_method <> 'wallet' THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_wallet_payment');
    END IF;
    IF v_order.payment_status <> 'paid' THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_paid', 'payment_status', v_order.payment_status);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'not_refundable', 'status', v_order.status);
  END IF;

  -- reference_code is already 'UTIL-<biller>-<hex>', so this reads 'REFUND-UTIL-...'
  -- and satisfies uq_wallet_tx_refund_reference (source='refund' + LIKE 'REFUND-%').
  v_ref := 'REFUND-' || v_order.reference_code;

  -- Race-safe wallet get-or-create: upsert-then-lock (same pattern as
  -- credit_utility_commission above). A SELECT-then-plain-INSERT would let two
  -- concurrent refunds for the same wallet-less user collide on wallets.user_id
  -- UNIQUE; the loser's unique_violation would roll the whole body back —
  -- including the claim UPDATE — yet still report already_refunded/success.
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

-- ── Lock down: service_role only (Supabase default-grants new functions to
--    anon/authenticated — close that explicitly, no grant widening) ──────────
REVOKE ALL ON FUNCTION public.credit_utility_commission(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_utility_wallet(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_utility_commission(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_utility_wallet(uuid) TO service_role;
