-- supabase/migrations/20260907_sub_agent_account_edge.sql
-- =============================================================================
-- Sub-agent simple model (spec §3) — user-to-user edge, one level only.
--
-- upline_shop_id is RETAINED from the old chain-split schema (2026-08-09) and
-- left unused — dropping a live column while old code may still reference it is
-- a needless risk. This migration only ADDS the new edge alongside it.
--
-- Depth is a single lookup by construction: a row here identifies its user_id
-- as permanently ineligible to ever recruit (spec C1), enforced at the route
-- that grants recruiting rights (Plan 3), never by a walk — there is nothing to
-- walk in a one-level model.
-- =============================================================================

ALTER TABLE public.sub_agents
  ADD COLUMN IF NOT EXISTS upline_user_id UUID REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS idx_sub_agents_upline_user
  ON public.sub_agents(upline_user_id);

-- Backfill for live rows written under the old chain-split schema (2026-08-09), where
-- upline_shop_id was the only edge recorded. Without this, every existing sub_agents row
-- gets upline_user_id = NULL post-migration, and resolveSubAgentContext (lib/sub-agent-account.ts)
-- treats a missing recruiterId as effectiveActive:false — hard-blocking every live sub-agent
-- from AFA, Results-Checker AND data-bundle purchases (review finding C3, final review of
-- docs/superpowers/plans/2026-09-09-subagent-afa-rc-dashboard-wiring.md).
--
-- shop_profiles.owner_id -> users.id is the established shop-to-user join used throughout this
-- codebase (e.g. the "sub_agents_lead_read" RLS policy above, shop_invites, shop_orders RLS —
-- all join shop_profiles ON owner_id = auth.uid()/users.id). upline_shop_id is NOT NULL on
-- sub_agents by the original 20260701_sub_agents.sql schema, so every row has an owning shop to
-- resolve through.
UPDATE public.sub_agents sa
SET upline_user_id = sp.owner_id
FROM public.shop_profiles sp
WHERE sa.upline_shop_id = sp.id
  AND sa.upline_user_id IS NULL
  AND sp.owner_id IS NOT NULL;

-- Safety net, not the expected path: if a row's owning shop has no owner_id (orphaned shop) or
-- the shop row itself cannot be resolved, the backfill above leaves upline_user_id NULL. Rather
-- than silently hard-blocking that user with no explanation (the pre-fix behaviour), explicitly
-- flag it via the existing 'suspended' status — sub_agents.status is CHECK-constrained to
-- ('pending','active','suspended') only (see 20260701_sub_agents.sql), so this reuses a value
-- resolveSubAgentContext already treats as a safe, inactive, explained state
-- ("Your sub-agent account has been suspended") rather than inventing a new status value that
-- would require widening that constraint.
UPDATE public.sub_agents
SET status = 'suspended', updated_at = NOW()
WHERE upline_user_id IS NULL
  AND status <> 'suspended';

-- A new, distinct role (spec C12) — for transparency and admin visibility, NOT
-- for pricing. resolveSubAgentContext / resolveSubAgentCost never key off this
-- value; a sub-agent's cost is always recruiter-derived (spec C2).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    -- No existing named check constraint to extend — record this so a future
    -- reader knows the role column is validated some other way (application
    -- layer, or a differently-named constraint) and this ALTER was a no-op.
    RAISE NOTICE 'users_role_check not found — role is not DB-constrained under that name; verify at the application layer before creating subagent users.';
  ELSE
    ALTER TABLE public.users DROP CONSTRAINT users_role_check;
    ALTER TABLE public.users ADD CONSTRAINT users_role_check
      CHECK (role = ANY (ARRAY['customer','agent','dealer','admin','sub-admin','subagent']));
  END IF;
END $$;

-- Recruit cap (spec §6), admin-configurable, defaulting to 5.
INSERT INTO public.shop_global_settings (key, value)
VALUES ('sub_agent_max_recruits', '5')
ON CONFLICT (key) DO NOTHING;
