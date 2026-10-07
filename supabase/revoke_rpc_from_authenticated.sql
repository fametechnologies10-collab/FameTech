-- ============================================================
-- Security Hardening Migration — RPC Permission Lockdown
-- Resolves ALL Supabase Database Linter warnings for
-- SECURITY DEFINER functions.
--
-- CONTEXT: PostgreSQL grants EXECUTE to the PUBLIC role by
-- default. PUBLIC includes both 'anon' and 'authenticated'.
-- Our earlier REVOKE FROM authenticated had no effect because
-- the PUBLIC grant was still active. This migration fixes that
-- by revoking from PUBLIC first, then selectively re-granting
-- only where needed.
--
-- Additionally sets search_path = '' on all SECURITY DEFINER
-- functions to prevent search-path hijacking attacks.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- GROUP 1: SERVER-ONLY FUNCTIONS
-- These are called exclusively from Next.js API routes using
-- the service_role key. No browser client should ever call them.
-- ────────────────────────────────────────────────────────────

-- 1A. claim_momo_transaction
--     Called by: /api/wallet/claim-momo, /api/webhooks/sms-forward
--     Client calls: NONE
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) TO service_role;
ALTER  FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) SET search_path = '';

-- 1B. process_afa_order
--     Called by: /api/user/afa-registration (server-side)
--     Client calls: NONE
REVOKE EXECUTE ON FUNCTION public.process_afa_order(UUID, NUMERIC, JSONB, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_afa_order(UUID, NUMERIC, JSONB, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.process_afa_order(UUID, NUMERIC, JSONB, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.process_afa_order(UUID, NUMERIC, JSONB, TEXT) TO service_role;
ALTER  FUNCTION public.process_afa_order(UUID, NUMERIC, JSONB, TEXT) SET search_path = '';

-- 1C. release_expired_rc_reservations
--     Called by: /api/cron/release-rc-reservations (server-side)
--     Client calls: NONE
REVOKE EXECUTE ON FUNCTION public.release_expired_rc_reservations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_expired_rc_reservations() FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_expired_rc_reservations() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.release_expired_rc_reservations() TO service_role;
ALTER  FUNCTION public.release_expired_rc_reservations() SET search_path = '';

-- 1D. get_user_dashboard_stats
--     Called by: NOTHING (dead/unused function)
--     Locking down to service_role only as a precaution.
REVOKE EXECUTE ON FUNCTION public.get_user_dashboard_stats(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_dashboard_stats(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_dashboard_stats(UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_dashboard_stats(UUID) TO service_role;
ALTER  FUNCTION public.get_user_dashboard_stats(UUID) SET search_path = '';


-- ────────────────────────────────────────────────────────────
-- GROUP 2: CLIENT-CALLABLE FUNCTIONS
-- These are called from the browser via supabase.rpc() and
-- MUST remain executable by authenticated users. We only
-- revoke anon access and harden the search_path.
-- ────────────────────────────────────────────────────────────

-- 2A. delete_shop_data
--     Called by: Client-side in dashboard/shop/setup/page.tsx
--     Requires authenticated session to determine auth.uid()
REVOKE EXECUTE ON FUNCTION public.delete_shop_data() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_shop_data() FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_shop_data() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_shop_data() TO service_role;
ALTER  FUNCTION public.delete_shop_data() SET search_path = '';

-- 2B. get_user_transactions_with_balance
--     Called by: Client-side in dashboard/transactions/page.tsx
--               + Server-side in admin/finance/users/[id]/transactions
REVOKE EXECUTE ON FUNCTION public.get_user_transactions_with_balance(UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_transactions_with_balance(UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_user_transactions_with_balance(UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_transactions_with_balance(UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
ALTER  FUNCTION public.get_user_transactions_with_balance(UUID, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) SET search_path = '';

-- 2C. is_admin
--     Called by: RLS policies (evaluated in user's session context)
--     MUST remain callable by authenticated users for RLS to work.
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_admin() TO service_role;
ALTER  FUNCTION public.is_admin() SET search_path = '';


-- ────────────────────────────────────────────────────────────
-- VERIFICATION
-- Run this query after applying to confirm grants are correct:
--
--   SELECT routine_name, grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name IN (
--       'claim_momo_transaction',
--       'process_afa_order',
--       'release_expired_rc_reservations',
--       'get_user_dashboard_stats',
--       'delete_shop_data',
--       'get_user_transactions_with_balance',
--       'is_admin'
--     )
--   ORDER BY routine_name, grantee;
-- ────────────────────────────────────────────────────────────
