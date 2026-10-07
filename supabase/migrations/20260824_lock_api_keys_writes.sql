-- 20260824_lock_api_keys_writes.sql
-- APPLIED to the live project 2026-08-24 via the apply_migration MCP tool.
--
-- Closes a live authorization hole on public.api_keys found by the Phase 2A
-- final review (finding C1, .superpowers/sdd/2026-08-24-api-v2-new-products/).
--
-- Both UPDATE policies had WITH CHECK = NULL. Postgres reuses a policy's USING
-- expression as its check when WITH CHECK is absent, so the only column a user
-- could not change was user_id. Combined with column-level UPDATE grants held
-- by `authenticated`, any logged-in user could, from the browser with the
-- ordinary anon key:
--
--   status       'pending' -> 'active', self-approving an API key that
--                lib/api-auth.ts:228 otherwise gates on admin approval
--   rate_limits  raise their own limits — the thing the developer docs tell
--                people to message an admin about
--   key_type     'standard' -> 'commission', crossing the key-type scope
--                boundary that RESTRICTED_SCOPES in lib/api-auth.ts enforces
--   webhook_url  point the platform's outbound webhook POST at any host the
--                function can reach, incl. link-local metadata
--                (169.254.169.254) — blind SSRF with a partially
--                attacker-controlled body
--
-- The status/rate_limits/key_type exposure pre-dates the api-v2 work; the
-- webhook_url exposure arrived with 20260824_v2_new_products.sql.
--
-- Audited before applying: 0 of 39 keys had a webhook_url set, all 4 pending
-- keys had updated_at == created_at, and every active standard key showed a
-- plausible created->approved gap. No evidence of exploitation.
--
-- SAFE because every api_keys WRITE in the app already runs on the service-role
-- client, which bypasses RLS and grants entirely:
--   app/api/user/api-keys/route.ts   createRouteClient is used ONLY for
--                                    getUser(); insert/delete go through
--                                    createServerClient
--   app/api/admin/api-keys/route.ts  createServerClient throughout (status
--                                    approval, rate_limits updates)
--   lib/api-auth.ts                  last_used_at stamp — service-role
-- No client-side Supabase access to this table exists.
--
-- SELECT is deliberately RETAINED: app/api/sms/api-usage/route.ts reads
-- api_keys through createRouteClient (an RLS client). RLS still scopes those
-- reads to the caller's own rows via the two surviving SELECT policies.

REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM anon;

-- Drop the now-unreachable write policies so the policy list stops advertising
-- a capability the grants no longer permit. Leaving them in place would let a
-- future `GRANT UPDATE ... TO authenticated` silently reopen the hole with no
-- visible policy change for a reviewer to catch.
DROP POLICY IF EXISTS "api_keys: user update own"     ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: update own or admin" ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: user insert own"     ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: insert own or admin" ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: user delete own"     ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: delete own or admin" ON public.api_keys;

-- Post-apply state, verified:
--   authenticated/anon INSERT|UPDATE|DELETE grants ...... 0
--   authenticated SELECT grant ........................... 1 (retained)
--   authenticated/anon column-level UPDATE grants ........ 0
--   surviving policies ... "api_keys: admin full access" (ALL, admin-gated,
--                          now inert for `authenticated` since the underlying
--                          grants are gone), "api_keys: select own or admin",
--                          "api_keys: user select own"
