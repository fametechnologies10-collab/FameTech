-- 20260824_v2_new_products.sql
-- Phase 2A (API v2 new products): adds source/api_key_id tracking so
-- airtime/results-checker/AFA orders placed via the developer API are
-- attributable, and per-key webhook config for automatic delivery
-- notifications. See docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md.

-- airtime_orders had NEITHER source NOR api_key_id (unlike every other
-- order table). Added nullable with no default, then backfilled from the
-- existing reference_code convention — a NOT NULL DEFAULT 'web' would
-- mislabel every existing shop/USSD row. (Applied 2026-08-24: the backfill
-- classified 169 shop + 61 ussd_shop + 267 web rows, so 230 rows would have
-- been mislabelled by a blanket default.)
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.api_keys(id);

UPDATE public.airtime_orders
SET source = CASE
    WHEN reference_code LIKE 'SHOP-%' THEN 'shop'
    WHEN reference_code LIKE 'USSD-AIR-%' THEN 'ussd_shop'
    ELSE 'web'
END
WHERE source IS NULL;

-- results_checker_orders and afa_orders already have `source` (NOT NULL) but
-- were missing api_key_id.
ALTER TABLE public.results_checker_orders ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.api_keys(id);
ALTER TABLE public.afa_orders ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.api_keys(id);

-- Per-key webhook config. One row per api_keys row, so standard and
-- commission keys get independently configurable webhooks. Never populated
-- with a default — a key with no webhook_url configured simply never fires
-- one (checked at dispatch time, not enforced here).
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS webhook_url text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS webhook_secret text;
