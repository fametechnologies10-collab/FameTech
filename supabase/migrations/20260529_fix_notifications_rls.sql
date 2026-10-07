-- Fix: Drop the overly-permissive INSERT policy on notifications.
--
-- The previous migration created:
--   CREATE POLICY "Service role can insert notifications"
--     ON public.notifications FOR INSERT WITH CHECK (true);
--
-- WITH CHECK (true) grants INSERT to every role, not just service_role.
-- The service_role bypasses RLS entirely and therefore never needed this
-- policy. Dropping it means only the service_role (server-side code) can
-- insert notifications — authenticated users can no longer inject their own.

DROP POLICY IF EXISTS "Service role can insert notifications" ON public.notifications;
