-- supabase/migrations/20260914d_subagent_contact_lock_fix_scoping.sql
-- =============================================================================
-- Hotfix, discovered during migration apply (2026-09-14): 20260914_subagent_auth.sql's
-- contact-lock trigger scoped on `upline_user_id IS NOT NULL`, reasoning that only
-- genuine new-model rows (created by lib/sub-agent-create.ts) would ever have that
-- column populated. That assumption was falsified by 20260907_sub_agent_account_edge.sql's
-- OWN backfill, which runs earlier in the same apply sequence and populates
-- upline_user_id for every LEGACY row too (via shop_profiles.owner_id). Verified live
-- immediately after applying all 8 migrations: all 15 legacy sub_agents rows now have
-- upline_user_id IS NOT NULL — meaning the trigger as originally scoped would lock
-- their contact info too, exactly the bug it was meant to prevent.
--
-- Corrected signal: upline_shop_id. Every legacy (shop-invite) row has it NOT NULL
-- (the original schema's NOT NULL constraint, confirmed live: all 15 legacy rows have
-- upline_shop_id IS NOT NULL). lib/sub-agent-create.ts's INSERT (the only writer of
-- genuine new-model rows) never sets upline_shop_id at all, so it is NULL by construction
-- for every new-model row and always will be, regardless of what any other migration's
-- backfill does to upline_user_id. This is the correct, backfill-independent signal for
-- "was this row created via the new direct-recruit flow."
--
-- APPLIED LIVE 2026-09-14, immediately after 20260914_subagent_auth.sql, as part of the
-- same migration-apply session (all 8 planned migrations + this hotfix). Verified
-- post-apply: 0 legacy rows caught by the corrected scoping (was 15 before this fix).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_subagent_contact_lock()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.subagent_contact_override', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF (NEW.email IS DISTINCT FROM OLD.email OR NEW.phone_number IS DISTINCT FROM OLD.phone_number)
     AND EXISTS (
       SELECT 1 FROM public.sub_agents
       WHERE user_id = NEW.id AND upline_shop_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Contact info for a sub-agent account cannot be changed directly. Contact support.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
