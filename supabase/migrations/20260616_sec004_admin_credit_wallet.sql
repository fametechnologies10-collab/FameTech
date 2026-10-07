-- supabase/migrations/20260616_sec004_admin_credit_wallet.sql
-- =============================================================================
-- SEC-004 / SEC-018: atomic admin wallet credit
-- =============================================================================
-- The admin top-up route did a read-then-write UPDATE on wallets.balance (lost-
-- update race) and never checked the update error (silent HTTP 200 on failure),
-- plus double-counted total_credited (an RPC AND a manual read-update).
--
-- This adds a single atomic primitive: increment balance AND total_credited in
-- one statement. Additive (new function) so it does not affect already-deployed
-- code; the route is switched to it on this branch. service_role-only so a
-- regular user can never call it to credit their own wallet.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_credit_wallet(p_user_id UUID, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_new_balance NUMERIC;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Credit amount must be greater than zero';
    END IF;

    UPDATE wallets
    SET balance        = balance + p_amount,
        total_credited = COALESCE(total_credited, 0) + p_amount,
        updated_at     = now()
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_credit_wallet(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_credit_wallet(UUID, NUMERIC) TO service_role;
