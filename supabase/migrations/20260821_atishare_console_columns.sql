-- ============================================================================
-- MIGRATION: AT-iShare Console (SPFastIT) supplier columns
-- Date:      2026-08-21
--
-- Adds supplier #8. Two identifiers are stored because either may be needed to
-- resolve an order (checklist item 14):
--   atishare_console_reference      — the client_reference WE send (order id + retry suffix)
--   atishare_console_transaction_id — the EXTQ_... id THEY return, and the only key
--                                     accepted by their check_order_status endpoint
-- ============================================================================

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

-- The value list below is the LIVE constraint definition, verified 2026-08-21 via
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'orders_fulfillment_method_check';
-- with 'atishare_console' appended and NOTHING else changed. Do not add or reorder
-- values. In particular 'datagod_failed' must NOT appear here: it is a value written to
-- mtn_fulfillment_tracking.api_response.supplier, never to orders.fulfillment_method,
-- and adding it would silently widen a production constraint.
ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_method_check
  CHECK (fulfillment_method IN (
    'auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata',
    'agentportal', 'datagod', 'bundleportal', 'hendylinks',
    'atishare_console'
  ));

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS atishare_console_reference text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS atishare_console_transaction_id text;

-- Partial index: the status sweep joins on the transaction id, and only a tiny
-- fraction of orders will ever have one.
CREATE INDEX IF NOT EXISTS idx_orders_atishare_console_transaction_id
  ON public.orders (atishare_console_transaction_id)
  WHERE atishare_console_transaction_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
