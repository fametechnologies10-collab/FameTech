-- supabase/migrations/20260616_security_lockdown_sec001.sql
-- =============================================================================
-- SEC-001 hotfix: lock over-privileged SECURITY DEFINER functions
-- =============================================================================
-- Live audit (2026-06-16) found these SECURITY DEFINER functions executable by
-- PUBLIC / anon / authenticated via PostgREST (/rest/v1/rpc/<name>):
--
--   * credit_shop_ussd_profit  — CRITICAL. Anyone with the public anon key could
--     credit ANY shop's withdrawable balance to ANY amount, then withdraw real
--     money. (No pinned search_path either → DEFINER search_path risk.)
--   * admin_payment_stats      — HIGH. Leaked platform revenue (wallet/shop/RC
--     completed/pending/failed amounts) to anonymous callers.
--   * upsert_shop_customer_from_order / _rc_order — trigger functions that never
--     need direct client EXECUTE (hygiene).
--
-- Every legitimate caller uses the service-role client (USSD fulfillment in
-- app/api/ussd/fulfill, admin routes via createServerClient), so locking to
-- service_role breaks no real flow. IR scan at fix time showed no prior abuse.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.credit_shop_ussd_profit(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_shop_ussd_profit(uuid, numeric, text, text) TO service_role;
ALTER  FUNCTION public.credit_shop_ussd_profit(uuid, numeric, text, text) SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.admin_payment_stats(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_payment_stats(timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION public.upsert_shop_customer_from_order()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_shop_customer_from_rc_order() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
