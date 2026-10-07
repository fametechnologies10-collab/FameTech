-- =============================================================================
-- Hardening follow-up (advisor 0028/0029), 2026-06-24.
-- guard_users_privilege_change() is a BEFORE UPDATE trigger function created by
-- the emergency migration 20260624d. It was left EXECUTE-grantable to anon/
-- authenticated, so it is exposed at /rest/v1/rpc/guard_users_privilege_change.
-- Trigger functions are invoked by the trigger mechanism regardless of the
-- caller's EXECUTE privilege, so revoking EXECUTE does NOT disable the trigger —
-- it only removes the pointless (and confusing) RPC surface.
-- =============================================================================
REVOKE EXECUTE ON FUNCTION public.guard_users_privilege_change() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
