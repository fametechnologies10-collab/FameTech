-- Per-category notification mutes (push-only). Shape:
--   { "muted": { "orders": bool, "payments": bool, "announcements": bool, "system": bool } }
-- Absent / {} means nothing is muted. Muting suppresses device push only; the
-- in-app notification archive always records everything.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
