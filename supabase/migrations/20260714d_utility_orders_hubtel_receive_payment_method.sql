-- ============================================================================
-- 20260714d_utility_orders_hubtel_receive_payment_method.sql
-- Task 6a follow-up: widen utility_orders.payment_method CHECK to allow
-- 'hubtel_receive'.
--
-- Task 6a (app/api/shop/utility/charge/route.ts) converts storefront utility
-- checkout from the old Hubtel Online-Checkout redirect seam
-- (payment_method='hubtel_checkout') to the Direct Receive Money in-app MoMo
-- rail, and inserts new rows with payment_method='hubtel_receive'. The
-- original CHECK constraint from 20260709_utility_bills.sql only allows
-- ('wallet','hubtel_checkout','ussd_momo','ussd_wallet') — without this
-- migration EVERY storefront utility insert throws a CHECK-constraint
-- violation once hubtel_receive_enabled_utility is flipped 'true'. Discovered
-- during Task 6a's implementation self-review; additive/non-destructive
-- (existing rows keep their historical 'hubtel_checkout' value, which stays
-- valid). DO NOT apply automatically — reviewed and applied to prod by the
-- controller, same as its parent migration.
-- ============================================================================
ALTER TABLE public.utility_orders DROP CONSTRAINT IF EXISTS utility_orders_payment_method_check;
ALTER TABLE public.utility_orders ADD CONSTRAINT utility_orders_payment_method_check
  CHECK (payment_method IN ('wallet','hubtel_checkout','hubtel_receive','ussd_momo','ussd_wallet'));
