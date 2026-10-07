-- =====================================================================
-- Airtime & Mashup Admin Overhaul Migration
-- 2026-06-12
-- =====================================================================

-- 1. Split fee storage on airtime_orders
--    admin_fee_amount = platform's cut only (excludes shop markup)
--    shop_fee_amount  = shop owner's cut (0 for non-shop orders)
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS admin_fee_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS shop_fee_amount  DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Back-fill existing rows: assume 100% of fee_amount was admin profit
-- (shop orders pre-migration had combined fees — conservative approximation)
UPDATE public.airtime_orders
SET admin_fee_amount = fee_amount,
    shop_fee_amount  = 0
WHERE admin_fee_amount = 0;

-- 2. Fulfillment-service readiness columns
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS fulfillment_service    TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS fulfillment_request_id TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS fulfillment_metadata   JSONB DEFAULT NULL;

COMMENT ON COLUMN public.airtime_orders.fulfillment_service    IS 'External fulfillment provider: null=manual, ghdata, mtn_api, etc.';
COMMENT ON COLUMN public.airtime_orders.fulfillment_request_id IS 'External provider transaction/request ID for reconciliation';
COMMENT ON COLUMN public.airtime_orders.fulfillment_metadata   IS 'Provider-specific payload/response for debugging';

-- Index for future fulfillment reconciliation
CREATE INDEX IF NOT EXISTS idx_airtime_orders_fulfillment_service
    ON public.airtime_orders (fulfillment_service)
    WHERE fulfillment_service IS NOT NULL;

-- 3. Airtime fulfillment batches table
CREATE TABLE IF NOT EXISTS public.airtime_fulfillment_batches (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    created_by      UUID REFERENCES public.users(id),
    batch_name      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'partial', 'failed')),
    order_ids       UUID[] NOT NULL DEFAULT '{}',
    order_count     INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    fulfillment_service TEXT DEFAULT NULL,
    notes           TEXT DEFAULT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: admins only
ALTER TABLE public.airtime_fulfillment_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage airtime batches"
    ON public.airtime_fulfillment_batches
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = auth.uid()
              AND u.role IN ('admin', 'sub-admin')
        )
    );

CREATE INDEX IF NOT EXISTS idx_airtime_batches_status
    ON public.airtime_fulfillment_batches (status);
CREATE INDEX IF NOT EXISTS idx_airtime_batches_created_at
    ON public.airtime_fulfillment_batches (created_at DESC);

-- 4. New admin_settings keys

-- 4a. Dashboard master toggles (independent from storefront)
INSERT INTO public.admin_settings (key, value) VALUES
    ('dashboard_airtime_enabled', 'true'),
    ('dashboard_mashup_enabled',  'true')
ON CONFLICT (key) DO NOTHING;

-- 4b. Per-role transaction limits — airtime
INSERT INTO public.admin_settings (key, value) VALUES
    ('airtime_min_amount_customer', '1'),
    ('airtime_min_amount_agent',    '1'),
    ('airtime_min_amount_dealer',   '1'),
    ('airtime_max_amount_customer', '500'),
    ('airtime_max_amount_agent',    '1000'),
    ('airtime_max_amount_dealer',   '2000')
ON CONFLICT (key) DO NOTHING;

-- 4c. Per-role transaction limits — mashup
INSERT INTO public.admin_settings (key, value) VALUES
    ('mashup_min_amount_customer', '5'),
    ('mashup_min_amount_agent',    '5'),
    ('mashup_min_amount_dealer',   '5'),
    ('mashup_max_amount_customer', '500'),
    ('mashup_max_amount_agent',    '1000'),
    ('mashup_max_amount_dealer',   '2000')
ON CONFLICT (key) DO NOTHING;

-- 4d. Dedicated mashup fee rates (separate from airtime)
INSERT INTO public.admin_settings (key, value) VALUES
    ('mashup_fee_mtn_customer',    '5'),
    ('mashup_fee_mtn_agent',       '3'),
    ('mashup_fee_mtn_dealer',      '2'),
    ('mashup_fee_telecel_customer','5'),
    ('mashup_fee_telecel_agent',   '3'),
    ('mashup_fee_telecel_dealer',  '2'),
    ('mashup_fee_at_customer',     '5'),
    ('mashup_fee_at_agent',        '3'),
    ('mashup_fee_at_dealer',       '2')
ON CONFLICT (key) DO NOTHING;

-- 4e. Airtime dealer fee (was missing — already used in shop-order-processor)
INSERT INTO public.admin_settings (key, value) VALUES
    ('airtime_fee_mtn_dealer',    '2'),
    ('airtime_fee_telecel_dealer','2'),
    ('airtime_fee_at_dealer',     '2')
ON CONFLICT (key) DO NOTHING;

-- 4f. Mashup per-network enable toggles (independent from airtime toggles)
INSERT INTO public.admin_settings (key, value) VALUES
    ('mashup_enabled_mtn',    'true'),
    ('mashup_enabled_telecel','true'),
    ('mashup_enabled_at',     'true')
ON CONFLICT (key) DO NOTHING;
