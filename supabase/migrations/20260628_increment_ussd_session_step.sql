-- supabase/migrations/20260628_increment_ussd_session_step.sql
-- =============================================================================
-- Atomic USSD session step counter.
--
-- logSessionStep() previously did read-then-write (SELECT steps → UPDATE steps+1),
-- which loses an increment when two requests for the same session interleave (retry
-- storms / concurrent Hubtel Initiation+Response). The counter is analytics-only, but
-- an atomic upsert+increment removes the lost-update entirely with no read.
--
-- Relies on the existing UNIQUE(session_id) used by the other ON CONFLICT upserts.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.increment_ussd_session_step(
    p_session_id TEXT,
    p_mobile     TEXT,
    p_operator   TEXT,
    p_platform   TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    INSERT INTO public.ussd_sessions (session_id, mobile, operator, platform, steps, updated_at)
    VALUES (p_session_id, p_mobile, p_operator, p_platform, 1, NOW())
    ON CONFLICT (session_id) DO UPDATE
        SET steps = public.ussd_sessions.steps + 1,
            updated_at = NOW();
$$;

REVOKE EXECUTE ON FUNCTION public.increment_ussd_session_step(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.increment_ussd_session_step(TEXT, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
