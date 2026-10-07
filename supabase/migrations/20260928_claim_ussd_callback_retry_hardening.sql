-- SECURITY (advisor function_search_path_mutable): claim_ussd_callback_retry had no pinned
-- search_path, so its unqualified reference to ussd_callback_retry_queue resolved via the
-- caller's search_path. Pin it to public (the body's unqualified names keep resolving).
--
-- It was also EXECUTE-able by anon/authenticated. Harmless in practice (SECURITY INVOKER,
-- and the table has RLS with no policies, so a client call updates nothing), but its only
-- caller is the service-role USSD status-check cron (app/api/ussd/status-check/route.ts),
-- so make it server-only like the other claim RPCs.
ALTER FUNCTION public.claim_ussd_callback_retry(uuid, integer) SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.claim_ussd_callback_retry(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ussd_callback_retry(uuid, integer) TO service_role;

-- Rollback:
--   ALTER FUNCTION public.claim_ussd_callback_retry(uuid, integer) RESET search_path;
--   GRANT EXECUTE ON FUNCTION public.claim_ussd_callback_retry(uuid, integer) TO anon, authenticated;
