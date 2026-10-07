-- supabase/migrations/20260705_ussd_claim_recovery.sql
-- =============================================================================
-- USSD claim recovery: record WHEN a worker claimed a pending order.
--
-- The claim lock is `hubtel_order_id` stamped under a conditional UPDATE. The
-- crashed-claim reclaim previously measured staleness from created_at, so a
-- claim legitimately taken when the order was already >15 min old (late Hubtel
-- callback, resurrection of an expired-unclaimed row) was instantly treated as
-- crashed and re-fulfilled concurrently — duplicate order / double shop credit.
-- claimed_at lets the reclaim measure the CLAIM's age, not the order's.
-- =============================================================================

ALTER TABLE public.ussd_pending_orders
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ussd_pending_orders.claimed_at IS
    'When hubtel_order_id was stamped (claim lock taken). Reclaim of crashed claims keys off this, not created_at.';
