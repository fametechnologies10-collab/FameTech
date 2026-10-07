-- ============================================================
-- 20260705e_lock_deduct_wallet_balance_grant.sql
-- Re-lock deduct_wallet_balance to service_role only.
--
-- WHY: 20260528_fix_security_definer_grants.sql correctly revoked
-- authenticated, but the later-sorting 20260528_security_advisor_round3.sql
-- re-created the function and explicitly GRANTed EXECUTE back to
-- authenticated (line 141). That allows ANY signed-in user to call
-- /rest/v1/rpc/deduct_wallet_balance with an arbitrary p_user_id and
-- destroy another user's balance. All legitimate callers are
-- server-side service-role routes; no client code calls this RPC.
-- Idempotent: safe to run regardless of current live grant state.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.deduct_wallet_balance(UUID, NUMERIC) TO service_role;

-- Verification (run after applying; expect service_role only):
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_name = 'deduct_wallet_balance';

NOTIFY pgrst, 'reload schema';
