-- ============================================================
-- Special MTN Mashup — curated MTN package catalog.
--
-- Mashup packages are modeled as data_packages rows tagged
-- category='mtn_mashup' (network='MTN'), reusing the existing
-- wallet -> orders -> history -> complaints pipeline. Orders carry
-- the same category so they can be (a) filtered in my-orders and
-- (b) excluded from auto-fulfillment (they are fulfilled manually).
--
-- All columns are additive with safe defaults; existing rows
-- backfill to 'data', so no existing query breaks.
-- ============================================================

ALTER TABLE public.data_packages
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'data';

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'data';

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS fulfillment_note TEXT;

COMMENT ON COLUMN public.data_packages.category IS
    'Product category: data (default) or mtn_mashup (Special MTN Mashup curated packages).';
COMMENT ON COLUMN public.orders.category IS
    'Product category copied from the package: data (default) or mtn_mashup. mtn_mashup orders are fulfilled manually and excluded from auto-fulfillment.';
COMMENT ON COLUMN public.orders.fulfillment_note IS
    'Optional admin note / proof captured when a Special MTN Mashup order is processed manually.';
