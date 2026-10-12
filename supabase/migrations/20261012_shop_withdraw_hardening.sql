-- Shop withdrawal hardening (audit 2026-10-12).
--
-- 1. process_shop_withdrawal now, inside the wallet row lock:
--    * accepts mobile money only (bank payouts were removed from the product),
--    * rejects suspended/inactive users and rejected/suspended shops (suspension was
--      only enforced client-side, so a suspended user could call the API directly),
--    * rejects an IDENTICAL withdrawal (same wallet, amount and destination) while one
--      is still waiting/processing - a client retry after a timeout or a double click
--      can no longer queue the payout twice. No time window: it clears the moment the
--      first one is paid, failed or refunded.
--    * rounds the amount to pesewas before debiting (wallet columns are numeric(12,2);
--      a sub-cent amount was debited unrounded but recorded rounded).
--    The signature, grants (service_role only, revoked from authenticated in
--    20260624h) and fee logic are unchanged - CREATE OR REPLACE keeps the privileges.
-- 2. Drops shop_wallet_tx_lead_read. It let an upline Lead SELECT every transaction
--    (account names, MoMo numbers, balance snapshots) of their sub-agents, but only
--    served the Lead-approval chain removed in 20261003. No code reads sub-agent
--    transactions through the Lead's own session.

CREATE OR REPLACE FUNCTION public.process_shop_withdrawal(p_wallet_id uuid, p_amount numeric, p_fee numeric, p_net_amount numeric, p_account_name text, p_momo_number text, p_account_number text, p_network text, p_payment_type text, p_bank_id text, p_bank_name text, p_branch text, p_description text, p_owner_id uuid DEFAULT NULL::uuid, p_name_verified boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_wallet_owner_id UUID; v_caller UUID; v_current_balance NUMERIC; v_new_balance NUMERIC;
    v_tx_id UUID; v_owner_role TEXT; v_owner_status TEXT; v_shop_approval TEXT;
    v_pct NUMERIC; v_flat NUMERIC; v_computed_fee NUMERIC;
    v_fee NUMERIC; v_net NUMERIC; v_amount NUMERIC;
BEGIN
    v_amount := ROUND(COALESCE(p_amount, 0), 2);
    IF v_amount <= 0 THEN RAISE EXCEPTION 'Withdrawal amount must be greater than zero'; END IF;
    IF p_payment_type IS DISTINCT FROM 'momo' THEN
        RAISE EXCEPTION 'Only mobile money withdrawals are supported'; END IF;

    SELECT owner_id, balance INTO v_wallet_owner_id, v_current_balance
    FROM shop_wallets WHERE id = p_wallet_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
    v_caller := COALESCE(auth.uid(), p_owner_id);
    IF v_caller IS NULL OR v_caller <> v_wallet_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet'; END IF;
    IF v_current_balance < v_amount THEN RAISE EXCEPTION 'Insufficient shop wallet balance'; END IF;

    SELECT role, status INTO v_owner_role, v_owner_status FROM users WHERE id = v_wallet_owner_id;
    IF v_owner_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Your account is not active'; END IF;
    v_owner_role := COALESCE(v_owner_role, 'customer');

    SELECT withdrawal_fee_percent, withdrawal_fee_flat, approval_status
    INTO v_pct, v_flat, v_shop_approval
    FROM shop_profiles WHERE owner_id = v_wallet_owner_id;
    IF v_shop_approval IN ('suspended', 'rejected') THEN RAISE EXCEPTION 'Your shop is not active'; END IF;

    -- Identical request already in flight (checked AFTER the wallet lock, so two
    -- concurrent submits serialise and the second one sees the first).
    IF EXISTS (
        SELECT 1 FROM shop_wallet_transactions
        WHERE shop_wallet_id = p_wallet_id
          AND type = 'withdrawal'
          AND status IN ('shop_owner_pending', 'pending', 'moolre_pending', 'paystack_pending')
          AND amount = v_amount
          AND COALESCE(momo_number, account_number) = COALESCE(p_momo_number, p_account_number)
    ) THEN
        RAISE EXCEPTION 'You already have an identical withdrawal waiting to be processed';
    END IF;

    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent_' || v_owner_role; END IF;
    IF v_pct IS NULL AND v_owner_role = 'subagent' THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent_customer'; END IF;
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent'; END IF;
    IF v_pct IS NULL THEN v_pct := 2; END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat_' || v_owner_role; END IF;
    IF v_flat IS NULL AND v_owner_role = 'subagent' THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat_customer'; END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat'; END IF;
    IF v_flat IS NULL THEN v_flat := 0; END IF;
    v_computed_fee := ROUND((v_amount * v_pct / 100.0) + v_flat, 2);
    v_fee := GREATEST(ROUND(COALESCE(p_fee, 0), 2), v_computed_fee);
    v_net := v_amount - v_fee;
    IF v_net <= 0 THEN RAISE EXCEPTION 'Withdrawal amount too low to cover the processing fee'; END IF;

    v_new_balance := v_current_balance - v_amount;
    UPDATE shop_wallets
    SET balance = v_new_balance, total_withdrawn = COALESCE(total_withdrawn, 0) + v_amount, updated_at = NOW()
    WHERE id = p_wallet_id;
    INSERT INTO shop_wallet_transactions (
        shop_wallet_id, type, amount, fee, net_amount, account_name, momo_number,
        account_number, network, payment_type, bank_id, bank_name, branch,
        description, status, balance_snapshot, name_verified, sub_approval_status, escalate_after
    ) VALUES (
        p_wallet_id, 'withdrawal', v_amount, v_fee, v_net, p_account_name, p_momo_number,
        p_account_number, p_network, p_payment_type, p_bank_id, p_bank_name, p_branch,
        p_description, 'pending', v_new_balance, p_name_verified, 'not_required', NULL
    ) RETURNING id INTO v_tx_id;
    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'fee', v_fee,
        'netAmount', v_net, 'transactionId', v_tx_id, 'subOwnerPending', false);
END;
$function$;

DROP POLICY IF EXISTS shop_wallet_tx_lead_read ON public.shop_wallet_transactions;
