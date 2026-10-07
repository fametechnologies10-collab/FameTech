-- ============================================================================
-- MIGRATION: Widen orders.fulfillment_method CHECK constraint for 'hendylinks'
--            + add orders.hendylinks_order_id column + index it
-- Date:      2026-08-19
-- Problem:   The CHECK constraint (see 20260816_widen_fulfillment_method_check_bundleportal.sql)
--            only allows ('auto','manual','codecraft','datakazina','xpress','ghdata',
--            'agentportal','datagod','bundleportal'). The new HendyLinks dispatcher wiring
--            stamps fulfillment_method = 'hendylinks' on dispatch — without this migration,
--            the atomic claim UPDATE fails the CHECK and every HendyLinks order is silently
--            left 'pending' (fail-safe, but blocks the integration entirely).
-- Fix:       Drop and recreate the CHECK constraint to include 'hendylinks'; add a
--            hendylinks_order_id column; add a partial index on it. Unlike
--            codecraft_reference/bundleportal_reference (bookkeeping only), this column is a
--            REQUIRED join key: HendyLinks' webhook payload carries only their own numeric
--            order.id, never anything of ours, so app/api/webhooks/hendylinks/route.ts (and
--            both reconciliation routes) resolve the order via
--            .eq('hendylinks_order_id', payload.order.id) — on a high-volume table, that
--            needs an index or every webhook delivery sequential-scans orders.
-- Safe to re-run: DROP CONSTRAINT IF EXISTS + recreate is idempotent; ADD COLUMN IF NOT
--            EXISTS and CREATE INDEX IF NOT EXISTS are both idempotent.
-- ============================================================================

ALTER TABLE public.orders
DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;

ALTER TABLE public.orders
ADD CONSTRAINT orders_fulfillment_method_check
CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'xpress', 'ghdata', 'agentportal', 'datagod', 'bundleportal', 'hendylinks'));

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS hendylinks_order_id text;

-- The webhook (app/api/webhooks/hendylinks) and both reconciliation routes look orders up
-- by this column; `orders` is high-volume, so an unindexed .eq() would sequential-scan on
-- every webhook delivery. Partial index: the column is NULL for every non-HendyLinks order,
-- so indexing only non-NULL rows keeps it small.
CREATE INDEX IF NOT EXISTS idx_orders_hendylinks_order_id
ON public.orders (hendylinks_order_id)
WHERE hendylinks_order_id IS NOT NULL;
