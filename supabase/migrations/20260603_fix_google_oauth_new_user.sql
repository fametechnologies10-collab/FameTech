-- Fix: Google OAuth "Database error saving new user"
--
-- Root cause: handle_new_user() inserted phone_number = '' (empty string) for
-- OAuth users who have no phone at signup. Because phone_number had a UNIQUE +
-- NOT NULL constraint, the first Google signup succeeded but every subsequent
-- one failed with a unique-constraint violation that Supabase surfaces as
-- "Database error saving new user".
--
-- Fix 1: Make phone_number nullable — OAuth users legitimately have no phone
--        until they complete their profile via /auth/complete-profile.
-- Fix 2: Use NULLIF in the trigger so absent phones become NULL, not ''.
-- Fix 3: Backfill the one existing empty-string phone record to NULL.

-- ── 1. Allow NULL phone numbers ───────────────────────────────────────────────
ALTER TABLE public.users ALTER COLUMN phone_number DROP NOT NULL;

-- ── 2. Backfill existing empty-string phones ─────────────────────────────────
UPDATE public.users SET phone_number = NULL WHERE phone_number = '';

-- ── 3. Fix the trigger so it no longer inserts '' ────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.users (id, email, first_name, last_name, phone_number, role, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    -- NULL (not '') when phone is absent — prevents UNIQUE constraint violation
    -- for multiple OAuth users who haven't provided a phone yet.
    NULLIF(NEW.raw_user_meta_data->>'phone_number', ''),
    'customer',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- The wallet trigger handles wallet creation separately
  RETURN NEW;
END;
$function$;
