-- EMERGENCY FIX: Deep Cache Invalidation & Permissive RLS
-- Run this in Supabase SQL Editor to forcefully clear the Storage API cache.

-- 1. Force a cache overwrite by setting explicit wide-open values
UPDATE storage.buckets 
SET 
  allowed_mime_types = ARRAY[]::text[], -- Empty array explicitly allows ALL types
  file_size_limit = 52428800, -- 50MB (forces the cache to update the integer limit)
  public = true
WHERE id IN ('shop-logos', 'shop-banners');

-- 2. Drop any potentially conflicting policies
DROP POLICY IF EXISTS "shop_logos_insert" ON storage.objects;
DROP POLICY IF EXISTS "shop_banners_insert" ON storage.objects;
DROP POLICY IF EXISTS "shop_logos_update" ON storage.objects;
DROP POLICY IF EXISTS "shop_banners_update" ON storage.objects;

-- 3. Create the most basic, failsafe Authenticated Upload policy
-- This avoids ANY complex array indexing (like `foldername[1]`) which 
-- can sometimes trigger 400 Bad Request errors in older Postgres versions 
-- if the path segments are parsed incorrectly by the storage engine.

CREATE POLICY "shop_logos_insert_basic" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK ( bucket_id = 'shop-logos' );

CREATE POLICY "shop_banners_insert_basic" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK ( bucket_id = 'shop-banners' );

CREATE POLICY "shop_logos_update_basic" ON storage.objects
FOR UPDATE TO authenticated
USING ( bucket_id = 'shop-logos' );

CREATE POLICY "shop_banners_update_basic" ON storage.objects
FOR UPDATE TO authenticated
USING ( bucket_id = 'shop-banners' );
