-- 20260826_airtime_source_default.sql
-- APPLIED to the live project 2026-08-26 via the apply_migration MCP tool.
--
-- Stops airtime_orders.source drifting back to NULL. Closes finding I2 from the
-- Phase 2A final review (.superpowers/sdd/2026-08-24-api-v2-new-products/).
--
-- 20260824_v2_new_products.sql added the column nullable-with-no-default and
-- backfilled history, but left every non-API writer unchanged. Result: the
-- column was accurate for everything before 2026-08-24 and only for 'api' after
-- it — the worst state for an analytics column, because it LOOKS populated.
-- The review found 3 NULL rows two days later; there were 9 by 2026-08-26, so
-- the drift was accelerating, not static.
--
-- Two halves, both required:
--   * this migration — a DEFAULT so an unremembered writer degrades to 'web'
--     instead of NULL, plus a backfill of the rows that drifted since.
--   * the application — all four writers now set `source` EXPLICITLY:
--       app/api/airtime/create/route.ts     'web'
--       lib/ussd/fulfillment/airtime.ts     'ussd_shop'
--       lib/shop-order-processor.ts         'shop'
--       app/api/v2/airtime/purchase/route.ts 'api'   (already did)
--     so the default is a safety net rather than the mechanism. A DEFAULT alone
--     would mislabel every USSD and storefront order as 'web' — which is exactly
--     why the original migration deliberately avoided one before the backfill.

ALTER TABLE public.airtime_orders ALTER COLUMN source SET DEFAULT 'web';

-- Same classification as the original backfill, driven off the reference_code
-- conventions. Scoped to source IS NULL so it can never relabel a row a writer
-- already set correctly, and so re-running is a no-op.
UPDATE public.airtime_orders
SET source = CASE
    WHEN reference_code LIKE 'SHOP-%'     THEN 'shop'
    WHEN reference_code LIKE 'USSD-AIR-%' THEN 'ussd_shop'
    WHEN reference_code LIKE 'API-%'      THEN 'api'
    ELSE 'web'
END
WHERE source IS NULL;

-- Post-apply, verified:
--   NULL rows ........... 0
--   column_default ...... 'web'::text
--   distribution ........ web 269 / shop 170 / ussd_shop 67
