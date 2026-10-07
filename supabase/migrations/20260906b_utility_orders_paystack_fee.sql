-- 20260906b_utility_orders_paystack_fee.sql
-- Security-review fix: separate "what the customer paid" from "what the biller
-- gets charged" for storefront utility orders on the Paystack rail.
--
-- Before this: app/api/shop/utility/charge/route.ts's Paystack branch stored
-- amount = face value + Paystack fee into utility_orders.amount. But
-- dispatchUtilityCore (lib/utility-fulfillment.ts) reads that SAME column and
-- sends it verbatim to Hubtel Commission Services as the bill payment amount --
-- so the customer's meter/account was over-credited by the fee, and the
-- platform's Hubtel float silently absorbed it, on every Paystack-rail order.
--
-- Fix: utility_orders.amount stays face value ONLY (matching the Hubtel rail's
-- existing convention, and what dispatchUtilityCore correctly expects). The fee
-- actually collected from the customer is tracked here separately.
ALTER TABLE public.utility_orders
  ADD COLUMN IF NOT EXISTS paystack_fee numeric;
