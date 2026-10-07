-- ============================================================
-- Atomic Wallet Credit RPC
-- Companion to deduct_wallet_balance. Used by refund paths so
-- they perform a relative increment (balance = balance + X)
-- instead of an absolute overwrite, preventing TOCTOU races
-- where a concurrent successful deduction would be silently
-- reverted by a failing request's refund.
-- ============================================================

CREATE OR REPLACE FUNCTION credit_wallet_balance(
    p_user_id UUID,
    p_amount NUMERIC
)
RETURNS TABLE(
    wallet_id UUID,
    new_balance NUMERIC,
    new_total_spent NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    UPDATE wallets
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
$$;

REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) TO service_role;
