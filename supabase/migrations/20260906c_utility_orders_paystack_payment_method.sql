-- 20260906c_utility_orders_paystack_payment_method.sql
-- Bug fix: app/api/shop/utility/charge/route.ts's new Paystack branch inserts
-- payment_method='paystack', but utility_orders_payment_method_check never
-- allowed that value (['wallet','hubtel_checkout','hubtel_receive',
-- 'ussd_momo','ussd_wallet']) -- so every Paystack-rail order insert failed
-- the CHECK constraint, surfacing to the guest as "Failed to create order
-- record". Purely additive: preserves all 5 existing allowed values.
ALTER TABLE public.utility_orders DROP CONSTRAINT IF EXISTS utility_orders_payment_method_check;
ALTER TABLE public.utility_orders ADD CONSTRAINT utility_orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['wallet'::text, 'hubtel_checkout'::text, 'hubtel_receive'::text, 'ussd_momo'::text, 'ussd_wallet'::text, 'paystack'::text]));
