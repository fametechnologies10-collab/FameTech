-- 20260628_announcement_cta_scheduling.sql
-- Adds optional CTA buttons + draft/scheduled lifecycle to system announcements.
-- is_active remains the canonical "currently shown" flag; status/scheduled_at are
-- additive and only drive the admin lifecycle + the scheduled-publish cron.

ALTER TABLE public.system_announcements
  ADD COLUMN IF NOT EXISTS cta_primary_label   text,
  ADD COLUMN IF NOT EXISTS cta_primary_url     text,
  ADD COLUMN IF NOT EXISTS cta_secondary_label text,
  ADD COLUMN IF NOT EXISTS cta_secondary_url   text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published'
       CHECK (status IN ('draft','scheduled','published')),
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

-- Cron lookup: due scheduled rows only.
CREATE INDEX IF NOT EXISTS idx_sysann_scheduled
  ON public.system_announcements (scheduled_at) WHERE status = 'scheduled';
