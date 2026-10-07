-- ============================================================================
-- MIGRATION: SPFastIT (full wallet account) supplier columns
-- Date:      2026-09-25
--
-- Adds a new fulfillment supplier, tag 'spfastit' — Telecel only. NOT the same product as
-- the already-integrated AT-iShare Console (supplier tag 'atishare_console'); same vendor,
-- unrelated API. See docs/reference/spfastit-supplier-api.md and
-- docs/superpowers/specs/2026-09-25-spfastit-telecel-supplier-design.md.
--
-- Single reference column (unlike AT-iShare Console's two): SPFastIT's /status endpoint
-- accepts lookup by OUR OWN reference directly, so there is no separate "their id" column to
-- store — every recovery path (webhook, cron sweep) matches on spfastit_reference alone.
-- ============================================================================

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

-- Value list verified against the LIVE constraint (Task 4 Step 1) with 'spfastit' appended
-- and nothing else changed.
ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_method_check
  CHECK (fulfillment_method IN (
    'auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata',
    'agentportal', 'datagod', 'bundleportal', 'hendylinks',
    'atishare_console', 'spfastit'
  ));

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS spfastit_reference text;

CREATE INDEX IF NOT EXISTS idx_orders_spfastit_reference
  ON public.orders (spfastit_reference)
  WHERE spfastit_reference IS NOT NULL;

NOTIFY pgrst, 'reload schema';
