-- Fametech schema snapshot: auth trigger + storage bucket
-- Source: read-only introspection of the original source production database (schema only, NO data).
-- Run LAST (needs public.handle_new_user() from 04_functions.sql and public.users from 02_tables.sql).

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Public bucket for shop logos (5 MiB limit, images only). Per-user-folder write
-- policies on storage.objects are in 07_policies.sql.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('shop-logos', 'shop-logos', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- NOTE: 07_policies.sql also carries a legacy "Shop Banners Auth Delete" policy for a
-- 'shop-banners' bucket that does NOT exist in the source DB. Review/drop it (Stage 5).
