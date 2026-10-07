-- ============================================================================
-- MIGRATION: Widen orders.fulfillment_method CHECK constraint for 'bundleportal'
--            + add orders.bundleportal_reference column
-- Date:      2026-08-16
-- Problem:   The CHECK constraint (see 20260729b_widen_fulfillment_method_check_datagod.sql)
--            only allows ('auto','manual','codecraft','datakazina','xpress','ghdata',
--            'agentportal','datagod'). The new Bundle Portal dispatcher wiring stamps
--            fulfillment_method = 'bundleportal' on dispatch — without this migration,
--            the atomic claim UPDATE fails the CHECK and every Bundle Portal order is
--            silently left 'pending' (fail-safe, but blocks the integration entirely).
-- Fix:       Drop and recreate the CHECK constraint to include 'bundleportal'; add a
--            bundleportal_reference column mirroring codecraft_reference's role.
-- Safe to re-run: DROP CONSTRAINT IF EXISTS + recreate is idempotent; ADD COLUMN IF NOT
--            EXISTS is idempotent.
-- ============================================================================

ALTER TABLE public.orders
DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

ALTER TABLE public.orders
ADD CONSTRAINT orders_fulfillment_method_check
CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata', 'agentportal', 'datagod', 'bundleportal'));

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS bundleportal_reference text;
