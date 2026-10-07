-- 20260702b_publish_terms_version.sql
-- Atomic "publish a terms version" — deactivate the current row and upsert the new
-- one as current in a SINGLE transaction, so concurrent admin publishes can never
-- leave zero or two current rows (H-2 from the security review).
CREATE OR REPLACE FUNCTION public.publish_terms_version(
  p_version        text,
  p_effective_date date,
  p_sections       jsonb,
  p_changelog      jsonb,
  p_requires       boolean,
  p_created_by     uuid
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.terms_versions SET is_current = false WHERE is_current = true;

  INSERT INTO public.terms_versions
    (version, effective_date, sections, changelog, requires_reacceptance, is_current, created_by, published_at)
  VALUES
    (p_version, p_effective_date, p_sections, p_changelog, p_requires, true, p_created_by, now())
  ON CONFLICT (version) DO UPDATE SET
    effective_date        = EXCLUDED.effective_date,
    sections              = EXCLUDED.sections,
    changelog             = EXCLUDED.changelog,
    requires_reacceptance = EXCLUDED.requires_reacceptance,
    is_current            = true,
    created_by            = EXCLUDED.created_by,
    published_at          = now();
END;
$$;

-- Only the service-role admin route may call this. Supabase grants EXECUTE to
-- anon/authenticated by default on new functions — revoke it explicitly.
REVOKE ALL ON FUNCTION public.publish_terms_version(text, date, jsonb, jsonb, boolean, uuid) FROM anon, authenticated;
