-- ============================================================================
-- MIGRATION: Widen orders.fulfillment_method CHECK constraint for 'ghdata' + 'agentportal'
-- Date:      2026-07-25
-- Problem:   The CHECK constraint only allows
--            ('auto', 'manual', 'codecraft', 'datakazina', 'xpress'). GhData was added as
--            a supplier but the only prior migration touching this constraint,
--            20260526_add_xpress_fulfillment_method.sql, never added 'ghdata' — so GhData
--            order updates writing fulfillment_method = 'ghdata' may currently be silently
--            failing this CHECK. AgentPortal is a new 5th supplier being added now and will
--            write fulfillment_method = 'agentportal'.
-- Fix:       Drop and recreate the CHECK constraint to include 'ghdata' and 'agentportal'.
-- Safe to re-run: DROP CONSTRAINT IF EXISTS + recreate is idempotent.
-- ============================================================================

-- Step 1: Drop the existing constraint
ALTER TABLE public.orders
DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

-- Step 2: Recreate with 'ghdata' and 'agentportal' included
ALTER TABLE public.orders
ADD CONSTRAINT orders_fulfillment_method_check
CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata', 'agentportal'));
