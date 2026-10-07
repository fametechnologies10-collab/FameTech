-- supabase/migrations/20260731_mtn_whitelist_gate.sql
-- =============================================================================
-- MTN AgentPortal whitelist purchase gate.
--
-- New, independent toggle (mtn_agentportal_whitelist_gate_enabled, OFF by
-- default via lib/admin-settings.ts CRITICAL_TOGGLE_KEYS — no DB seed needed,
-- an absent admin_settings row reads as false). When an admin turns it on,
-- MTN data-bundle purchases are checked live against AgentPortal's whitelist
-- (lib/agentportal-whitelist.ts) before the buyer is charged.
--
-- This table caches CONFIRMED-ALLOWED numbers permanently (AgentPortal
-- registration is a one-time event on their side) so repeat purchases from an
-- already-registered number never re-hit AgentPortal. Numbers that come back
-- blocked are also recorded (for admin visibility) but the gate module never
-- trusts a cached 'blocked' row — it always re-checks those live.
--
-- Completely independent of number_registrations / number_registration_gate_enabled
-- (supabase/migrations/20260707_number_registration.sql) — that system's queue/
-- batch-release flow is untouched by this feature.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.mtn_whitelist_status (
  phone_number text PRIMARY KEY,           -- canonical 0XXXXXXXXX
  status       text NOT NULL CHECK (status IN ('allowed', 'blocked')),
  checked_at   timestamptz NOT NULL DEFAULT now()
);

-- RLS: admin/sub-admin read-only visibility (mirrors number_registrations).
-- The gate module always uses the service-role client, which bypasses RLS —
-- there is no user-facing read or write path.
ALTER TABLE public.mtn_whitelist_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mtn_whitelist_status_admin_only ON public.mtn_whitelist_status;
CREATE POLICY mtn_whitelist_status_admin_only ON public.mtn_whitelist_status
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin','sub-admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin','sub-admin')));

REVOKE ALL ON public.mtn_whitelist_status FROM anon;
