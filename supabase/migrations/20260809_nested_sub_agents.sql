-- supabase/migrations/20260809_nested_sub_agents.sql
-- =============================================================================
-- Nested sub-agent network (spec §3) – schema foundation.
--
-- Alters : sub_agents (+may_recruit)
-- New    : shop_order_splits (per-ancestor credit ledger for a chain sale)
-- RLS    : beneficiary reads own split rows. NO client writes – every insert
--          goes through the service-role webhook path / SECURITY DEFINER RPCs.
--
-- Additive + idempotent. shop_orders.parent_shop_id/parent_profit are RETAINED
-- as a compatibility mirror of the level-1 row (spec §3.2); wallet credits are
-- driven from shop_order_splits ONLY, so no party can be credited twice.
-- =============================================================================

-- 1. Recruiting right – granted ONLY by the sub's immediate parent (spec §5.1).
--    Defaults FALSE so the feature ships dark: no existing sub gains the right
--    until someone deliberately grants it.
ALTER TABLE public.sub_agents
  ADD COLUMN IF NOT EXISTS may_recruit BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Per-ancestor credit ledger. One row per ANCESTOR credited on a sale; the
--    selling leaf's own profit stays on shop_orders.profit.
CREATE TABLE IF NOT EXISTS public.shop_order_splits (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id            UUID NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  beneficiary_shop_id UUID NOT NULL REFERENCES public.shop_profiles(id),
  -- Hop distance above the leaf: 1 = immediate parent, 2 = grandparent.
  -- Capped at 2 because max chain depth is 3 (spec §1).
  level               SMALLINT NOT NULL CHECK (level IN (1, 2)),
  profit              DECIMAL(12,2) NOT NULL CHECK (profit >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency backstop: a replayed Paystack webhook cannot double-credit.
  UNIQUE (order_id, beneficiary_shop_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_order_splits_order
  ON public.shop_order_splits(order_id);
CREATE INDEX IF NOT EXISTS idx_shop_order_splits_beneficiary
  ON public.shop_order_splits(beneficiary_shop_id);

-- 3. RLS – read-only for the beneficiary; all writes are service-role.
ALTER TABLE public.shop_order_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_order_splits_beneficiary_read" ON public.shop_order_splits;
CREATE POLICY "shop_order_splits_beneficiary_read" ON public.shop_order_splits
  FOR SELECT USING (
    beneficiary_shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = auth.uid())
  );
-- (No INSERT/UPDATE/DELETE policy: writes happen via the service-role webhook
--  path and SECURITY DEFINER RPCs, matching the sub_agents table convention.)

-- =============================================================================
-- Apply notes (Manual Action – non-interactive session cannot run Supabase OAuth):
--   1. Apply to a Supabase BRANCH first (never prod directly).
--   2. Run get_advisors – expect zero new RLS/security warnings.
--   3. Regenerate types/supabase.ts.
-- =============================================================================
