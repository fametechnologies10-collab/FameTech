-- AFA storefront v2 Task 1: percentage markup -> flat selling-price model.
-- Feature has never gone live (storefront_afa_enabled = "false", 0 shop AFA orders),
-- so no data preservation is needed; old percentage config is simply cleared.

ALTER TABLE shop_profiles ADD COLUMN IF NOT EXISTS afa_selling_price numeric;

-- Clear the old percentage config. The feature never went live, so nothing is lost.
UPDATE shop_profiles SET afa_fee_percent = NULL;

-- DELIBERATELY NOT DROPPED HERE. An earlier revision of this migration ran
-- `ALTER TABLE shop_profiles DROP COLUMN afa_fee_percent` and took every shop
-- storefront down: the already-deployed code on main still names that column in
-- its PostgREST select list (app/shop/[shopSlug]/page.tsx,
-- app/shop-domain/[shopSlug]/page.tsx, app/dashboard/shop/pricing/page.tsx), and
-- PostgREST rejects a select referencing a column that does not exist. TypeScript
-- cannot catch this because those selects are runtime strings.
--
-- Expand first, contract later: this migration only ADDS afa_selling_price and
-- stops using the old column. Dropping afa_fee_percent must happen in its own
-- migration, applied only AFTER the code that no longer references it is deployed.

-- Reset caps to no-limit (0), stored as jsonb numbers like mashup_shop_fee_max_*.
UPDATE shop_global_settings
SET value = to_jsonb(0)
WHERE key IN ('afa_shop_fee_max_customer', 'afa_shop_fee_max_agent', 'afa_shop_fee_max_dealer');

-- storefront_afa_enabled is intentionally left untouched (stays "false").
