-- ============================================================================
-- Seed: explicit default rows for the System Control Center kill-switches.
-- Date: 2026-06-22
-- admin_settings.value is JSONB and the app stores JSON *strings* ("true"/"false")
-- so its string comparisons (=== 'true', !== 'false') work. Each value below
-- equals the app's current inferred default, so ON CONFLICT DO NOTHING makes the
-- state explicit WITHOUT changing any behavior for existing installs.
--   auto_fulfillment_enabled   -> off  (app default when absent: false)
--   ussd_enabled               -> on   (app default when absent: true)
--   phone_verification_enabled -> off  (app default when absent: false)
--   page_access_storefront     -> on   (app default when absent: true)
-- ============================================================================

INSERT INTO public.admin_settings (key, value) VALUES
    ('auto_fulfillment_enabled',   '"false"'::jsonb),
    ('ussd_enabled',               '"true"'::jsonb),
    ('phone_verification_enabled', '"false"'::jsonb),
    ('page_access_storefront',     '"true"'::jsonb)
ON CONFLICT (key) DO NOTHING;
