-- Restore folder-scoped RLS on the shop-logos storage bucket, and retire the
-- shop-banners bucket policies (the shop banner-image feature has been removed).
--
-- Context:
--   20260511_emergency_storage_fix.sql replaced the per-folder INSERT/UPDATE
--   policies with wide-open ones (`WITH CHECK ( bucket_id = 'shop-logos' )`),
--   on the theory that `storage.foldername(name)[1]` was causing 400 errors.
--   That left any authenticated user able to write to ANY path in the bucket
--   via the Storage REST API directly — only the app route's path construction
--   (`${user.id}/...`) prevented cross-user writes (single-layer guard).
--
--   This migration restores the folder-scoped check (defence in depth) and
--   drops the now-unused shop-banners policies.
--
-- Run in the Supabase SQL Editor against the live project.

-- ── 1. Drop the wide-open policies ──────────────────────────────────────────
-- Emergency-migration names:
DROP POLICY IF EXISTS "shop_logos_insert_basic"   ON storage.objects;
DROP POLICY IF EXISTS "shop_logos_update_basic"   ON storage.objects;
DROP POLICY IF EXISTS "shop_banners_insert_basic" ON storage.objects;
DROP POLICY IF EXISTS "shop_banners_update_basic" ON storage.objects;
-- Older dashboard-created names (bucket-only checks despite the names) that
-- OR-bypass the folder-scoped policies below if left in place:
DROP POLICY IF EXISTS "Authenticated users can upload shop logos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own shop logos"     ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own shop logos"     ON storage.objects;

-- ── 2. Restore folder-scoped INSERT/UPDATE for shop-logos ───────────────────
-- Modern Supabase Postgres handles storage.foldername() correctly; the path
-- pattern written by /api/shop/upload is `{uid}/logo_{ts}.{ext}`, so segment 1
-- is the owner's uid.
DROP POLICY IF EXISTS "shop_logos_insert_user_folder" ON storage.objects;
CREATE POLICY "shop_logos_insert_user_folder" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'shop-logos' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "shop_logos_update_user_folder" ON storage.objects;
CREATE POLICY "shop_logos_update_user_folder" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'shop-logos' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "shop_logos_delete_user_folder" ON storage.objects;
CREATE POLICY "shop_logos_delete_user_folder" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'shop-logos' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Public read stays open via the bucket's public=true flag (storefront logos
-- are viewable by guests); no SELECT policy change needed.

-- ── 3. Tighten the shop-logos bucket limits back to sane values ─────────────
-- The emergency fix bumped this to 50MB / all MIME types to bust a cache.
-- The app caps logos at 5MB and only accepts JPG/PNG/WEBP.
UPDATE storage.buckets
SET
  file_size_limit    = 5242880, -- 5 MB
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'],
  public             = true
WHERE id = 'shop-logos';

-- ── 4. (Optional, run after wiping objects) retire the shop-banners bucket ──
-- The banner feature is removed and no code writes here anymore. Clear objects
-- first, then drop the bucket:
--   DELETE FROM storage.objects WHERE bucket_id = 'shop-banners';
--   DELETE FROM storage.buckets WHERE id = 'shop-banners';
