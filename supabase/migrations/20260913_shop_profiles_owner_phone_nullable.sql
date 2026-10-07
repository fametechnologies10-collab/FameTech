-- Relax owner_phone to nullable on shop_profiles.
-- The shop-setup wizard now creates the shop_profiles row on Step 1 with
-- only shop_name/shop_slug; owner_phone is collected later and enforced
-- right before go-live (see app/api/shop/pricing/route.ts go-live gate),
-- not at row-creation time. See app/api/shop/profile/route.ts.
ALTER TABLE shop_profiles ALTER COLUMN owner_phone DROP NOT NULL;
