-- supabase/migrations/20260628b_increment_ussd_session_step_revoke_anon.sql
-- =============================================================================
-- Lock the increment_ussd_session_step RPC to service_role ONLY.
--
-- The original 20260628_increment_ussd_session_step migration did REVOKE ... FROM
-- PUBLIC, but Supabase DEFAULT-GRANTS execute to anon + authenticated on every new
-- function in the public schema, and REVOKE FROM PUBLIC does not remove those
-- per-role grants. The security advisor (0028/0029) flagged the function as
-- anon/authenticated-executable via /rest/v1/rpc/… — an unauthenticated write path
-- into ussd_sessions (SECURITY DEFINER bypasses RLS). Revoke them by name.
-- (Applied to prod 2026-07-05; advisor clean for this function afterwards.)
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.increment_ussd_session_step(TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated;
