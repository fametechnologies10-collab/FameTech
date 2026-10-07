-- =============================================================================
-- EMERGENCY (P0) — applied to prod 2026-06-24 via red-team finding.
-- 'authenticated'/'anon' held UPDATE on users.role + users.status, and the
-- users_update_combined RLS policy had WITH CHECK NULL — so any logged-in user could
--   PATCH /rest/v1/users?id=eq.<self> {"role":"admin"}  -> instant full platform admin
--   PATCH /rest/v1/users?id=eq.<self> {"status":"active"} -> self-unsuspend
-- Legit role/status changes (paid upgrades, admin assign/extend, cron downgrades) run
-- via the SERVICE-ROLE client (auth.uid() IS NULL). A direct authenticated PostgREST
-- request carries a non-null auth.uid(). This trigger blocks privilege escalation +
-- status change from any user-bound session, leaving service-role and self-downgrade-to-
-- lower-role flows intact. (Follow-up: also lock economic role self-assign dealer/agent.)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.guard_users_privilege_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        IF NEW.role IS DISTINCT FROM OLD.role AND NEW.role IN ('admin','sub-admin') THEN
            RAISE EXCEPTION 'SECURITY: self-assigning an admin role is forbidden';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'SECURITY: changing account status is not permitted for this session';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_users_privilege ON public.users;
CREATE TRIGGER trg_guard_users_privilege
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.guard_users_privilege_change();
