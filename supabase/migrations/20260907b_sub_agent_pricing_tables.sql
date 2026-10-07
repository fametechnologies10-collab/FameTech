-- supabase/migrations/20260907b_sub_agent_pricing_tables.sql
-- =============================================================================
-- Per-recruiter default markup + per-sub override (spec §4.1).
--
-- product_type IN ('data', 'afa', 'results_checker') ONLY. Airtime and mashup
-- are excluded by the CHECK constraint itself (spec C9) — a row for either can
-- never be inserted, not merely discouraged.
--
-- RLS: recruiter reads their own defaults; recruiter AND the affected sub may
-- read an override row (the sub must be able to see what they pay). No client
-- writes — a service-role route re-validates the recruiter relationship first.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sub_agent_default_pricing (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  recruiter_id UUID NOT NULL REFERENCES public.users(id),
  product_type TEXT NOT NULL CHECK (product_type IN ('data', 'afa', 'results_checker')),
  product_ref  TEXT NOT NULL,
  markup       DECIMAL(12,2) NOT NULL CHECK (markup >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recruiter_id, product_type, product_ref)
);

CREATE TABLE IF NOT EXISTS public.sub_agent_pricing (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  recruiter_id UUID NOT NULL REFERENCES public.users(id),
  sub_user_id  UUID NOT NULL REFERENCES public.users(id),
  product_type TEXT NOT NULL CHECK (product_type IN ('data', 'afa', 'results_checker')),
  product_ref  TEXT NOT NULL,
  markup       DECIMAL(12,2) NOT NULL CHECK (markup >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Keyed on the SUB, not the (recruiter, sub) pair: a sub has exactly one
  -- recruiter, so (sub, product) is the true natural key.
  UNIQUE (sub_user_id, product_type, product_ref)
);

CREATE INDEX IF NOT EXISTS idx_sub_agent_default_pricing_recruiter
  ON public.sub_agent_default_pricing(recruiter_id);
CREATE INDEX IF NOT EXISTS idx_sub_agent_pricing_sub
  ON public.sub_agent_pricing(sub_user_id);

ALTER TABLE public.sub_agent_default_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sub_agent_pricing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sub_agent_default_pricing_recruiter_read" ON public.sub_agent_default_pricing;
CREATE POLICY "sub_agent_default_pricing_recruiter_read" ON public.sub_agent_default_pricing
  FOR SELECT USING (recruiter_id = auth.uid());

DROP POLICY IF EXISTS "sub_agent_pricing_party_read" ON public.sub_agent_pricing;
CREATE POLICY "sub_agent_pricing_party_read" ON public.sub_agent_pricing
  FOR SELECT USING (recruiter_id = auth.uid() OR sub_user_id = auth.uid());
-- (No INSERT/UPDATE/DELETE policy on either table: writes go through a
--  service-role route that re-checks the recruiter relationship first.)
