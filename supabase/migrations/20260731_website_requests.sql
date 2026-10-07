-- supabase/migrations/20260731_website_requests.sql
-- =============================================================================
-- Website & App Request feature — software-development lead intake.
--   * Single `request_type` discriminator: 'full_request' (category/budget/
--     features/timeline required) vs 'call_request' (just phone/whatsapp/note).
--   * RLS: owner is READ-ONLY from the client (same pattern as support_threads)
--     — every write (create + admin status update) goes through a service-role
--     API route after validation. No INSERT/UPDATE policy for `authenticated`.
--   * One-open-item-per-user cap (status IN ('new','contacted')), counting
--     BOTH request_types together, enforced race-safely via a BEFORE INSERT
--     trigger using a per-user advisory xact lock (mirrors
--     enforce_support_thread_cap in 20260708_support_threads.sql).
-- service_role bypasses RLS, so no service policies are declared (advisor-clean).
-- =============================================================================

-- ── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.website_requests (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_type      text NOT NULL DEFAULT 'full_request'
                      CHECK (request_type IN ('full_request', 'call_request')),
  category          text
                      CHECK (category IN (
                        'business_portfolio', 'ecommerce', 'booking_appointment',
                        'school_church_org', 'blog_news', 'mobile_app',
                        'custom_web_app', 'other'
                      )),
  budget_ghs        numeric CHECK (budget_ghs IS NULL OR budget_ghs BETWEEN 1000 AND 10000000),
  features          jsonb,
  description       text NOT NULL,
  -- Free text, not a strict URL: clients describe references however they like
  -- ("jumia.com.gh", "something like KiNG FLEXY GH", "hubtel + a booking page").
  reference_sites   text,
  timeline          text CHECK (timeline IN ('asap', '1_month', '2_3_months', 'flexible')),
  contact_phone     text NOT NULL,
  contact_whatsapp  text,
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  closed_outcome    text CHECK (closed_outcome IN ('won', 'lost', 'spam')),
  admin_notes       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  contacted_at      timestamptz,
  closed_at         timestamptz,
  -- Defense in depth: a full_request must carry its required fields; a
  -- call_request must NOT (keeps the two shapes from drifting into each other).
  CONSTRAINT website_requests_shape_check CHECK (
    (request_type = 'full_request' AND category IS NOT NULL AND budget_ghs IS NOT NULL AND timeline IS NOT NULL)
    OR
    (request_type = 'call_request' AND category IS NULL AND budget_ghs IS NULL AND timeline IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_website_requests_user_id
  ON public.website_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_requests_status
  ON public.website_requests(status, created_at DESC);

-- ── 2. One-open-item cap (race-safe, both request_types combined) ───────────
CREATE OR REPLACE FUNCTION public.enforce_website_request_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('website_request_cap:' || NEW.user_id::text));
  SELECT count(*) INTO open_count
  FROM public.website_requests
  WHERE user_id = NEW.user_id AND status IN ('new', 'contacted');
  IF open_count >= 1 THEN
    RAISE EXCEPTION 'OPEN_WEBSITE_REQUEST_LIMIT'
      USING HINT = 'A user may have at most 1 open website/app request or call request at a time.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_website_request_cap ON public.website_requests;
CREATE TRIGGER trg_website_request_cap
  BEFORE INSERT ON public.website_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_website_request_cap();

-- ── 3. updated_at maintenance ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_website_requests_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_website_requests_updated_at ON public.website_requests;
CREATE TRIGGER trg_website_requests_updated_at
  BEFORE UPDATE ON public.website_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_website_requests_updated_at();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.website_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "website_requests_owner_select" ON public.website_requests;
CREATE POLICY "website_requests_owner_select"
  ON public.website_requests
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ── 5. Grants (Supabase default-grants new tables to anon/authenticated) ─────
-- Column-level grant deliberately excludes `admin_notes` and `closed_outcome` —
-- those are admin-internal and must stay service-role-only. Admin routes use
-- the service-role client, which bypasses grants entirely, so this has no
-- effect on admin functionality; it only limits what the owner's own
-- browser-side (RLS-aware) client can read via the owner-SELECT policy above.
REVOKE ALL ON public.website_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, user_id, request_type, category, budget_ghs, features, description,
  reference_sites, timeline, contact_phone, contact_whatsapp, status,
  created_at, updated_at, contacted_at, closed_at
) ON public.website_requests TO authenticated;
