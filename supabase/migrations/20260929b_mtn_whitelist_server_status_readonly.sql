-- Tighten mtn_whitelist_server_status: all writes go through the service role
-- (lib/mtn-whitelist-server-check.ts). Admins may read the cache but must not be able to
-- forge 'allowed' rows through the authenticated role (a forged row would permanently
-- short-circuit the live check for that number).
DROP POLICY IF EXISTS mtn_whitelist_server_status_admin_only ON public.mtn_whitelist_server_status;
DROP POLICY IF EXISTS mtn_whitelist_server_status_admin_read ON public.mtn_whitelist_server_status;
CREATE POLICY mtn_whitelist_server_status_admin_read ON public.mtn_whitelist_server_status
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role IN ('admin','sub-admin')));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.mtn_whitelist_server_status FROM authenticated;
