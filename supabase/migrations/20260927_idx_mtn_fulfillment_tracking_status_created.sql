-- PERF: the Xpress sync (app/api/cron/sync-xpress-status + admin sync-xpress) reads the
-- newest 300 'completed' tracking rows (~370x/day). With no (status, created_at) index
-- every run was a full parallel seq scan + sort of the whole table (133k rows, 45 MB):
-- 28.6% of all database time since 2026-01-22, mean 316 ms; 2.59 billion rows read.
-- Measured 2026-09-27: 860 ms / 5,765 buffers -> 28 ms / 42 buffers (index scan).
-- Applied live with CREATE INDEX CONCURRENTLY (no write lock on a hot insert table);
-- CONCURRENTLY cannot run inside a transaction, so re-run this file outside one.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mtn_fulfillment_tracking_status_created
  ON public.mtn_fulfillment_tracking (status, created_at DESC);

-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_mtn_fulfillment_tracking_status_created;
