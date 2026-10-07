-- ============================================================================
-- ONE-PASTE APPLY: shop multi-sender IDs (Feature Wave 6) + legacy backfill.
-- Run this whole file in the Supabase dashboard SQL editor (idempotent).
-- Mirrors supabase/migrations/20260709_shop_sender_ids.sql, plus a backfill
-- so shops with a legacy single sender on shop_profiles appear in the new
-- multi-sender list (their approved sender becomes the default).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shop_sender_ids (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id       UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    sender_text   TEXT NOT NULL CHECK (
                      length(trim(sender_text)) BETWEEN 3 AND 11
                      AND sender_text ~ '^[A-Za-z0-9 ]+$'
                  ),
    status        TEXT NOT NULL DEFAULT 'under_review'
                  CHECK (status IN ('under_review', 'approved', 'rejected', 'revoked')),
    is_default    BOOLEAN NOT NULL DEFAULT false,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at   TIMESTAMPTZ,
    reason        TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_sender_ids_shop ON public.shop_sender_ids(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_sender_ids_review
    ON public.shop_sender_ids(requested_at) WHERE status = 'under_review';
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sender_ids_one_default
    ON public.shop_sender_ids(shop_id) WHERE is_default = true;

ALTER TABLE public.shop_sender_ids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_sender_ids_owner_select" ON public.shop_sender_ids;
CREATE POLICY "shop_sender_ids_owner_select" ON public.shop_sender_ids
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_sender_ids.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.shop_sender_ids FROM anon, authenticated;

-- Backfill: legacy single-sender shops -> one row each (approved => default).
INSERT INTO public.shop_sender_ids (shop_id, sender_text, status, is_default, requested_at, reviewed_at)
SELECT sp.id, sp.sms_sender_id, sp.sms_sender_status,
       (sp.sms_sender_status = 'approved'),
       COALESCE(sp.sms_sender_requested_at, now()), sp.sms_sender_reviewed_at
FROM public.shop_profiles sp
WHERE sp.sms_sender_id IS NOT NULL
  AND sp.sms_sender_status IS NOT NULL
  AND sp.sms_sender_id ~ '^[A-Za-z0-9 ]+$'
  AND length(trim(sp.sms_sender_id)) BETWEEN 3 AND 11
  AND NOT EXISTS (
      SELECT 1 FROM public.shop_sender_ids s WHERE s.shop_id = sp.id
  );

-- Verify (should return the table with rows >= number of legacy senders):
SELECT count(*) AS sender_rows,
       count(*) FILTER (WHERE is_default) AS defaults,
       count(*) FILTER (WHERE status = 'under_review') AS pending
FROM public.shop_sender_ids;
