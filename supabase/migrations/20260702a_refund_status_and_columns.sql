-- 20260702a_refund_status_and_columns.sql
-- Refund system foundation: first-class 'refunded' terminal status, refund provenance columns,
-- widen source/type CHECKs, and a scoped unique index guaranteeing one refund ledger row per order.
BEGIN;

-- 1. First-class terminal 'refunded' status (cron-safe: retry crons filter on pending/processing)
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','processing','completed','failed','refunded'));

ALTER TABLE public.airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_status_check;
ALTER TABLE public.airtime_orders ADD CONSTRAINT airtime_orders_status_check
  CHECK (status IN ('pending','processing','completed','failed','refunded'));
-- shop_orders + results_checker_orders already allow 'refunded' — no change.

-- 2. Refund provenance columns (idempotent adds)
ALTER TABLE public.orders          ADD COLUMN IF NOT EXISTS refunded_by uuid REFERENCES public.users(id);
ALTER TABLE public.orders          ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE public.orders          ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE public.shop_orders     ADD COLUMN IF NOT EXISTS refunded_by uuid REFERENCES public.users(id);
ALTER TABLE public.shop_orders     ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE public.shop_orders     ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE public.shop_orders     ADD COLUMN IF NOT EXISTS refund_method text; -- 'owner_wallet' | 'paystack'
ALTER TABLE public.airtime_orders  ADD COLUMN IF NOT EXISTS refunded_by uuid REFERENCES public.users(id);
ALTER TABLE public.airtime_orders  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE public.airtime_orders  ADD COLUMN IF NOT EXISTS refund_reason text;

-- 3. Fix invisible airtime debits: allow 'airtime' source (existing UI filter already expects it)
ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
  CHECK (source IN ('payment','refund','admin','purchase','ussd','airtime'));

-- 4. Allow shop profit reversal ledger rows
ALTER TABLE public.shop_wallet_transactions DROP CONSTRAINT IF EXISTS shop_wallet_transactions_type_check;
ALTER TABLE public.shop_wallet_transactions ADD CONSTRAINT shop_wallet_transactions_type_check
  CHECK (type IN ('profit','withdrawal','profit_reversal'));

-- 5. Hard idempotency guard: one refund ledger row per NEW-format reference (belt to the RPC's suspenders).
--    Scoped to 'REFUND-%' so pre-existing legacy double-refund rows (reference 'REF-GHD-*') do not
--    block index creation. All new RPCs emit 'REFUND-ORDER-*' / 'REFUND-AIRTIME-*' / 'REFUND-SHOP-OWNER-*'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_refund_reference
  ON public.wallet_transactions (reference)
  WHERE source = 'refund' AND reference LIKE 'REFUND-%';

COMMIT;
