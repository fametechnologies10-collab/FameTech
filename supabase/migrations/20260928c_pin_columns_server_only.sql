-- SEC (audit F6): the app-lock PIN columns on public.users were writable by the user's own
-- session (users_update_combined allows id = auth.uid()), so a session holder could skip
-- /api/auth/pin entirely: reset pin_attempts / pin_locked_until to escape the 5-try lockout,
-- or overwrite pin_hash / pin_salt with a PIN they know, bypassing the step-up check.
-- Low severity (no money action checks the PIN; requires the victim's session), but the fix
-- is small: /api/auth/pin now reads/writes these columns with the service role (auth.uid()
-- IS NULL there), and this guard rejects any change to them from a client session — the same
-- mechanism that already protects role / status / reseller expiry.
--
-- DEPLOY ORDER: apply only AFTER the /api/auth/pin service-role change is live, or PIN
-- set/verify would fail for users on the old code.

CREATE OR REPLACE FUNCTION public.guard_users_privilege_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'SECURITY: changing account role is not permitted for this session';
    END IF;
    IF NEW.agent_expires_at IS DISTINCT FROM OLD.agent_expires_at OR NEW.dealer_expires_at IS DISTINCT FROM OLD.dealer_expires_at THEN
      RAISE EXCEPTION 'SECURITY: changing reseller expiry is not permitted for this session';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'SECURITY: changing account status is not permitted for this session';
    END IF;
    IF NEW.pin_hash IS DISTINCT FROM OLD.pin_hash
       OR NEW.pin_salt IS DISTINCT FROM OLD.pin_salt
       OR NEW.pin_attempts IS DISTINCT FROM OLD.pin_attempts
       OR NEW.pin_locked_until IS DISTINCT FROM OLD.pin_locked_until THEN
      RAISE EXCEPTION 'SECURITY: app-lock PIN can only be changed through the PIN service';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- pin_reminder ('later'/'never' nag preference) is deliberately NOT pinned: it is harmless
-- UI state. Residual (accepted): a user can still SELECT their own pin_hash/pin_salt, which
-- only matters to someone who already holds that user's session.
-- Rollback: re-run the previous definition (without the PIN block) from
-- pg_get_functiondef history / git history of this file.
