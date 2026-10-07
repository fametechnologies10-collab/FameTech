-- Fix: handle_new_user trigger now correctly parses Google OAuth full_name.
--
-- Google OAuth provides user name as full_name / name (e.g. "King Flexy GH"),
-- NOT as separate first_name / last_name fields. The previous trigger read
-- first_name / last_name directly and inserted '' for all Google users.
-- The complete-profile flow fixes this later, but the initial DB state was bad.
--
-- This version:
--   1. Prefers explicit first_name / last_name metadata (email signup path).
--   2. Falls back to splitting full_name / name on the first space (OAuth path).
--   3. Still inserts NULL (not '') for phone_number when absent (preserves the
--      fix from 20260603_fix_google_oauth_new_user.sql).

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_full_name  text;
  v_first_name text;
  v_last_name  text;
  v_space_pos  int;
BEGIN
  v_full_name  := COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
      NULLIF(NEW.raw_user_meta_data->>'name',      ''),
      ''
  );

  v_first_name := COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'first_name', ''),
      SPLIT_PART(v_full_name, ' ', 1),
      ''
  );

  v_space_pos  := POSITION(' ' IN v_full_name);
  v_last_name  := COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'last_name', ''),
      CASE WHEN v_space_pos > 0
           THEN SUBSTRING(v_full_name FROM v_space_pos + 1)
           ELSE ''
      END,
      ''
  );

  INSERT INTO public.users (id, email, first_name, last_name, phone_number, role, status)
  VALUES (
      NEW.id,
      NEW.email,
      v_first_name,
      v_last_name,
      NULLIF(NEW.raw_user_meta_data->>'phone_number', ''),
      'customer',
      'active'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$;
