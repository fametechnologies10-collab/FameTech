-- PERF: idx_ussd_pending_session (plain btree on session_id) duplicated the UNIQUE
-- constraint index ussd_pending_orders_session_id_key on the same column, so every USSD
-- order insert/update maintained two identical indexes (2 MB extra). The unique index
-- stays (it backs the constraint); session lookups use it: verified 2026-09-27,
-- "Index Scan using ussd_pending_orders_session_id_key", 3 ms.
-- Applied live with DROP INDEX CONCURRENTLY (no lock on the hot USSD table); run outside
-- a transaction.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_ussd_pending_session;

-- NOT APPLIED (pending owner decision — the automated drop was blocked by the permission
-- system): idx_rc_types_ussd is an exact duplicate of idx_rc_types_active on
-- results_checker_types (0 scans vs 10,898). To apply manually:
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_rc_types_ussd;

-- Rollback: CREATE INDEX CONCURRENTLY idx_ussd_pending_session ON public.ussd_pending_orders (session_id);
