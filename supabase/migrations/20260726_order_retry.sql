-- ============================================================================
-- MIGRATION: Order retry — columns + attempt ledger
-- Date:      2026-07-26
-- See:       docs/superpowers/specs/2026-07-26-order-retry-design.md
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS retry_of_order_id uuid REFERENCES public.orders(id),
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_from_status text,
  ADD COLUMN IF NOT EXISTS retried_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS retried_by_role text;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_retry_from_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_retry_from_status_check
  CHECK (retry_from_status IS NULL OR retry_from_status IN ('failed', 'refunded'));

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_retried_by_role_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_retried_by_role_check
  CHECK (retried_by_role IS NULL OR retried_by_role IN ('admin', 'user'));

CREATE INDEX IF NOT EXISTS idx_orders_retry_of_order_id ON public.orders(retry_of_order_id)
  WHERE retry_of_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.order_retry_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  attempt_no int NOT NULL,
  new_order_id uuid REFERENCES public.orders(id),
  mode text NOT NULL CHECK (mode IN ('in_place', 'new_order')),
  actor_id uuid NOT NULL REFERENCES public.users(id),
  actor_role text NOT NULL CHECK (actor_role IN ('admin', 'user')),
  charged_amount numeric NOT NULL DEFAULT 0,
  funding_wallet_user_id uuid REFERENCES public.users(id),
  supplier text,
  supplier_reference text,
  status text NOT NULL CHECK (status IN ('claimed', 'dispatched', 'failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_order_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_order_retry_attempts_source ON public.order_retry_attempts(source_order_id);

ALTER TABLE public.order_retry_attempts ENABLE ROW LEVEL SECURITY;
-- No policies — service-role only, same access pattern as mtn_fulfillment_tracking.

REVOKE ALL ON public.order_retry_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.order_retry_attempts TO service_role;

NOTIFY pgrst, 'reload schema';
