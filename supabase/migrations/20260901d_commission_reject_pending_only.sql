-- ============================================================================
-- 20260901d_commission_reject_pending_only.sql
-- Commission Wallet — fix round 1 from code review of Task 9 (admin route).
--
-- CRITICAL: reject_commission_withdrawal previously accepted a row at
-- status IN ('pending','paystack_pending'). That let an admin "reject" a row
-- the approve path had already handed to Paystack — the RPC would flip it to
-- 'failed' and credit the GROSS amount back to the user's balance while
-- Paystack was still (or already) paying it out, producing a real
-- double-payout / business loss. Narrow the claim to status = 'pending' only.
-- A row already at 'paystack_pending' must be resolved by reconciliation
-- (a later task), never by reject.
--
-- Everything else (type='withdrawal' guard, balance/total_withdrawn restore,
-- REVOKE/GRANT block) is unchanged from the live 20260901c definition.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_commission_withdrawal(p_transaction_id uuid, p_admin_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx record;
BEGIN
  UPDATE public.commission_wallet_transactions
     SET status = 'failed', admin_note = p_note, processed_by = p_admin_id, processed_at = now(), updated_at = now()
   WHERE id = p_transaction_id AND type = 'withdrawal' AND status = 'pending'
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

REVOKE ALL ON FUNCTION public.reject_commission_withdrawal(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_commission_withdrawal(uuid, uuid, text) TO service_role;
