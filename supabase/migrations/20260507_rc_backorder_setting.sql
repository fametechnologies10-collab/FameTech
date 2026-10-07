-- =============================================================================
-- Migration: Add results_checker_allow_backorders admin setting
--
-- SECURITY: Backorders are DISABLED by default (value = 'false').
-- When disabled, the storefront will reject guest orders when stock < quantity,
-- matching the behaviour of the authenticated dashboard purchase route.
--
-- To enable backorders (allow paid orders even when stock = 0):
--   UPDATE admin_settings
--   SET value = 'true'
--   WHERE key = 'results_checker_allow_backorders';
-- =============================================================================

INSERT INTO public.admin_settings (key, value)
VALUES ('results_checker_allow_backorders', 'false')
ON CONFLICT (key) DO NOTHING;
