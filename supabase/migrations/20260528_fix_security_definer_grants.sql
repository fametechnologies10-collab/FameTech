-- ============================================================================
-- Fix: Incorrect grants introduced by 20260528_security_advisor_round3.sql
--
-- Two problems that migration introduced:
--
-- 1. protect_shop_pricing_updates — a trigger function — was left with the
--    default PUBLIC execute grant after CREATE OR REPLACE. Trigger functions
--    are invoked by Postgres trigger machinery internally; no user role ever
--    needs EXECUTE permission on them directly. Leaving it exposed means any
--    anonymous visitor can call it via /rest/v1/rpc/protect_shop_pricing_updates.
--
-- 2. deduct_wallet_balance was explicitly granted to `authenticated`. This
--    means any signed-in user could call /rest/v1/rpc/deduct_wallet_balance
--    with any p_user_id UUID and drain another user's wallet. The function is
--    only ever called by server-side API routes using the service_role key —
--    authenticated users must never reach it directly.
-- ============================================================================


-- ─── 1. protect_shop_pricing_updates — remove all direct-call access ─────────
-- Trigger functions are fired by the trigger mechanism, not by user calls.
-- Users only need DML access to the table (already controlled by RLS).
REVOKE EXECUTE ON FUNCTION public.protect_shop_pricing_updates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_shop_pricing_updates() FROM anon;
REVOKE EXECUTE ON FUNCTION public.protect_shop_pricing_updates() FROM authenticated;


-- ─── 2. deduct_wallet_balance — restrict to service_role only ────────────────
-- This function debits wallets. It must only be reachable by server-side code
-- that already validates the logged-in user owns the wallet being debited.
-- Authenticated access would let any signed-in user pass any p_user_id.
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) TO service_role;


-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
