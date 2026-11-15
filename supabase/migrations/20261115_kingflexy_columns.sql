-- ============================================================================
-- MIGRATION: KingFlexyGH data-bundle supplier columns
-- Date:      2026-11-15
--
-- Adds a new per-network fulfillment supplier, tag 'kingflexy' (KingFlexyGH data bundles,
-- fulfilled via the same vendor account already used for commission/standard bundles, but as
-- a regular per-network data supplier for `orders`).
--
-- Single reference column (like SPFastIT): every recovery path (webhook, cron sweep) matches
-- on kingflexy_reference alone. No event table (spec amendment 1).
-- ============================================================================

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

-- Value list verified against the LIVE constraint (Task 5 Step 1) with 'kingflexy' appended
-- and nothing else changed.
ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_method_check
  CHECK (fulfillment_method IN (
    'auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata',
    'agentportal', 'datagod', 'bundleportal', 'hendylinks',
    'atishare_console', 'spfastit', 'kingflexy'
  ));

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS kingflexy_reference text;

CREATE INDEX IF NOT EXISTS idx_orders_kingflexy_reference
  ON public.orders (kingflexy_reference)
  WHERE kingflexy_reference IS NOT NULL;

NOTIFY pgrst, 'reload schema';
