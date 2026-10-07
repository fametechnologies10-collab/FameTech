-- Removes the sub-agent "Lead/parent approval" gate on shop withdrawals.
--
-- Background: 20260706b_sub_withdrawal_chain.sql introduced a chain where a
-- sub-agent's withdrawal landed as status='shop_owner_pending' and required
-- their upline Lead to call resolve_sub_withdrawal() before it became visible
-- to admin (status='pending'). In practice this chain was never fully wired
-- up end-to-end: no API route ever existed for a Lead to call
-- resolve_sub_withdrawal (grep confirms app/api/shop/sub-withdrawals/approve
-- does not exist in this repo), and the in-app notification pointed at
-- /dashboard/recruit, a page with no approve/reject UI. Admin's own
-- withdrawals queue (app/api/admin/withdrawals/route.ts) was also never
-- taught about the 'shop_owner_pending' status, so these rows were invisible
-- on the admin page until the 48h escalate_stale_sub_withdrawals cron forced
-- them to 'pending'. Net effect: sub-agent withdrawals silently sat for up to
-- 48h, Leads got a dead-end "approve this" notification they could never act
-- on, and the whole chain existed purely as friction (2026-10-03 finding,
-- reported by a recruiter who received an unusable approval prompt).
--
-- Decision (explicit product call, 2026-10-03): sub-agent shop withdrawals
-- must behave exactly like every other shop owner's — go straight to
-- status='pending' for admin review, no Lead/parent approval step. This
-- migration removes the shop_owner_pending branch from process_shop_withdrawal
-- so it always takes the "normal" path.
--
-- CREATE OR REPLACE replaces the whole function body, reproduced from
-- 20260917_subagent_withdrawal_fee_customer_fallback.sql with the sub-agent
-- status branch removed (fee-resolution logic is untouched).
CREATE OR REPLACE FUNCTION public.process_shop_withdrawal(p_wallet_id uuid, p_amount numeric, p_fee numeric, p_net_amount numeric, p_account_name text, p_momo_number text, p_account_number text, p_network text, p_payment_type text, p_bank_id text, p_bank_name text, p_branch text, p_description text, p_owner_id uuid DEFAULT NULL::uuid, p_name_verified boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_wallet_owner_id UUID; v_caller UUID; v_current_balance NUMERIC; v_new_balance NUMERIC;
    v_tx_id UUID; v_owner_role TEXT; v_pct NUMERIC; v_flat NUMERIC; v_computed_fee NUMERIC;
    v_fee NUMERIC; v_net NUMERIC;
BEGIN
    IF p_amount <= 0 THEN RAISE EXCEPTION 'Withdrawal amount must be greater than zero'; END IF;
    SELECT owner_id, balance INTO v_wallet_owner_id, v_current_balance
    FROM shop_wallets WHERE id = p_wallet_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
    v_caller := COALESCE(auth.uid(), p_owner_id);
    IF v_caller IS NULL OR v_caller <> v_wallet_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet'; END IF;
    IF v_current_balance < p_amount THEN RAISE EXCEPTION 'Insufficient shop wallet balance'; END IF;
    SELECT role INTO v_owner_role FROM users WHERE id = v_wallet_owner_id;
    v_owner_role := COALESCE(v_owner_role, 'customer');
    SELECT withdrawal_fee_percent, withdrawal_fee_flat INTO v_pct, v_flat
    FROM shop_profiles WHERE owner_id = v_wallet_owner_id;
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
    v_computed_fee := (p_amount * v_pct / 100.0) + v_flat;
    v_fee := GREATEST(COALESCE(p_fee, 0), v_computed_fee);
    v_net := p_amount - v_fee;
    IF v_net <= 0 THEN RAISE EXCEPTION 'Withdrawal amount too low to cover the processing fee'; END IF;

    v_new_balance := v_current_balance - p_amount;
    UPDATE shop_wallets
    SET balance = v_new_balance, total_withdrawn = COALESCE(total_withdrawn, 0) + p_amount, updated_at = NOW()
    WHERE id = p_wallet_id;
    INSERT INTO shop_wallet_transactions (
        shop_wallet_id, type, amount, fee, net_amount, account_name, momo_number,
        account_number, network, payment_type, bank_id, bank_name, branch,
        description, status, balance_snapshot, name_verified, sub_approval_status, escalate_after
    ) VALUES (
        p_wallet_id, 'withdrawal', p_amount, v_fee, v_net, p_account_name, p_momo_number,
        p_account_number, p_network, p_payment_type, p_bank_id, p_bank_name, p_branch,
        p_description, 'pending', v_new_balance, p_name_verified, 'not_required', NULL
    ) RETURNING id INTO v_tx_id;
    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'fee', v_fee,
        'netAmount', v_net, 'transactionId', v_tx_id, 'subOwnerPending', false);
END;
$function$;

-- Backfill: flip any withdrawals still stuck in 'shop_owner_pending' (never
-- approved by a Lead, never reached the 48h escalation window) straight to
-- 'pending' so they appear in the admin queue now.
UPDATE shop_wallet_transactions
SET status = 'pending',
    sub_approval_status = 'not_required',
    escalate_after = NULL,
    updated_at = NOW()
WHERE status = 'shop_owner_pending';
