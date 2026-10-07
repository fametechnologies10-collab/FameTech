-- ============================================================================
-- MIGRATION: shop_sms_usage_breakdown(uuid) — Postgres-side credit aggregation
-- Date:      2026-08-18
--
-- Problem:   The shop SMS status route needs credits-used totalled per `source`
--            across a shop's ENTIRE history (the recent-logs window would
--            under-report, which is the whole defect being fixed by
--            20260818_shop_sms_logs_source_column.sql). Doing that in JS means
--            transferring every historical shop_sms_logs row on every dashboard
--            load, just to produce three sums — the exact egress anti-pattern
--            the recent perf/reduce-supabase-egress work targeted. A shop with
--            years of history would move an ever-growing row set per page view.
--
-- Fix:       Aggregate in Postgres and return at most 3 rows.
--
-- SECURITY:  Deliberately SECURITY INVOKER, NOT definer. The caller's own RLS on
--            shop_sms_logs therefore applies, so a shop owner can only ever
--            aggregate their own rows — no ownership re-check is needed in the
--            route, and there is no way to probe another shop's usage by
--            passing a foreign shop_id. EXECUTE is granted to `authenticated`
--            and `service_role` only; `anon` is explicitly revoked (RLS would
--            already return zero rows, but the grant is tightened as defence in
--            depth rather than relying on RLS alone).
--
-- Safe to re-run: CREATE OR REPLACE + idempotent REVOKE/GRANT.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.shop_sms_usage_breakdown(p_shop_id uuid)
RETURNS TABLE(source text, credits bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT l.source, COALESCE(SUM(l.credits_used), 0)::bigint
  FROM public.shop_sms_logs l
  WHERE l.shop_id = p_shop_id
  GROUP BY l.source;
$$;

REVOKE ALL ON FUNCTION public.shop_sms_usage_breakdown(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.shop_sms_usage_breakdown(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.shop_sms_usage_breakdown(uuid) TO authenticated, service_role;
