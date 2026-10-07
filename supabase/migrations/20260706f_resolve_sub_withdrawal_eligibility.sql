-- 20260706f_resolve_sub_withdrawal_eligibility
-- Audit finding #6 (LOW): resolve_sub_withdrawal authorised the actor only by
-- "does the caller own the sub's upline shop" (v_lead = p_actor_id). It never
-- checked the Lead is still ELIGIBLE. A suspended/rejected/expired Lead kept a
-- valid session and could still REJECT a sub's freshly-requested withdrawal in
-- the up-to-1h window before escalate_stale_sub_withdrawals sweeps it to admin
-- — bouncing the funds back to the sub and forcing a re-request (griefing).
--
-- Fix: an ineligible Lead may NOT resolve (approve or reject) their sub's
-- withdrawal at all. process_shop_withdrawal already stamps escalate_after=now()
-- for ineligible Leads, so the row auto-escalates to the admin queue on the next
-- hourly cron tick regardless. Eligibility predicate mirrors process_shop_withdrawal.
-- Signature, SECURITY DEFINER, search_path and grants are unchanged (CREATE OR
-- REPLACE preserves the existing ACL).

CREATE OR REPLACE FUNCTION public.resolve_sub_withdrawal(p_actor_id uuid, p_tx_id uuid, p_action text, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx public.shop_wallet_transactions%ROWTYPE;
  v_owner uuid; v_upline uuid; v_lead uuid; v_lead_eligible boolean;
BEGIN
  SELECT * INTO v_tx FROM public.shop_wallet_transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'withdrawal' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_tx.status <> 'shop_owner_pending' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending_owner'); END IF;
  SELECT sw.owner_id INTO v_owner FROM public.shop_wallets sw WHERE sw.id = v_tx.shop_wallet_id;
  SELECT sa.upline_shop_id INTO v_upline FROM public.sub_agents sa WHERE sa.user_id = v_owner;
  SELECT owner_id INTO v_lead FROM public.shop_profiles WHERE id = v_upline;
  IF v_lead IS NULL OR v_lead <> p_actor_id THEN RETURN jsonb_build_object('ok', false, 'error', 'not_your_sub'); END IF;

  -- Lead must still be eligible to exercise approval authority. A suspended /
  -- rejected shop, or a Lead who is no longer a lifetime agent or active dealer,
  -- has no say — the row auto-escalates to admin via the escalation cron.
  SELECT COALESCE(
      (lu.role = 'agent'  AND lu.agent_expires_at IS NULL)
   OR (lu.role = 'dealer' AND lu.dealer_expires_at > now()), false)
  INTO v_lead_eligible
  FROM public.shop_profiles lp JOIN public.users lu ON lu.id = lp.owner_id
  WHERE lp.id = v_upline AND lp.approval_status NOT IN ('suspended','rejected');
  v_lead_eligible := COALESCE(v_lead_eligible, false);
  IF NOT v_lead_eligible THEN
    -- The Lead may have become ineligible AFTER submitting (e.g. dealer expiry),
    -- so the row could still carry its original +48h escalate_after. Pull it
    -- forward so the escalation cron forwards it to admin on the next tick
    -- instead of leaving the sub's funds in limbo. Row is already FOR UPDATE.
    UPDATE public.shop_wallet_transactions SET escalate_after = now(), updated_at = now() WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', false, 'error', 'lead_ineligible');
  END IF;

  IF p_action = 'approve' THEN
    UPDATE public.shop_wallet_transactions
    SET status='pending', sub_approval_status='approved', sub_approved_by=p_actor_id, sub_approval_note=p_note, updated_at=now()
    WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', true, 'action', 'approved');
  ELSIF p_action = 'reject' THEN
    UPDATE public.shop_wallets
    SET balance = balance + v_tx.amount, total_withdrawn = GREATEST(0, COALESCE(total_withdrawn,0) - v_tx.amount), updated_at=now()
    WHERE id = v_tx.shop_wallet_id;
    UPDATE public.shop_wallet_transactions
    SET status='reversed', sub_approval_status='rejected', sub_approved_by=p_actor_id, sub_approval_note=p_note, updated_at=now()
    WHERE id = p_tx_id;
    RETURN jsonb_build_object('ok', true, 'action', 'rejected');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
END;
$function$;
