-- ============================================================================
-- Security Advisor — Round 3 (2026-05-28)
--
-- Locks `SET search_path = ''` on the remaining SECURITY DEFINER functions
-- that earlier rounds didn't touch. Each function is recreated with its body
-- unchanged except that every table reference is fully-qualified (`public.X`)
-- so the empty search_path doesn't break resolution.
--
-- Why this matters:
--   A SECURITY DEFINER function runs with the function-owner's permissions.
--   If `search_path` is not pinned, a caller can prefix their session with
--   a malicious schema containing a fake `wallets` table, then trigger the
--   function — which would now operate on the attacker's table with the
--   owner's elevated rights. Pinning search_path to '' forces every name
--   to be fully qualified, eliminating the attack class.
--
-- Functions covered in this round:
--   1. public.deduct_wallet_balance         — atomic wallet debit (money)
--   2. public.credit_wallet_balance         — atomic wallet credit (money)
--   3. public.protect_shop_pricing_updates  — trigger guarding profit_margin
--
-- All changes are semantically identical. Migration is idempotent.
-- ============================================================================


-- ─── 1. deduct_wallet_balance — lock search_path ─────────────────────────────
-- Original definition: 20260219_atomic_wallet_deduction.sql
-- This function debits a user's wallet atomically. Used on every paid
-- purchase. The pin-down is critical because the function is callable by
-- anyone with a valid session — `service_role` grants are at the call site,
-- not on the function itself.

CREATE OR REPLACE FUNCTION public.deduct_wallet_balance(
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
SET search_path = ''
AS $$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    -- Atomic: UPDATE with WHERE balance >= amount.
    -- If balance is insufficient, no rows are updated → we raise below.
    UPDATE public.wallets
    SET
        balance = balance - p_amount,
        total_spent = COALESCE(total_spent, 0) + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND balance >= p_amount
    RETURNING id, balance, COALESCE(total_spent, 0)
    INTO v_wallet_id, v_new_balance, v_new_total_spent;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_total_spent;
END;
$$;


-- ─── 2. credit_wallet_balance — re-lock search_path (belt + suspenders) ──────
-- This was recreated with search_path='' in 20260524_security_audit_fixes.sql,
-- but the original definition lives in 20260524_atomic_wallet_credit.sql.
-- Re-applying here is a no-op if the prior fix landed, and a safety net
-- if migrations were ever replayed out of order.

CREATE OR REPLACE FUNCTION public.credit_wallet_balance(
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
SET search_path = ''
AS $$
DECLARE
    v_wallet_id UUID;
    v_new_balance NUMERIC;
    v_new_total_spent NUMERIC;
BEGIN
    UPDATE public.wallets
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


-- ─── 3. protect_shop_pricing_updates — lock search_path ──────────────────────
-- Trigger function that prevents `profit_margin` from being edited after the
-- shop_pricing row is created. Runs SECURITY DEFINER so it enforces the rule
-- even when called by RLS-restricted user updates.

CREATE OR REPLACE FUNCTION public.protect_shop_pricing_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Lock profit_margin from ever being changed after creation
    IF NEW.profit_margin != OLD.profit_margin THEN
        RAISE EXCEPTION 'profit_margin cannot be changed after creation';
    END IF;
    RETURN NEW;
END;
$$;

-- Trigger binding is unchanged (already created by 20260318_auto_update_shop_pricing.sql)
-- so we don't re-bind it here.


-- ─── Permission grants (preserve existing call sites) ────────────────────────
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM anon;
GRANT  EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) TO service_role;

REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) TO service_role;


-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
