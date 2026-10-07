-- Widen the USSD pending-order service_type CHECK to allow 'mashup' — the new
-- MTN Mashup USSD purchase flow (manually fulfilled, never sent to Hubtel).
-- Follows the same widening pattern as 20260624_ussd_airtime.sql and
-- 20260710d_ussd_utility.sql.
ALTER TABLE public.ussd_pending_orders DROP CONSTRAINT IF EXISTS ussd_pending_orders_service_type_check;
ALTER TABLE public.ussd_pending_orders ADD CONSTRAINT ussd_pending_orders_service_type_check
  CHECK (service_type IN ('data', 'results_checker', 'afa', 'airtime', 'utility', 'mashup'));
