-- ============================================================================
-- MIGRATION: Widen orders.fulfillment_method CHECK constraint for 'datagod'
-- Date:      2026-07-29
-- Problem:   The CHECK constraint (see 20260725_widen_fulfillment_method_check.sql)
--            only allows ('auto', 'manual', 'codecraft', 'datakazina', 'xpress',
--            'ghdata', 'agentportal'). app/api/admin/datagod/fulfill/route.ts now
--            stamps fulfillment_method = 'datagod' on successful manual DataGod
--            dispatch (see lib/order-supplier.ts's resolveSupplier, which needs this
--            column to always reflect the latest dispatch attempt for the Admin
--            Fulfillment Center's supplier tag) — without this migration, that
--            UPDATE fails this CHECK and the order update silently errors.
-- Fix:       Drop and recreate the CHECK constraint to include 'datagod'.
-- Safe to re-run: DROP CONSTRAINT IF EXISTS + recreate is idempotent.
-- ============================================================================

-- Step 1: Drop the existing constraint
ALTER TABLE public.orders
DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

-- Step 2: Recreate with 'datagod' included
ALTER TABLE public.orders
ADD CONSTRAINT orders_fulfillment_method_check
CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata', 'agentportal', 'datagod'));
