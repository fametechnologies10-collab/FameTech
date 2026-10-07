-- ============================================================
-- Fix: USSD data-bundle orders failed to insert
--
-- The USSD fulfillment pipeline (lib/ussd/fulfillment/data.ts) inserts
-- `payment_method` ('momo' | 'wallet') into public.orders, but that column
-- only existed on results_checker_orders and afa_orders — it was never
-- added to the orders table. Every USSD data order insert therefore failed
-- with PGRST204 "Could not find the 'payment_method' column of 'orders'".
-- With wallet payment, the balance was debited first, so the customer was
-- charged with no order created.
--
-- Fix: add payment_method to orders, matching the exact definition already
-- used on results_checker_orders and afa_orders (text, nullable, default
-- 'momo'). This repairs the insert AND lets admins distinguish wallet- vs
-- momo-paid USSD orders (source IN ('ussd','ussd_shop')).
-- ============================================================

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'momo';

COMMENT ON COLUMN public.orders.payment_method IS
    'How the order was paid: momo (default) or wallet. Used by USSD fulfillment to track Flexy-Wallet vs Mobile Money payments.';
