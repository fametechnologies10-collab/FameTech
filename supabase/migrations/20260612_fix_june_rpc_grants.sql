-- ============================================================================
-- Security Advisor Fixes — June 2026 Regression (2026-06-12)
--
-- Two regressions introduced by the 2026-06-10 wallet/transactions migrations:
--
-- REGRESSION 1: increment_wallet_total_credited (20260610000001)
--   GRANT TO service_role was added without a preceding REVOKE FROM PUBLIC.
--   PostgreSQL grants EXECUTE to PUBLIC by default on new functions, so anon
--   and authenticated can call this function directly via the REST API, allowing
--   any caller to inflate any user's total_credited counter with arbitrary amounts.
--   Fix: REVOKE from PUBLIC, anon, authenticated. Service-role only.
--
-- REGRESSION 2: get_user_transactions_with_balance (20260610000002)
--   DROP FUNCTION + CREATE reset all GRANT/REVOKE state back to PostgreSQL
--   defaults, allowing anon callers again. The rewrite also switched from
--   plpgsql to sql language, which silently dropped the auth.uid() ownership
--   guard added in 20260524_security_audit_fixes.sql.
--   Fix: Rewrite as plpgsql with window-function optimization preserved AND
--   the auth.uid() guard restored. Re-apply REVOKE from anon.
--
-- Functions NOT changed (intentional design, documented in round-2 notes):
--   - is_admin()                             — required by RLS policies
--   - delete_shop_data()                     — owner deletes own shop
--   - process_shop_withdrawal(...)           — owner triggers own withdrawal
--   - save_shop_payment_detail_if_under_limit(...) — owner saves own payment detail
--
-- auth_leaked_password_protection:
--   DASHBOARD-ONLY SETTING. Enable manually:
--   Supabase Dashboard → Authentication → Password security
--   → "Check for leaked passwords via HaveIBeenPwned.org"
-- ============================================================================


-- ─── 1. increment_wallet_total_credited — revoke from anon + authenticated ────
-- This function is called only by server-side code (Paystack webhook handler)
-- after a successful top-up credit. It must never be reachable via the REST API.
-- An anon or authenticated caller could pass any p_user_id and inflate the
-- total_credited display counter for any user.

REVOKE EXECUTE ON FUNCTION public.increment_wallet_total_credited(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_wallet_total_credited(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_wallet_total_credited(UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_wallet_total_credited(UUID, NUMERIC) TO service_role;


-- ─── 2. get_user_transactions_with_balance — restore auth guard + revoke anon ──
-- The 20260610000002 migration dropped the function and recreated it in sql
-- language (for window-function performance). That DROP reset all grants to
-- PostgreSQL defaults (PUBLIC = EXECUTE) and removed the auth.uid() guard.
--
-- This replacement:
--   (a) Switches back to plpgsql to allow procedural error raising
--   (b) Re-applies the auth.uid() = p_user_id ownership guard
--   (c) Preserves the O(n) window-function balance calculation from 20260610000002
--   (d) Re-applies REVOKE from PUBLIC + anon

DROP FUNCTION IF EXISTS public.get_user_transactions_with_balance(
    uuid, integer, integer, text, text,
    timestamp with time zone, timestamp with time zone
);

CREATE OR REPLACE FUNCTION public.get_user_transactions_with_balance(
    p_user_id       UUID,
    p_limit         INTEGER,
    p_offset        INTEGER,
    p_source_filter TEXT                     DEFAULT 'all',
    p_type_filter   TEXT                     DEFAULT 'all',
    p_start_date    TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_end_date      TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS TABLE (
    id             UUID,
    amount         DECIMAL,
    type           TEXT,
    description    TEXT,
    reference      TEXT,
    source         TEXT,
    status         TEXT,
    created_at     TIMESTAMP WITH TIME ZONE,
    balance_before DECIMAL,
    balance_after  DECIMAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    -- Ownership guard: reject cross-user snooping by authenticated callers.
    -- Service-role calls (admin routes) have auth.uid() = NULL and are allowed.
    IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'ACCESS_DENIED: You may only view your own transactions';
    END IF;

    RETURN QUERY
    WITH
    all_txns AS (
        SELECT
            t.id,
            t.amount,
            t.type,
            t.description,
            t.reference,
            t.source,
            t.status,
            t.created_at,
            -- Running sum of all *later* transactions (window function, O(n))
            COALESCE(
                SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END)
                    OVER (
                        PARTITION BY t.user_id
                        ORDER BY t.created_at DESC, t.id DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                    ),
                0
            ) AS sum_of_later_txns
        FROM wallet_transactions t
        WHERE t.user_id = p_user_id
          AND (p_source_filter = 'all' OR t.source = p_source_filter)
          AND (p_type_filter   = 'all' OR t.type   = p_type_filter)
          AND (p_start_date IS NULL    OR t.created_at >= p_start_date)
          AND (p_end_date   IS NULL    OR t.created_at <= p_end_date)
    ),
    wallet_bal AS (
        SELECT COALESCE(balance, 0) AS balance
        FROM wallets
        WHERE user_id = p_user_id
    )
    SELECT
        t.id,
        t.amount::DECIMAL,
        t.type::TEXT,
        t.description::TEXT,
        t.reference::TEXT,
        t.source::TEXT,
        t.status::TEXT,
        t.created_at,
        (w.balance
            - t.sum_of_later_txns
            - CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END
        )::DECIMAL AS balance_before,
        (w.balance - t.sum_of_later_txns)::DECIMAL AS balance_after
    FROM all_txns t, wallet_bal w
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT  p_limit
    OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_transactions_with_balance(
    UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.get_user_transactions_with_balance(
    UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;

GRANT EXECUTE ON FUNCTION public.get_user_transactions_with_balance(
    UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_user_transactions_with_balance(
    UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;


-- ─── Schema cache refresh ─────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
