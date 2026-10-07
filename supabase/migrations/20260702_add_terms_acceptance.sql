-- 20260702_add_terms_acceptance.sql
-- Versioned Terms & Conditions acceptance + immutable audit trail.

-- 1. Cheap per-load check on the user row.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS terms_accepted_version text,
  ADD COLUMN IF NOT EXISTS terms_accepted_at      timestamptz;

-- 2. Admin-editable agreement content (one row per published version).
CREATE TABLE IF NOT EXISTS public.terms_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version               text UNIQUE NOT NULL,
  effective_date        date NOT NULL,
  sections              jsonb NOT NULL DEFAULT '[]'::jsonb,
  changelog             jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_reacceptance boolean NOT NULL DEFAULT true,
  is_current            boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  published_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Only one current version at a time.
CREATE UNIQUE INDEX IF NOT EXISTS terms_versions_one_current
  ON public.terms_versions (is_current) WHERE is_current = true;

-- 3. Immutable acceptance log (legal proof).
CREATE TABLE IF NOT EXISTS public.terms_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address  text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS terms_acceptances_user_idx ON public.terms_acceptances (user_id);

-- 4. Lock down grants (Supabase grants new tables to anon/authenticated by default).
ALTER TABLE public.terms_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.terms_versions    FROM anon, authenticated;
REVOKE ALL ON public.terms_acceptances FROM anon, authenticated;
GRANT SELECT ON public.terms_versions TO anon, authenticated;
-- Deliberately NO UPDATE/DELETE grant: append-only immutability is enforced at the
-- GRANT layer, not just RLS. Do not add GRANT UPDATE/DELETE without a WITH CHECK policy.
GRANT SELECT, INSERT ON public.terms_acceptances TO authenticated;

-- Anyone may read only the current published version.
DROP POLICY IF EXISTS "read current terms" ON public.terms_versions;
CREATE POLICY "read current terms" ON public.terms_versions
  FOR SELECT USING (is_current = true);

-- A user may insert and read only their own acceptance rows.
-- No UPDATE/DELETE policy = append-only (immutable audit trail).
DROP POLICY IF EXISTS "insert own acceptance" ON public.terms_acceptances;
CREATE POLICY "insert own acceptance" ON public.terms_acceptances
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "read own acceptance" ON public.terms_acceptances;
CREATE POLICY "read own acceptance" ON public.terms_acceptances
  FOR SELECT USING (auth.uid() = user_id);

-- 5. Seed the version-pointer keys (admin_settings.value is JSONB).
--    Content is seeded separately by scripts/seed-terms.ts.
INSERT INTO public.admin_settings (key, value) VALUES
  ('terms_current_version',        '"2026-07-02"'::jsonb),
  ('terms_min_acceptable_version', '"2026-07-02"'::jsonb),
  ('terms_effective_date',         '"July 2, 2026"'::jsonb)
ON CONFLICT (key) DO NOTHING;
