-- ============================================================================
-- Seed: default OFF row for the MTN Express Delivery switch.
-- Date: 2026-06-22
-- admin_settings.value is JSONB and the app stores JSON *strings* ("true"/"false")
-- so its string comparisons (=== 'true') work. Seeding "false" makes the disabled
-- state explicit WITHOUT changing behavior (the app already treats an absent row
-- as false / normal delivery). ON CONFLICT DO NOTHING is a no-op on existing rows.
--   mtn_express_delivery_enabled -> off  (app default when absent: false)
-- ============================================================================

INSERT INTO public.admin_settings (key, value) VALUES
    ('mtn_express_delivery_enabled', '"false"'::jsonb)
ON CONFLICT (key) DO NOTHING;
