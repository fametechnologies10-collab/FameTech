-- ============================================================
-- USSD Utility Bills — sell ECG/Ghana Water/DSTV/GOtv/StarTimes bill payments
-- over USSD (main platform menu + shop menus), Task F-flow.
-- Reuses the existing utility_orders ledger (20260709_utility_bills.sql) and the
-- Task F-fulfill USSD fulfillment path. Ships behind ussd_utility_enabled = 'false'
-- (enable in admin when ready), same convention as 20260624_ussd_airtime.sql.
-- ============================================================

-- 1. Allow 'utility' as a USSD pending-order service type (mirrors step 2 of
--    20260624_ussd_airtime.sql, which last widened this CHECK for 'airtime').
ALTER TABLE public.ussd_pending_orders DROP CONSTRAINT IF EXISTS ussd_pending_orders_service_type_check;
ALTER TABLE public.ussd_pending_orders ADD CONSTRAINT ussd_pending_orders_service_type_check
  CHECK (service_type IN ('data', 'results_checker', 'afa', 'airtime', 'utility'));

-- 2. ussd_utility_enabled — new USSD menu toggle for "Pay Utility Bill", ships OFF.
--    Already seeded 'false' by 20260709_utility_bills.sql (seeds section, step 6);
--    this INSERT is a defensive no-op mirror of the 20260624_ussd_airtime.sql
--    convention (ON CONFLICT DO NOTHING) in case this migration ever runs standalone
--    against a database that skipped 20260709_utility_bills.sql.
INSERT INTO public.admin_settings (key, value) VALUES ('ussd_utility_enabled', to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;
