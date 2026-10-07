-- 20260702f_drop_refunded_by_fks.sql
-- FIX: the refunded_by FKs added in 20260702a created a SECOND orders->users relationship,
-- which breaks PostgREST embeds like orders.select('*, users(...)') with:
--   "Could not embed because more than one relationship was found for 'orders' and 'users'".
-- refunded_by is a pure audit column (always set from a validated session user id, or null from
-- the Paystack refund webhook), so it does not need FK enforcement. Dropping these constraints
-- removes the embedding ambiguity for every query at once. The columns themselves are kept.
ALTER TABLE public.orders         DROP CONSTRAINT IF EXISTS orders_refunded_by_fkey;
ALTER TABLE public.airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_refunded_by_fkey;
ALTER TABLE public.shop_orders    DROP CONSTRAINT IF EXISTS shop_orders_refunded_by_fkey;
