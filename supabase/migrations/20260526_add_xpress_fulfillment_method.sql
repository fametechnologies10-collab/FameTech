-- ============================================================================
-- MIGRATION: Add 'xpress' to orders.fulfillment_method CHECK constraint
-- Date:      2026-05-26
-- Problem:   The new Xpress supplier writes fulfillment_method = 'xpress' on
--            successful fulfillment, but the CHECK constraint only allows
--            ('auto', 'manual', 'codecraft', 'datakazina'). This causes the
--            entire UPDATE to be rejected by Postgres, leaving the order stuck
--            in 'pending' status — which then triggers duplicate refulfillment.
-- Fix:       Drop and recreate the CHECK constraint to include 'xpress'.
-- ============================================================================

-- Step 1: Drop the existing constraint
ALTER TABLE public.orders
DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

-- Step 2: Recreate with 'xpress' included
ALTER TABLE public.orders
ADD CONSTRAINT orders_fulfillment_method_check
CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'xpress'));
