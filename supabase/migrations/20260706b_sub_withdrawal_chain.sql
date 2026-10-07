-- supabase/migrations/20260706b_sub_withdrawal_chain.sql
-- =============================================================================
-- Sub-agent withdrawal chain (spec §10, Phase 9):
--   sub requests -> 'shop_owner_pending' -> Lead approves -> 'pending' (admin queue)
--   -> admin pays. If the Lead is silent 48h OR ineligible/suspended, a cron
--   auto-escalates straight to 'pending' (auto_escalated=true). Owner keeps
--   read-only visibility either way (RLS shop_wallet_tx_lead_read).
--
-- process_shop_withdrawal is made SUB-AWARE with NO signature change: it detects
-- the wallet owner is a sub and sets the initial status atomically (so a sub
-- withdrawal can never slip straight into the admin queue via a 2-step race).
-- =============================================================================

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
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet';
    END IF;

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

    -- SUB-AGENT chain: route to Lead approval instead of straight into the admin queue.
    SELECT sa.upline_shop_id INTO v_upline_shop FROM sub_agents sa WHERE sa.user_id = v_wallet_owner_id;
    v_is_sub := v_upline_shop IS NOT NULL;
    IF v_is_sub THEN
        SELECT COALESCE(
            (lu.role = 'agent'  AND lu.agent_expires_at IS NULL)
         OR (lu.role = 'dealer' AND lu.dealer_expires_at > now()), false)
        INTO v_lead_eligible
        FROM shop_profiles lp JOIN users lu ON lu.id = lp.owner_id
        WHERE lp.id = v_upline_shop AND lp.approval_status <> 'suspended';
        v_lead_eligible := COALESCE(v_lead_eligible, false);
        v_init_status := 'shop_owner_pending';
        v_sub_appr    := 'pending';
        -- Silent-Lead SLA 48h; if the Lead is already ineligible/suspended, escalate now.
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
        description, status, balance_snapshot, name_verified,
        sub_approval_status, escalate_after
    ) VALUES (
        p_wallet_id, 'withdrawal', p_amount, v_fee, v_net, p_account_name, p_momo_number,
        p_account_number, p_network, p_payment_type, p_bank_id, p_bank_name, p_branch,
        p_description, v_init_status, v_new_balance, p_name_verified,
        v_sub_appr, v_escalate
    ) RETURNING id INTO v_tx_id;

    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'fee', v_fee,
        'netAmount', v_net, 'transactionId', v_tx_id,
        'subOwnerPending', v_is_sub);
END;
$function$;

-- ── Lead approves / rejects a sub withdrawal ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_sub_withdrawal(
  p_actor_id uuid, p_tx_id uuid, p_action text, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tx public.shop_wallet_transactions%ROWTYPE; v_owner uuid; v_upline uuid; v_lead uuid;
BEGIN
  SELECT * INTO v_tx FROM public.shop_wallet_transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'withdrawal' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_tx.status <> 'shop_owner_pending' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending_owner'); END IF;

  -- Actor must be the Lead who owns the upline shop of the sub who owns this wallet.
  SELECT sw.owner_id INTO v_owner FROM public.shop_wallets sw WHERE sw.id = v_tx.shop_wallet_id;
  SELECT sa.upline_shop_id INTO v_upline FROM public.sub_agents sa WHERE sa.user_id = v_owner;
  SELECT owner_id INTO v_lead FROM public.shop_profiles WHERE id = v_upline;
  IF v_lead IS NULL OR v_lead <> p_actor_id THEN RETURN jsonb_build_object('ok', false, 'error', 'not_your_sub'); END IF;

  IF p_action = 'approve' THEN
    UPDATE public.shop_wallet_transactions
    SET status='pending', sub_approval_status='approved', sub_approved_by=p_actor_id,
        sub_approval_note=p_note, updated_at=now()
    WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', true, 'action', 'approved');
  ELSIF p_action = 'reject' THEN
    -- Reverse the deduction: funds return to the sub's shop wallet (they were held on request).
    UPDATE public.shop_wallets
    SET balance = balance + v_tx.amount,
        total_withdrawn = GREATEST(0, COALESCE(total_withdrawn,0) - v_tx.amount), updated_at=now()
    WHERE id = v_tx.shop_wallet_id;
    UPDATE public.shop_wallet_transactions
    SET status='reversed', sub_approval_status='rejected', sub_approved_by=p_actor_id,
        sub_approval_note=p_note, updated_at=now()
    WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', true, 'action', 'rejected');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
END;
$function$;

-- ── Cron sweep: escalate stale / orphaned sub withdrawals to the admin queue ─────
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
      AND (
            swt.escalate_after < now()
         OR lead.id IS NULL
         OR lead.approval_status = 'suspended'
         OR lu.id IS NULL
         OR NOT ( (lu.role='agent'  AND lu.agent_expires_at IS NULL)
               OR (lu.role='dealer' AND lu.dealer_expires_at > now()) )
      )
    FOR UPDATE OF swt
  )
  UPDATE public.shop_wallet_transactions swt
  SET status='pending', auto_escalated=true, updated_at=now()
  FROM to_escalate te WHERE swt.id = te.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'escalated', v_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_sub_withdrawal(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_sub_withdrawal(uuid, uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sub_withdrawal(uuid, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.escalate_stale_sub_withdrawals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.escalate_stale_sub_withdrawals() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.escalate_stale_sub_withdrawals() TO service_role;
