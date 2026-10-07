-- supabase/migrations/20260927_admin_presence.sql
-- =============================================================================
-- Lightweight admin-presence heartbeat, so the customer-facing support chat
-- can show "Support is active now" (green) vs "away" (amber) — NOT full
-- realtime presence, just a last-seen timestamp bumped by admin API calls.
-- service_role bypasses RLS for all reads/writes (both sides go through
-- API routes), so RLS is enabled with no policies (advisor-clean, deny-all).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.admin_presence (
  admin_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_presence FROM PUBLIC, anon, authenticated;
