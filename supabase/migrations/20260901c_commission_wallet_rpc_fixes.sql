-- ============================================================================
-- 20260901c_commission_wallet_rpc_fixes.sql
-- Commission Wallet — fix round 1 from code review of 20260901b.
--
-- Idiom note: these commission-wallet RPCs return {success:false, error}
-- jsonb on failure (never RAISE); the sibling process_shop_withdrawal RAISEs
-- exceptions instead. Don't mix the two idioms in future edits to this file.
-- ============================================================================

-- FIX 2 (part 1): widen wallet_transactions.source to allow 'commission',
-- for the ledger row written when a commission-wallet transfer lands in the
-- user's main wallet. Preserves all 8 existing values.
ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
  CHECK (source IN ('payment','refund','admin','purchase','ussd','airtime','utility','retry','commission'));

-- FIX 3 (part 1): persist the fee/net split on a commission withdrawal so the
-- payout step can see what to actually pay out (not the gross amount).
ALTER TABLE public.commission_wallet_transactions ADD COLUMN IF NOT EXISTS fee numeric;
ALTER TABLE public.commission_wallet_transactions ADD COLUMN IF NOT EXISTS net_amount numeric;

-- ── Commission credit: Hubtel commission -> the DEVELOPER's commission wallet
-- (source='api' orders only). Called from credit_utility_commission below;
-- never called directly for a shop_id-attributed order.
-- FIX 6: on unique_violation the EXCEPTION block's implicit savepoint rolls
-- back this function's own claim (commission_credited_at = now()), but the
-- caller (credit_utility_commission) already reset it to NULL before
-- delegating here — that reset survives the rollback. Without repairing it,
-- the order would look permanently uncredited even though its ledger row
-- (the thing that caused the unique_violation) proves it already was.
CREATE OR REPLACE FUNCTION public.credit_commission_wallet(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_wallet_id uuid;
BEGIN
  UPDATE public.utility_orders
     SET commission_credited_at = now()
   WHERE id = p_utility_order_id
     AND status = 'completed'
     AND commission_amount IS NOT NULL
     AND commission_credited_at IS NULL
     AND source = 'api'
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Nothing to credit (already credited, not completed, no commission, or not an api order)');
  END IF;

  IF v_order.user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'No developer to credit');
  END IF;

  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 40)
    INTO v_pct FROM public.admin_settings WHERE key = 'utility_commission_partner_percent';
  v_pct := LEAST(GREATEST(COALESCE(v_pct, 40), 0), 100);
  v_share := round(v_order.commission_amount * v_pct / 100.0, 4);
  IF v_share <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Share rounds to zero');
  END IF;

  INSERT INTO public.commission_wallets (owner_id, balance, total_earned) VALUES (v_order.user_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.commission_wallets WHERE owner_id = v_order.user_id FOR UPDATE;
  UPDATE public.commission_wallets
     SET balance = balance + v_share, total_earned = total_earned + v_share, updated_at = now()
   WHERE id = v_wallet_id;
  INSERT INTO public.commission_wallet_transactions
    (commission_wallet_id, utility_order_id, type, amount, description, status)
  VALUES (v_wallet_id, p_utility_order_id, 'commission', v_share,
          'Commission: ' || v_order.biller || ' ' || v_order.account_number, 'completed');
  UPDATE public.utility_orders SET partner_commission_amount = v_share WHERE id = p_utility_order_id;
  RETURN jsonb_build_object('success', true, 'amount', v_share);
EXCEPTION WHEN unique_violation THEN
  -- Repair the claim the caller reset to NULL before delegating here — the
  -- ledger row that triggered this exception proves the order was already
  -- credited, so restore the marker rather than leaving it looking uncredited.
  UPDATE public.utility_orders SET commission_credited_at = now() WHERE id = p_utility_order_id;
  RETURN jsonb_build_object('success', true, 'message', 'Already credited (ledger unique)');
END $$;

-- ── credit_utility_commission — MODIFIED. Same atomic claim as before; the
-- shop_id branch (storefront sales -> shop_wallets) is UNCHANGED and takes
-- PRECEDENCE, exactly as it did before this feature: a shop_id-attributed
-- order always credits shop_wallets, regardless of source. Only when there
-- is no shop_id do we check source='api' and delegate to the developer's
-- commission wallet instead.
CREATE OR REPLACE FUNCTION public.credit_utility_commission(p_utility_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_partner_id uuid; v_wallet_id uuid;
BEGIN
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

  IF v_order.shop_id IS NOT NULL THEN
    SELECT owner_id INTO v_partner_id FROM public.shop_profiles WHERE id = v_order.shop_id;
  ELSIF v_order.source = 'api' THEN
    -- Route-and-delegate: source='api', no shop_id -> the new commission
    -- wallet. This claim already fired (commission_credited_at is set), so
    -- undo the claim and let credit_commission_wallet perform its OWN claim
    -- + credit atomically.
    UPDATE public.utility_orders SET commission_credited_at = NULL WHERE id = p_utility_order_id;
    RETURN public.credit_commission_wallet(p_utility_order_id);
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

-- ── Internal transfer: commission wallet -> main wallet OR shop wallet.
-- Instant, free (no fee), single transaction (both sides commit or neither does).
CREATE OR REPLACE FUNCTION public.transfer_commission_wallet(p_owner_id uuid, p_amount numeric, p_destination text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet record; v_shop_wallet_id uuid; v_main_wallet_id uuid;
BEGIN
  IF p_destination NOT IN ('main', 'shop') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_destination');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_wallet FROM public.commission_wallets WHERE owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_commission_wallet');
  END IF;
  IF v_wallet.balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance');
  END IF;

  IF p_destination = 'shop' THEN
    -- Deliberately requires a PRE-EXISTING shop wallet (unlike 'main' below,
    -- which auto-creates) — a commission holder with no storefront has no
    -- shop wallet to receive into, and we don't want to silently create one.
    SELECT id INTO v_shop_wallet_id FROM public.shop_wallets WHERE owner_id = p_owner_id FOR UPDATE;
    IF v_shop_wallet_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_shop_wallet');
    END IF;
  END IF;

  UPDATE public.commission_wallets SET balance = balance - p_amount, updated_at = now() WHERE id = v_wallet.id;
  INSERT INTO public.commission_wallet_transactions (commission_wallet_id, type, amount, description, status)
  VALUES (v_wallet.id, CASE WHEN p_destination = 'main' THEN 'transfer_out_main' ELSE 'transfer_out_shop' END,
          p_amount, 'Transfer to ' || CASE WHEN p_destination = 'main' THEN 'main wallet' ELSE 'shop wallet' END, 'completed');

  IF p_destination = 'main' THEN
    -- Deliberate auto-creation: every user has (or should have) a main
    -- wallet, so upsert-then-credit rather than failing the transfer.
    -- credit_wallet_balance() is NOT used here — it applies refund
    -- semantics (erodes total_spent) and writes no wallet_transactions row,
    -- which would leave a balance jump with nothing in the user's ledger
    -- explaining it. Credit and ledger explicitly instead.
    INSERT INTO public.wallets (user_id, balance) VALUES (p_owner_id, 0) ON CONFLICT (user_id) DO NOTHING;
    SELECT id INTO v_main_wallet_id FROM public.wallets WHERE user_id = p_owner_id FOR UPDATE;
    UPDATE public.wallets SET balance = balance + p_amount, updated_at = now() WHERE id = v_main_wallet_id;
    INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, source, status)
    VALUES (v_main_wallet_id, p_owner_id, 'credit', p_amount, 'Transfer from commission wallet', 'commission', 'completed');
  ELSE
    -- Balance only — this amount was already counted in
    -- commission_wallets.total_earned; adding it to shop_wallets.total_earned
    -- too would double-count it and blur the commission/shop separation.
    UPDATE public.shop_wallets SET balance = balance + p_amount, updated_at = now()
     WHERE id = v_shop_wallet_id;
    INSERT INTO public.shop_wallet_transactions (shop_wallet_id, type, amount, description, status)
    VALUES (v_shop_wallet_id, 'commission_transfer_in', p_amount, 'Transfer from commission wallet', 'completed');
  END IF;

  RETURN jsonb_build_object('success', true, 'destination', p_destination, 'amount', p_amount);
END $$;

-- ── Withdrawal request: locks wallet, debits immediately (held pending),
-- inserts a 'withdrawal' ledger row. Mirrors process_shop_withdrawal's shape.
-- COALESCE(auth.uid(), p_owner_id): accepts a service-role caller (auth.uid()
-- IS NULL) with a server-trusted owner id, but a direct authenticated client
-- call could only ever pass its own uid — REVOKE below closes that path anyway.
CREATE OR REPLACE FUNCTION public.process_commission_withdrawal(
  p_wallet_id uuid, p_amount numeric, p_fee numeric, p_net_amount numeric,
  p_account_name text, p_momo_number text, p_network text, p_description text,
  p_owner_id uuid, p_name_verified boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet record; v_tx_id uuid;
BEGIN
  SELECT * INTO v_wallet FROM public.commission_wallets
   WHERE id = p_wallet_id AND owner_id = COALESCE(auth.uid(), p_owner_id) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_net_amount IS NULL OR p_net_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF p_fee IS NULL OR p_fee < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF round(p_amount - p_fee, 2) <> round(p_net_amount, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF v_wallet.balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance');
  END IF;

  UPDATE public.commission_wallets
     SET balance = balance - p_amount, total_withdrawn = COALESCE(total_withdrawn, 0) + p_amount, updated_at = now()
   WHERE id = p_wallet_id;
  INSERT INTO public.commission_wallet_transactions
    (commission_wallet_id, type, amount, fee, net_amount, description, status, momo_number, network, account_name, name_verified)
  VALUES (p_wallet_id, 'withdrawal', p_amount, p_fee, p_net_amount, p_description, 'pending', p_momo_number, p_network, p_account_name, p_name_verified)
  RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object('success', true, 'transaction_id', v_tx_id, 'net_amount', p_net_amount, 'fee', p_fee);
END $$;

-- ── Reject a pending/processing withdrawal: reverse the debit, mark failed.
CREATE OR REPLACE FUNCTION public.reject_commission_withdrawal(p_transaction_id uuid, p_admin_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx record;
BEGIN
  UPDATE public.commission_wallet_transactions
     SET status = 'failed', admin_note = p_note, processed_by = p_admin_id, processed_at = now(), updated_at = now()
   WHERE id = p_transaction_id AND type = 'withdrawal' AND status IN ('pending', 'paystack_pending')
  RETURNING * INTO v_tx;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_pending');
  END IF;

  UPDATE public.commission_wallets
     SET balance = balance + v_tx.amount, total_withdrawn = GREATEST(0, COALESCE(total_withdrawn, 0) - v_tx.amount), updated_at = now()
   WHERE id = v_tx.commission_wallet_id;
  INSERT INTO public.commission_wallet_transactions (commission_wallet_id, type, amount, description, status)
  VALUES (v_tx.commission_wallet_id, 'withdrawal_reversal', v_tx.amount, 'Withdrawal rejected: ' || COALESCE(p_note, ''), 'completed');

  RETURN jsonb_build_object('success', true, 'refunded', v_tx.amount);
END $$;

REVOKE ALL ON FUNCTION public.credit_commission_wallet(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transfer_commission_wallet(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_commission_withdrawal(uuid, numeric, numeric, numeric, text, text, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_commission_withdrawal(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_commission_wallet(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.transfer_commission_wallet(uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_commission_withdrawal(uuid, numeric, numeric, numeric, text, text, text, text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_commission_withdrawal(uuid, uuid, text) TO service_role;
