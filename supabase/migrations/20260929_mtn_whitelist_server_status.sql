-- =============================================================================
-- MTN whitelist per-server allow-cache
--
-- The checker UI and the public /api/v2/data/verify-number/server-{1,2}
-- endpoints check ONE supplier at a time (Server 1 = AgentPortal, Server 2 =
-- Bundle Portal). Same permanent allow-cache rule as mtn_whitelist_status: once
-- a number is confirmed allowed on a server it is never re-checked there;
-- blocked results are never cached (always re-checked live). Keyed per server
-- because "allowed on Server 1" says nothing about Server 2.
--
-- Written and read only via the service-role client (lib/mtn-whitelist-server-check.ts);
-- there is no user-facing read or write path.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.mtn_whitelist_server_status (
  phone_number text        NOT NULL,           -- canonical 0XXXXXXXXX
  server       smallint    NOT NULL CHECK (server IN (1, 2)),
  status       text        NOT NULL CHECK (status IN ('allowed')),
  checked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number, server)
);

ALTER TABLE public.mtn_whitelist_server_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mtn_whitelist_server_status_admin_only ON public.mtn_whitelist_server_status;
CREATE POLICY mtn_whitelist_server_status_admin_only ON public.mtn_whitelist_server_status
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role IN ('admin','sub-admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role IN ('admin','sub-admin')));

REVOKE ALL ON public.mtn_whitelist_server_status FROM anon;
