-- ============================================================
-- Security Audit Fixes — Supabase Advisor Report (2026-05-24)
-- Addresses all 8 findings:
--   1. credit_wallet_balance           — mutable search_path
--   2. update_push_subscriptions_updated_at — mutable search_path
--   3. process_shop_withdrawal         — callable by anon
--   4. delete_shop_data                — mutable search_path
--   5. get_user_transactions_with_balance — mutable search_path +
--                                          missing auth ownership check (CRITICAL)
--   6. is_admin()                      — search_path already set (no change needed)
--   7. auth_leaked_password_protection — dashboard setting (see README)
-- ============================================================


-- ─── 1. credit_wallet_balance — lock search_path ─────────────────────────────
-- Called only by service_role (API refund paths). Already revoked from
-- public/anon/authenticated in 20260524_atomic_wallet_credit.sql.
-- Adding SET search_path = '' prevents schema-injection on the SECURITY DEFINER path.

CREATE OR REPLACE FUNCTION public.credit_wallet_balance(
    p_user_id UUID,
    p_amount   NUMERIC
)
RETURNS TABLE(wallet_id UUID, new_balance NUMERIC, new_total_spent NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_wallet_id       UUID;
    v_new_balance     NUMERIC;
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

REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, NUMERIC) TO service_role;


-- ─── 2. update_push_subscriptions_updated_at — lock search_path ──────────────
-- Trigger function only — never callable via REST. Fix is purely defensive.

CREATE OR REPLACE FUNCTION public.update_push_subscriptions_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Re-attach the trigger in case the function replacement dropped it.
DROP TRIGGER IF EXISTS push_subscriptions_updated_at_trigger ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_updated_at_trigger
    BEFORE UPDATE ON public.push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_push_subscriptions_updated_at();


-- ─── 3. process_shop_withdrawal — revoke from anon ───────────────────────────
-- The function already verifies auth.uid() == wallet owner internally, so anon
-- calls cannot succeed. But blocking at the role layer removes the attack surface
-- entirely and stops unauthenticated actors from probing the function.

REVOKE EXECUTE ON FUNCTION public.process_shop_withdrawal(
    uuid, numeric, numeric, numeric,
    text, text, text, text, text, text, text, text, text
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.process_shop_withdrawal(
    uuid, numeric, numeric, numeric,
    text, text, text, text, text, text, text, text, text
) FROM anon;

-- Keep the authenticated grant (shop owners call this via /api/shop/withdraw).
GRANT EXECUTE ON FUNCTION public.process_shop_withdrawal(
    uuid, numeric, numeric, numeric,
    text, text, text, text, text, text, text, text, text
) TO authenticated;


-- ─── 4. delete_shop_data — lock search_path ──────────────────────────────────
-- Callable by authenticated is INTENTIONAL (shop owner deletes own shop).
-- The function already checks auth.uid() so no horizontal escalation is possible.
-- Adding SET search_path = '' closes the schema-injection vector.

CREATE OR REPLACE FUNCTION public.delete_shop_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner_id UUID;
    v_shop_id  UUID;
    v_wallet_id UUID;
BEGIN
    v_owner_id := auth.uid();

    IF v_owner_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
    END IF;

    SELECT id INTO v_shop_id   FROM public.shop_profiles WHERE owner_id = v_owner_id;
    SELECT id INTO v_wallet_id FROM public.shop_wallets  WHERE owner_id = v_owner_id;

    IF v_shop_id IS NULL AND v_wallet_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'No shop found to delete');
    END IF;

    IF v_wallet_id IS NOT NULL THEN
        DELETE FROM public.shop_wallets WHERE id = v_wallet_id;
    END IF;

    IF v_shop_id IS NOT NULL THEN
        DELETE FROM public.shop_profiles WHERE id = v_shop_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Shop deleted successfully');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_shop_data() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_shop_data() FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_shop_data() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_shop_data() TO service_role;


-- ─── 5. get_user_transactions_with_balance — CRITICAL auth ownership fix ──────
-- VULNERABILITY: function accepted any p_user_id without verifying the caller
-- owns that user ID. An authenticated user could view any other user's full
-- transaction history by passing a different UUID via the client-side RPC call.
--
-- FIX: Guard with auth.uid() check. auth.uid() is NULL when called via the
-- service_role client (server-side admin routes), which is the only legitimate
-- path for cross-user access — and that path is already protected at the
-- Next.js route handler layer (admin role check).

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
    id            UUID,
    amount        DECIMAL,
    type          TEXT,
    description   TEXT,
    reference     TEXT,
    source        TEXT,
    status        TEXT,
    created_at    TIMESTAMP WITH TIME ZONE,
    balance_before DECIMAL,
    balance_after  DECIMAL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current_balance DECIMAL;
BEGIN
    -- Security: reject cross-user snooping by authenticated callers.
    -- Service-role calls (admin routes) have auth.uid() = NULL and are allowed.
    IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'ACCESS_DENIED: You may only view your own transactions';
    END IF;

    -- Get current wallet balance as anchor for running balance calculation.
    SELECT balance INTO v_current_balance
    FROM public.wallets
    WHERE user_id = p_user_id;

    IF v_current_balance IS NULL THEN
        v_current_balance := 0;
    END IF;

    RETURN QUERY
    SELECT
        t.id,
        t.amount,
        t.type,
        t.description,
        t.reference,
        t.source,
        t.status,
        t.created_at,
        -- Balance Before this transaction
        (
            v_current_balance
            - COALESCE((
                SELECT SUM(CASE WHEN t2.type = 'credit' THEN t2.amount ELSE -t2.amount END)
                FROM public.wallet_transactions t2
                WHERE t2.user_id = p_user_id
                  AND (t2.created_at > t.created_at
                       OR (t2.created_at = t.created_at AND t2.id > t.id))
            ), 0)
            - (CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END)
        )::DECIMAL AS balance_before,
        -- Balance After this transaction
        (
            v_current_balance
            - COALESCE((
                SELECT SUM(CASE WHEN t2.type = 'credit' THEN t2.amount ELSE -t2.amount END)
                FROM public.wallet_transactions t2
                WHERE t2.user_id = p_user_id
                  AND (t2.created_at > t.created_at
                       OR (t2.created_at = t.created_at AND t2.id > t.id))
            ), 0)
        )::DECIMAL AS balance_after
    FROM public.wallet_transactions t
    WHERE t.user_id = p_user_id
      AND (p_source_filter = 'all' OR t.source = p_source_filter)
      AND (p_type_filter   = 'all' OR t.type   = p_type_filter)
      AND (p_start_date IS NULL OR t.created_at >= p_start_date)
      AND (p_end_date   IS NULL OR t.created_at <= p_end_date)
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


-- ─── 6. is_admin() — already hardened, no change needed ──────────────────────
-- fix_admin_permissions_robust.sql already sets SET search_path = public.
-- Callable by authenticated is INTENTIONAL: is_admin() is used inside RLS
-- policies which run in the session of the authenticated caller. Revoking
-- EXECUTE from authenticated would break every admin RLS policy on the platform.
-- The Supabase advisor warning is acknowledged and accepted as intentional design.


-- ─── 7. auth_leaked_password_protection — dashboard setting ──────────────────
-- ACTION REQUIRED (cannot be fixed via SQL migration):
-- Supabase Dashboard → Authentication → Password security
-- Enable "Check for leaked passwords via HaveIBeenPwned.org"
-- This prevents users from setting passwords that appear in known data breaches.
