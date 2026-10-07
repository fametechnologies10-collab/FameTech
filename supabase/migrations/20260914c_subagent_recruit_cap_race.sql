-- supabase/migrations/20260914c_subagent_recruit_cap_race.sql
-- =============================================================================
-- Plan 3, final-review I3 — close the recruit-cap race.
--
-- lib/sub-agent-create.ts's createSubAgent counts existing sub_agents rows
-- against shop_global_settings.sub_agent_max_recruits, THEN inserts — two
-- separate round-trips with no lock between them. Two near-simultaneous
-- requests from the same recruiter can both pass the count check before
-- either inserts, exceeding the cap.
--
-- Fix: a BEFORE INSERT trigger on public.sub_agents that takes a
-- pg_advisory_xact_lock keyed on the recruiter's id BEFORE counting, so a
-- second concurrent insert for the same recruiter blocks until the first
-- transaction commits (or rolls back) and then re-counts including it. This
-- mirrors the established pattern for "check a per-user limit, then act"
-- races already used in this codebase — see enforce the open-request cap in
-- supabase/migrations/20260731_website_requests.sql (also a BEFORE INSERT
-- trigger, pg_advisory_xact_lock keyed on the acting user, RAISE EXCEPTION
-- with a literal caught by application code) and the CLAUDE.md-documented
-- convention for "User-submitted lead intake" per-user rate caps.
--
-- This closes the race independently of the caller — the app-level
-- pre-check in lib/sub-agent-create.ts stays as-is (a fast, friendly 403
-- without ever touching auth.admin.createUser for the COMMON case of a
-- recruiter already visibly at their cap); this trigger is the atomic
-- backstop that actually prevents the cap from ever being exceeded, catching
-- only the rare genuine race where two requests both passed the app-level
-- pre-check. In that rare case createSubAgent's existing
-- compensateFailedCreation cleanup (lib/sub-agent-create.ts) already handles
-- deleting the just-created (now-rejected) auth account — no change needed
-- there beyond mapping this trigger's error literal to the same friendly
-- message, done in that file alongside this migration.
--
-- upline_user_id IS NULL rows (legacy shop-invite sub-agents, pre-dating this
-- plan) are exempt — they were never subject to this cap in the first place
-- and this migration must not retroactively touch them.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_sub_agent_recruit_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count INTEGER;
  raw_cap TEXT;
  cap NUMERIC;
BEGIN
  IF NEW.upline_user_id IS NULL THEN
    RETURN NEW; -- legacy shop-invite rows are not subject to this cap
  END IF;

  -- Lock BEFORE counting (not after) — this is the entire fix. Two
  -- concurrent inserts for the same recruiter serialize here; the second
  -- only proceeds once the first's transaction has committed (and its row is
  -- therefore visible to this COUNT) or rolled back.
  PERFORM pg_advisory_xact_lock(hashtext('sub_agent_recruit_cap:' || NEW.upline_user_id::text));

  SELECT count(*) INTO current_count
  FROM public.sub_agents
  WHERE upline_user_id = NEW.upline_user_id;

  -- shop_global_settings.value is JSONB stored as a raw text-castable
  -- literal — mirrors the parseFloat(row.value) read convention already used
  -- in TypeScript (lib/sub-agent-create.ts, app/api/shop/withdraw/route.ts).
  SELECT value::text INTO raw_cap
  FROM public.shop_global_settings
  WHERE key = 'sub_agent_max_recruits';

  cap := NULLIF(raw_cap, '')::numeric;
  IF cap IS NULL OR cap <= 0 THEN
    cap := 5; -- DEFAULT_MAX_RECRUITS, kept in sync with lib/sub-agent-create.ts
  END IF;

  IF current_count >= cap THEN
    RAISE EXCEPTION 'SUB_AGENT_RECRUIT_CAP_EXCEEDED'
      USING HINT = 'Recruiter has reached their maximum number of sub-agents.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_sub_agent_recruit_cap ON public.sub_agents;
CREATE TRIGGER trg_enforce_sub_agent_recruit_cap
  BEFORE INSERT ON public.sub_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_sub_agent_recruit_cap();

REVOKE ALL ON FUNCTION public.enforce_sub_agent_recruit_cap() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- Apply notes (Manual Action — DO NOT apply until all Plan 3 tasks are done
-- and the user has given explicit approval to merge/apply, same as
-- 20260914_subagent_auth.sql / 20260914b_subagent_upline_shop_optional.sql):
--   1. Apply to a Supabase BRANCH first (never prod directly).
--   2. Run get_advisors — expect zero new RLS/security warnings.
--   3. Confirm lib/sub-agent-create.ts's insert-error handling maps the
--      'SUB_AGENT_RECRUIT_CAP_EXCEEDED' literal to the existing friendly
--      "You have reached your recruit limit" message (already done in this
--      fix round — see scripts/test-subagent-create.ts).
-- =============================================================================
