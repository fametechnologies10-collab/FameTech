-- ===================================================================
-- MTN Mashup Feature Migration
-- Adds `type` and `bundle_preference` columns to airtime_orders
-- Backward-compatible: defaults preserve all existing airtime records
-- ===================================================================

-- 1. Add order type column (airtime | mashup)
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'airtime'
    CHECK (type IN ('airtime', 'mashup'));

-- 2. Add bundle preference column (null for airtime, required for mashup)
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS bundle_preference TEXT
    CHECK (bundle_preference IN ('balanced', 'data', 'voice') OR bundle_preference IS NULL);

-- 3. Index for fast filtering by type in admin views
CREATE INDEX IF NOT EXISTS idx_airtime_orders_type ON public.airtime_orders (type);

-- 4. Comment the columns for documentation
COMMENT ON COLUMN public.airtime_orders.type IS 'Order type: airtime (direct top-up) or mashup (MTN bundle package)';
COMMENT ON COLUMN public.airtime_orders.bundle_preference IS 'Mashup bundle preference: balanced, data (data focus), or voice (voice focus). NULL for airtime orders.';
