-- Widen afa_orders_source_check to allow 'ussd_shop' (USSD orders placed through
-- a shop's USSD code). Expand-only: every previously allowed value is kept.
-- app/api/admin/ussd/sales/route.ts already filters afa_orders on
-- ['ussd','ussd_shop'], so this value was already expected elsewhere.
ALTER TABLE public.afa_orders DROP CONSTRAINT afa_orders_source_check;
ALTER TABLE public.afa_orders ADD CONSTRAINT afa_orders_source_check
  CHECK (source = ANY (ARRAY['web'::text, 'ussd'::text, 'api'::text, 'shop'::text, 'ussd_shop'::text]));
