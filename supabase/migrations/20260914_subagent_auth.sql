-- supabase/migrations/20260914_subagent_auth.sql
-- =============================================================================
-- Plan 3 (spec: docs/superpowers/specs/2026-09-14-subagent-auth-design.md)
-- Adds: pending-key columns for the grace-period regenerate flow (C5), and a
-- hard DB-layer lock on a sub-agent's contact info (C6) with a single,
-- explicit, narrow override RPC as the only escape hatch.
--
-- Verified against live schema conventions before writing:
--   - public.sub_agents.user_id UUID NOT NULL UNIQUE REFERENCES public.users(id)
--     (supabase/migrations/20260701_sub_agents.sql)
--   - public.users.email, public.users.phone_number TEXT (nullable since
--     supabase/migrations/20260603_fix_google_oauth_new_user.sql)
--   - RPC ACL pattern (REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT
--     EXECUTE ... TO service_role) mirrors set_sub_agent_state in
--     supabase/migrations/20260706_sub_invite_redeem.sql /
--     20260809b_nested_sub_rpcs.sql.
-- =============================================================================

ALTER TABLE public.sub_agents
  ADD COLUMN IF NOT EXISTS pending_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS pending_key_expires_at TIMESTAMPTZ;

-- Contact-info lock (spec C6). A per-transaction flag, set ONLY by the admin
-- override RPC below, is the sole way past this trigger — deliberately NOT
-- gated on Postgres/PostgREST role (auth.role() = 'service_role' would also
-- be true for every ordinary backend route that happens to use a service-role
-- client for unrelated reasons, which is common in this codebase and would
-- make the "lock" meaningless).
--
-- Scoping (final-review I1, 2026-09-14): the EXISTS clause below additionally
-- requires `upline_user_id IS NOT NULL`. Verified live against production
-- (read-only, via Supabase MCP execute_sql) before writing this: today's
-- public.sub_agents has exactly 15 rows, upline_shop_id NOT NULL on all of
-- them, and NO upline_user_id column exists yet at all (it ships in
-- 20260907_sub_agent_account_edge.sql, also unapplied, alongside this
-- migration) — every one of those 15 rows is a LEGACY row from the retired
-- shop-invite chain-split model. Only a row created by lib/sub-agent-create.ts
-- (Task 4's createSubAgent — confirmed it always sets upline_user_id on
-- insert, see the `sub_agents` insert in that file) is a genuine new-model
-- sub-agent who actually received a recruiter-issued access key and for whom
-- this lock buys real security. Without this extra condition, applying this
-- migration would immediately and permanently lock all 15 legacy users out of
-- their own self-service email/phone editing, with no in-product fix and no
-- security benefit (they never had a lockable access-key credential to begin
-- with). A future backfill that intentionally migrates a legacy row onto the
-- new model (giving it a real upline_user_id) will correctly start being
-- locked at that point — this scoping tracks "has a new-model recruiting
-- relationship", not merely "predates this migration".
CREATE OR REPLACE FUNCTION public.enforce_subagent_contact_lock()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.subagent_contact_override', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF (NEW.email IS DISTINCT FROM OLD.email OR NEW.phone_number IS DISTINCT FROM OLD.phone_number)
     AND EXISTS (
       SELECT 1 FROM public.sub_agents
       WHERE user_id = NEW.id AND upline_user_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Contact info for a sub-agent account cannot be changed directly. Contact support.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_enforce_subagent_contact_lock ON public.users;
CREATE TRIGGER trg_enforce_subagent_contact_lock
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_subagent_contact_lock();

-- The ONLY sanctioned way to change a sub-agent's contact info. Sets the
-- override flag for this transaction only (set_config's third arg `true`
-- scopes it to the current transaction, not the session), performs the
-- update, and the flag automatically clears at COMMIT — no manual reset
-- needed and no risk of it leaking into a later, unrelated statement on a
-- pooled connection.
--
-- =============================================================================
-- ⚠️  CRITICAL — INCOMPLETE ON ITS OWN FOR EMAIL CHANGES (final-review I2,
-- 2026-09-14). THIS RPC ONLY UPDATES public.users. It does NOT and CANNOT
-- touch auth.users — plpgsql has no way to call the Supabase Auth Admin API
-- (that's an HTTP call from application code, e.g. `supabase.auth.admin.
-- updateUserById`), and Postgres itself has no privileged write access into
-- Supabase's managed `auth.users` table from a SQL function.
--
-- Why this matters: `auth.users.email` is the ACTUAL Supabase Auth login
-- identifier — `signInWithPassword({ email, password })` authenticates
-- against auth.users, not public.users. Phone-login resolves the submitted
-- phone -> public.users.email -> signInWithPassword. If ANY future caller
-- uses `p_new_email` here to "fix" a sub-agent's email without ALSO calling
-- the Admin API's `updateUserById(subUserId, { email: newEmail })` in the
-- SAME operation, the result is a broken, confusing split state: the sub can
-- still log in with their OLD email (auth.users unchanged), while phone-login
-- and any future regenerate-key delivery would target the NEW, auth-unaware
-- email in public.users — neither path is fully correct.
--
-- Judgment call made here (deliberately NOT resolved by removing the
-- parameter): `p_new_email` is KEPT rather than dropped, because dropping it
-- would look like a design decision ("email is intentionally immutable even
-- for admin correction") when it is really "no JS admin-API-aware tool exists
-- yet to call this safely." No admin UI calls this RPC anywhere in this plan
-- (it is a schema-only escape hatch — see the Apply notes at the bottom of
-- this file). ANY future caller of `p_new_email` MUST be JS application code
-- that ALSO calls the Auth Admin API's `updateUserById` in the same logical
-- operation (ideally auth.users updated FIRST, then this RPC, so a failure
-- partway through never leaves auth.users pointing at an email public.users
-- disagrees with) — never a raw SQL/RPC-only call. Until such tooling exists,
-- treat this RPC as PHONE-SAFE, EMAIL-UNSAFE: an admin correcting a sub's
-- phone number in a pinch may call this directly; an admin correcting a sub's
-- email must not, until the paired Admin API call is built alongside it.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_update_subagent_contact(
  p_user_id UUID,
  p_new_email TEXT,
  p_new_phone TEXT
) RETURNS void AS $$
BEGIN
  PERFORM set_config('app.subagent_contact_override', 'true', true);
  UPDATE public.users
  SET email = COALESCE(p_new_email, email),
      phone_number = COALESCE(p_new_phone, phone_number)
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Callable ONLY via service-role (admin tooling) — never PostgREST-exposed
-- to anon/authenticated. Mirrors the RPC ACL pattern already used throughout
-- this feature (e.g. set_sub_agent_state in 20260706_sub_invite_redeem.sql /
-- 20260809b_nested_sub_rpcs.sql).
REVOKE ALL ON FUNCTION public.admin_update_subagent_contact(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_subagent_contact(UUID, TEXT, TEXT) TO service_role;

-- =============================================================================
-- Apply notes (Manual Action — DO NOT apply until all Plan 3 tasks are done
-- and the user has given explicit approval to merge/apply):
--   1. Apply to a Supabase BRANCH first (never prod directly).
--   2. Run get_advisors — expect zero new RLS/security warnings.
--   3. Regenerate types/supabase.ts.
--   4. KNOWN, ACCEPTED trade-off found during Step 2 verification: the
--      self-service PUT /api/users/update-profile route lets an
--      authenticated user change their own phone_number. If that user is a
--      sub-agent, this trigger will now reject the UPDATE (their whole
--      profile-update statement fails, even if first_name/last_name were also
--      being changed in the same call) with a generic 500 from that route,
--      since it doesn't special-case the trigger's 23514 error the way
--      idempotency checks elsewhere use PGRST116. This is the intended
--      enforcement of spec C6 (a sub-agent's contact info must never change
--      outside the admin RPC) but the error message surfaced to that user is
--      not yet friendly — a follow-up task should catch ERRCODE 23514 in
--      that route and return a clear "contact support" message instead of a
--      generic failure.
-- =============================================================================
