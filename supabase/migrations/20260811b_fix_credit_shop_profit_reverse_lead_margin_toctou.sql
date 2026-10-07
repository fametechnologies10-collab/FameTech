-- Fixes a genuine double-credit TOCTOU found during the 2026-08-11 race-condition audit
-- (docs/security-audits/2026-08-11-race-condition-fraud-audit.md).
--
-- Both functions checked "already processed?" BEFORE acquiring any lock on the wallet
-- row (credit_shop_profit never locked the wallet at all). Two near-simultaneous calls
-- for the same shop_order_id / order_reference could both pass the not-yet-processed
-- check before either had inserted its ledger row, and both then credit/debit the
-- wallet — a real double-credit or double-debit. credit_shop_profit in particular has
-- FOUR call sites (lib/shop-order-processor.ts, lib/ussd/fulfillment/data.ts x2,
-- lib/ussd/fulfillment/airtime.ts x2, app/api/shop/verify/route.ts), including an
-- explicit USSD "replay credit" path that can legitimately re-invoke it for the same
-- order — so this was not just theoretical.
--
-- Fix: lock the wallet row FIRST, THEN check idempotency, THEN credit/debit — the
-- same ordering already used correctly by credit_shop_order_profits.

CREATE OR REPLACE FUNCTION public.credit_shop_profit(p_shop_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profit DECIMAL;
  v_owner_id UUID;
  v_wallet_id UUID;
  v_shop_name TEXT;
  v_guest_phone TEXT;
  v_network TEXT;
  v_package_size TEXT;
  v_existing_tx_id UUID;
BEGIN
  -- 1. Fetch Order & Owner Details
  SELECT
    so.profit,
    sp.owner_id,
    so.network,
    so.package_size,
    so.guest_phone
  INTO
    v_profit,
    v_owner_id,
    v_network,
    v_package_size,
    v_guest_phone
  FROM public.shop_orders so
  JOIN public.shop_profiles sp ON so.shop_id = sp.id
  WHERE so.id = p_shop_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  IF v_profit <= 0 OR v_profit IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No profit to credit');
  END IF;

  -- 2. Get or Create Wallet (Atomic Upsert strategy)
  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  -- 3. Lock the wallet row BEFORE checking idempotency (was: checked first, locked
  -- never). Serializes concurrent callers for the same owner — the second one to
  -- reach here blocks until the first commits, then sees the transaction row the
  -- first inserted below.
  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = v_owner_id
  FOR UPDATE;

  -- 4. Idempotency Check: Don't credit if already credited — now race-free because
  -- it runs under the wallet lock acquired above.
  SELECT id INTO v_existing_tx_id
  FROM public.shop_wallet_transactions
  WHERE shop_order_id = p_shop_order_id AND type = 'profit';

  IF v_existing_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already credited');
  END IF;

  -- 5. Atomic Balance Update
  UPDATE public.shop_wallets
  SET
    balance = balance + v_profit,
    total_earned = total_earned + v_profit,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  -- 6. Log Transaction
  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, shop_order_id, type, amount, description, status)
  VALUES
    (v_wallet_id, p_shop_order_id, 'profit', v_profit, 'Sale: ' || v_network || ' ' || v_package_size || ' to ' || v_guest_phone, 'completed');

  RETURN jsonb_build_object('success', true, 'message', 'Credited ' || v_profit);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_lead_margin(p_shop_order_id uuid DEFAULT NULL::uuid, p_order_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_tx public.shop_wallet_transactions%ROWTYPE; v_rev_source text; v_already boolean;
BEGIN
  IF p_shop_order_id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.shop_wallet_transactions
      WHERE shop_order_id = p_shop_order_id AND type = 'profit' AND credit_source = 'order_parent'
      ORDER BY created_at LIMIT 1;
  ELSIF p_order_reference IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.shop_wallet_transactions
      WHERE order_reference = p_order_reference AND type = 'profit' AND credit_source = 'wallet_sub_purchase'
      ORDER BY created_at LIMIT 1;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'no_key');
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'nothing_to_reverse', true); END IF;
  v_rev_source := v_tx.credit_source || '_reversal';

  -- Lock the wallet BEFORE checking already-reversed (was: checked first, locked
  -- after) — closes the same class of TOCTOU fixed above in credit_shop_profit.
  PERFORM 1 FROM public.shop_wallets WHERE id = v_tx.shop_wallet_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM public.shop_wallet_transactions
    WHERE shop_wallet_id = v_tx.shop_wallet_id AND type = 'profit_reversal' AND credit_source = v_rev_source
      AND ((p_shop_order_id IS NOT NULL AND shop_order_id = p_shop_order_id)
        OR (p_order_reference IS NOT NULL AND order_reference = p_order_reference))
  ) INTO v_already;

  IF v_already THEN
    RETURN jsonb_build_object('ok', true, 'already_reversed', true);
  END IF;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, shop_order_id, type, amount, status, description, credit_source, order_reference)
  VALUES (v_tx.shop_wallet_id, v_tx.shop_order_id, 'profit_reversal', v_tx.amount, 'completed',
     'Lead margin reversal for refunded sub-agent order', v_rev_source, v_tx.order_reference);
  UPDATE public.shop_wallets SET balance = balance - v_tx.amount,
      total_earned = GREATEST(0, total_earned - v_tx.amount), updated_at = now()
  WHERE id = v_tx.shop_wallet_id;
  RETURN jsonb_build_object('ok', true, 'reversed', true, 'amount', v_tx.amount);
END;
$function$;
