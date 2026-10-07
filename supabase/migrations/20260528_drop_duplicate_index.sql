-- ============================================================================
-- Drop Duplicate Index — shop_orders.paystack_reference
-- Created: 2026-05-28
--
-- public.shop_orders has two identical indexes on paystack_reference:
--   - idx_shop_orders_reference            (older, from shop_schema.sql:128)
--   - idx_shop_orders_paystack_reference   (newer, from 20260527_shop_orders_paystack_unique.sql:23)
--
-- Drop the older, generically-named one. Keep the newer, descriptively-named
-- one so future readers can tell at a glance which column it indexes.
--
-- Indexes are never referenced by name from application code, so dropping is
-- safe and reversible.
-- ============================================================================

DROP INDEX IF EXISTS public.idx_shop_orders_reference;

NOTIFY pgrst, 'reload schema';
