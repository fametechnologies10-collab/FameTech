-- supabase/migrations/20260706d_withdrawal_gate_rejected.sql
-- Security-review hardening #7 (adversarial review wlqfe8ty5): align the sub-withdrawal
-- eligibility gates with the charge-gate (lib/sub-agent.ts blocks BOTH 'suspended' AND
-- 'rejected' Lead shops). Previously the withdrawal gate + escalation predicate only
-- treated 'suspended' as ineligible, so a sub under a 'rejected' Lead waited the full 48h
-- rather than escalating immediately. Only affects the sub-agent branch; non-sub
-- withdrawals are untouched. Full bodies included so a fresh repo restore is complete.

CREATE OR REPLACE FUNCTION public.process_shop_withdrawal(
  p_wallet_id uuid, p_amount numeric, p_fee numeric, p_net_amount numeric,
  p_account_name text, p_momo_number text, p_account_number text, p_network text,
  p_payment_type text, p_bank_id text, p_bank_name text, p_branch text,
  p_description text, p_owner_id uuid DEFAULT NULL::uuid, p_name_verified boolean DEFAULT NULL::boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_wallet_owner_id UUID; v_caller UUID; v_current_balance NUMERIC; v_new_balance NUMERIC;
    v_tx_id UUID; v_owner_role TEXT; v_pct NUMERIC; v_flat NUMERIC; v_computed_fee NUMERIC;
    v_fee NUMERIC; v_net NUMERIC;
    v_upline_shop UUID; v_is_sub BOOLEAN; v_lead_eligible BOOLEAN;
    v_init_status TEXT; v_sub_appr TEXT; v_escalate TIMESTAMPTZ;
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
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent'; END IF;
    IF v_pct IS NULL THEN v_pct := 2; END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat_' || v_owner_role; END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat'; END IF;
    IF v_flat IS NULL THEN v_flat := 0; END IF;
    v_computed_fee := (p_amount * v_pct / 100.0) + v_flat;
    v_fee := GREATEST(COALESCE(p_fee, 0), v_computed_fee);
    v_net := p_amount - v_fee;
    IF v_net <= 0 THEN RAISE EXCEPTION 'Withdrawal amount too low to cover the processing fee'; END IF;

    SELECT sa.upline_shop_id INTO v_upline_shop FROM sub_agents sa WHERE sa.user_id = v_wallet_owner_id;
    v_is_sub := v_upline_shop IS NOT NULL;
    IF v_is_sub THEN
        SELECT COALESCE(
            (lu.role = 'agent'  AND lu.agent_expires_at IS NULL)
         OR (lu.role = 'dealer' AND lu.dealer_expires_at > now()), false)
        INTO v_lead_eligible
        FROM shop_profiles lp JOIN users lu ON lu.id = lp.owner_id
        WHERE lp.id = v_upline_shop AND lp.approval_status NOT IN ('suspended','rejected');
        v_lead_eligible := COALESCE(v_lead_eligible, false);
        v_init_status := 'shop_owner_pending';
        v_sub_appr    := 'pending';
        v_escalate    := CASE WHEN v_lead_eligible THEN now() + interval '48 hours' ELSE now() END;
    ELSE
        v_init_status := 'pending'; v_sub_appr := 'not_required'; v_escalate := NULL;
    END IF;

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
        p_description, v_init_status, v_new_balance, p_name_verified, v_sub_appr, v_escalate
    ) RETURNING id INTO v_tx_id;
    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'fee', v_fee,
        'netAmount', v_net, 'transactionId', v_tx_id, 'subOwnerPending', v_is_sub);
END;
$function$;

CREATE OR REPLACE FUNCTION public.escalate_stale_sub_withdrawals()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count int;
BEGIN
  WITH to_escalate AS (
    SELECT swt.id
    FROM public.shop_wallet_transactions swt
    JOIN public.shop_wallets sw   ON sw.id  = swt.shop_wallet_id
    JOIN public.sub_agents   sa   ON sa.user_id = sw.owner_id
    LEFT JOIN public.shop_profiles lead ON lead.id = sa.upline_shop_id
    LEFT JOIN public.users lu           ON lu.id = lead.owner_id
    WHERE swt.status = 'shop_owner_pending'
      AND ( swt.escalate_after < now() OR lead.id IS NULL OR lead.approval_status IN ('suspended','rejected')
         OR lu.id IS NULL
         OR NOT ( (lu.role='agent' AND lu.agent_expires_at IS NULL) OR (lu.role='dealer' AND lu.dealer_expires_at > now()) ) )
    FOR UPDATE OF swt
  )
  UPDATE public.shop_wallet_transactions swt
  SET status='pending', auto_escalated=true, updated_at=now()
  FROM to_escalate te WHERE swt.id = te.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'escalated', v_count);
END;
$function$;
