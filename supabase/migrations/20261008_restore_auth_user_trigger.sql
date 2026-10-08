-- Restore the auth.users -> public.users profile trigger on the FameTech project.
--
-- Root cause (2026-10-08): the schema snapshot's last file
-- (supabase/snapshot/09_auth_trigger_and_storage.sql) was never applied to the new
-- project, so signups created an auth.users row but NO public.users row. The dashboard
-- layout then found no phone_number and redirected every new user to
-- /auth/complete-profile in a loop. handle_new_user() existed; the trigger did not.
--
-- Idempotent: safe to re-run.

-- 1. The trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Backfill profiles for accounts created while the trigger was missing.
--    Mirrors handle_new_user() exactly (same name/phone resolution, same defaults).
--    Inserting into public.users fires the existing wallet trigger.
INSERT INTO public.users (id, email, first_name, last_name, phone_number, role, status)
SELECT
  u.id,
  u.email,
  COALESCE(
    NULLIF(u.raw_user_meta_data->>'first_name', ''),
    SPLIT_PART(COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), NULLIF(u.raw_user_meta_data->>'name', ''), ''), ' ', 1),
    ''
  ),
  COALESCE(
    NULLIF(u.raw_user_meta_data->>'last_name', ''),
    CASE
      WHEN POSITION(' ' IN COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), NULLIF(u.raw_user_meta_data->>'name', ''), '')) > 0
      THEN SUBSTRING(
             COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), NULLIF(u.raw_user_meta_data->>'name', ''), '')
             FROM POSITION(' ' IN COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), NULLIF(u.raw_user_meta_data->>'name', ''), '')) + 1)
      ELSE ''
    END,
    ''
  ),
  NULLIF(u.raw_user_meta_data->>'phone_number', ''),
  'customer',
  'active'
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.users p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;

-- 3. Shop logo bucket (also from snapshot 09, also missing)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('shop-logos', 'shop-logos', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;
