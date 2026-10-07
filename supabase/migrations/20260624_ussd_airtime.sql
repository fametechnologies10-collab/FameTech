-- ============================================================
-- USSD Airtime — sell airtime over USSD with Hubtel Commission auto-fulfillment
-- Reuses the existing airtime_orders ledger + dispatchAirtimeFulfillment pipeline.
-- Ships behind ussd_airtime_enabled = 'false' (enable in admin when ready).
-- ============================================================

-- 1. USSD callers can be guests (no account). airtime_orders.user_id was NOT NULL;
--    relax it so a guest USSD airtime sale can be recorded (mirrors public.orders,
--    whose user_id is already nullable for guest USSD/shop orders). Existing dashboard
--    and storefront inserts always set user_id, so they are unaffected.
ALTER TABLE public.airtime_orders ALTER COLUMN user_id DROP NOT NULL;

-- 2. Allow 'airtime' as a USSD pending-order service type (the original CHECK only
--    permitted data/results_checker/afa).
ALTER TABLE public.ussd_pending_orders
    DROP CONSTRAINT IF EXISTS ussd_pending_orders_service_type_check;
ALTER TABLE public.ussd_pending_orders
    ADD CONSTRAINT ussd_pending_orders_service_type_check
    CHECK (service_type IN ('data', 'results_checker', 'afa', 'airtime'));

-- 3. New USSD airtime menu toggle — ships OFF. Enable in admin to surface "Airtime"
--    in the USSD menu. (Auto-fulfillment stays separately gated by
--    airtime_auto_fulfillment_enabled + the hubtel_commission_paused kill-switch.)
-- admin_settings.value is JSONB and every existing toggle is stored as a JSON *string*
-- ("true"/"false"), which the code compares with === 'true'. to_jsonb('false'::text) stores
-- the JSON string "false" (NOT the JSON boolean false) to stay consistent + toggle-correct.
INSERT INTO public.admin_settings (key, value) VALUES ('ussd_airtime_enabled', to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;

-- 4. With user_id now nullable, a guest USSD airtime sale is attributed to the shop
--    (shop_id) and may have a NULL or owner user_id. So shop owners can see their shop's
--    airtime sales via the RLS client, fold a shop-scoped clause INTO the existing
--    consolidated SELECT policy (recreated, NOT added as a second policy — a separate
--    permissive policy would re-trigger the "multiple permissive policies" advisor that
--    airtime_orders_select_combined was created to resolve). auth.uid() stays wrapped in a
--    SELECT to preserve the initplan optimisation. Admins + the fulfillment/cron/webhook
--    routes use the service role and bypass RLS.
DROP POLICY IF EXISTS "airtime_orders_select_combined" ON public.airtime_orders;
CREATE POLICY "airtime_orders_select_combined" ON public.airtime_orders FOR SELECT
  USING (
    (user_id = (SELECT auth.uid()))
    OR (EXISTS (SELECT 1 FROM public.users WHERE users.id = (SELECT auth.uid()) AND users.role = ANY (ARRAY['admin', 'sub-admin'])))
    OR (shop_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.shop_profiles sp WHERE sp.id = airtime_orders.shop_id AND sp.owner_id = (SELECT auth.uid())))
  );
