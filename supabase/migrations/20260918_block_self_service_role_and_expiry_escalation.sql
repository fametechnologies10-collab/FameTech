-- CRITICAL privilege-escalation fix (confirmed exploitable against the live DB,
-- 2026-09-18, verified inside a rolled-back transaction as the `authenticated`
-- role carrying an ordinary user's own JWT).
--
-- THE HOLE
-- Three things lined up:
--   1. `authenticated` holds column-level UPDATE grants on users.role,
--      users.agent_expires_at and users.dealer_expires_at.
--   2. The `users_update_combined` RLS policy has a NULL WITH CHECK, so Postgres
--      falls back to its USING expression `(id = auth.uid()) OR is_admin()` for
--      the NEW row too -- which permits changing ANY column of your own row.
--   3. guard_users_privilege_change() only rejected role changes INTO
--      'admin'/'sub-admin', plus any status change. Self-promotion to 'agent' or
--      'dealer', and self-setting the expiry columns, sailed straight through.
--
-- So any authenticated user could:
--     PATCH /rest/v1/users?id=eq.<their own id>
--     {"role":"dealer","dealer_expires_at":"2099-01-01"}
-- and instantly obtain wholesale reseller pricing on every money path
-- (lib/pricing/cost-basis.ts reads role + these exact expiry columns), bypass
-- the "agents, dealers and admins only" bulk-order gate, cheapen their
-- withdrawal and Paystack fee tiers, and -- because 'dealer' IS in
-- admin_settings.api_allowed_roles -- hand themselves developer API access that
-- the operator had deliberately not granted. For a sub-agent specifically this
-- defeats the whole point of keeping 'subagent' out of api_allowed_roles.
--
-- THE FIX
-- Reject self-service role AND expiry changes outright whenever the statement
-- runs in a session that has an auth.uid(). Expiry is privilege, not profile
-- data: effectiveRoleFromExpiry() (lib/effective-role.ts) reads it on every
-- pricing decision, so a self-set far-future date is worth exactly as much as a
-- self-set role.
--
-- WHY THIS BREAKS NOTHING
-- auth.uid() IS NULL in a service-role / trigger / cron context, and EVERY
-- legitimate privilege change in this codebase runs there -- verified call site
-- by call site before writing this migration:
--   lib/wallet-upgrade.ts        -> buildAdminClient()   (paid agent/dealer upgrade)
--   lib/payments.ts              -> createServerClient()
--   lib/dealer-payments.ts       -> createServerClient()
--   lib/sub-agent-create.ts      -> receives the admin client from
--                                   app/api/dashboard/subagents (createServerClient())
--   app/api/admin/users/role, admin/assign-agent, admin/assign-dealer,
--   admin/extend-agent/permanent, agent|dealer/downgrade
--                                -> all authenticate with an RLS client but
--                                   perform the users write with createServerClient()
--   app/api/cron/downgrade-expired-agents|dealers -> service role
-- Ordinary self-service profile edits (name, phone, notification prefs) leave
-- role and both expiry columns untouched, so IS DISTINCT FROM is false for them
-- and they continue to work unchanged.
--
-- The pre-existing admin/sub-admin and status rules are preserved verbatim; the
-- role rule simply widens from "not into admin/sub-admin" to "not at all", and
-- the expiry rule is new.
CREATE OR REPLACE FUNCTION public.guard_users_privilege_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        -- Widened 2026-09-18: was `AND NEW.role IN ('admin','sub-admin')`, which
        -- left self-promotion to 'agent'/'dealer' wide open.
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'SECURITY: changing account role is not permitted for this session';
        END IF;
        -- New 2026-09-18: expiry columns are privilege, not profile.
        IF NEW.agent_expires_at IS DISTINCT FROM OLD.agent_expires_at
           OR NEW.dealer_expires_at IS DISTINCT FROM OLD.dealer_expires_at THEN
            RAISE EXCEPTION 'SECURITY: changing reseller expiry is not permitted for this session';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'SECURITY: changing account status is not permitted for this session';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;
