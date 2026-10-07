-- =============================================================================
-- B2 — Systemic over-grant sweep (defense-in-depth), 2026-06-24.
--
-- Background: Supabase grants INSERT/UPDATE/DELETE on every public table to BOTH
-- `anon` and `authenticated` by default. RLS is enabled everywhere, so the only
-- real gate is the policy check. An audit of every write policy that applies to
-- PUBLIC/anon confirmed that ALL of them require auth.uid()/is_admin()/
-- service_role — for an UNAUTHENTICATED (anon) request every check evaluates
-- false, so anon cannot actually write any table today. The grant is a latent
-- landmine: a future permissive ("true") policy would instantly become an
-- anon-writable hole.
--
-- This migration removes anon's write capability entirely (SELECT is preserved
-- for public storefront reads). It is a no-op functionally — if any legitimate
-- guest flow wrote as anon it would already be blocked by the existing policies
-- — and a strong systemic safety net. The earlier emergency lockdown
-- (20260624c/d) handled the money/identity criticals; this closes the rest.
-- =============================================================================

-- 1. Revoke all write privileges from `anon` on every base table in public.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', r.tablename);
    END LOOP;
END $$;

-- 2. Drop the pointless `authenticated` write grant on the results-checker tables
--    whose RLS policies already require service_role for every write — the grant
--    can never be exercised by an authenticated client, so this is pure cleanup.
REVOKE INSERT, UPDATE, DELETE ON public.results_checker_orders     FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.results_checker_inventory  FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.results_checker_complaints FROM authenticated;

-- Reload PostgREST so the revoked privileges take effect immediately.
NOTIFY pgrst, 'reload schema';
