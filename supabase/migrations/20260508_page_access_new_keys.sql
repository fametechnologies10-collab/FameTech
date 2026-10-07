-- Migration: Add missing page-access control keys for admin settings
-- Safe to run multiple times (ON CONFLICT DO NOTHING)
-- These keys default to 'true' so no existing user access is disrupted

INSERT INTO public.admin_settings (key, value) VALUES
  ('page_access_results_checker', 'true'),
  ('page_access_upgrade',         'true'),
  ('page_access_transactions',    'true'),
  ('page_access_afa_orders',      'true')
ON CONFLICT (key) DO NOTHING;
