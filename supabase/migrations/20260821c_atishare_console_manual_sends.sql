-- ============================================================================
-- MIGRATION: atishare_console_manual_sends
-- Date:      2026-08-21
--
-- Audit log for free-form AT-iShare Console sends. These spend real console balance
-- with NO customer order behind them, so without this table an admin-only value
-- transfer would leave no attributable record (non-repudiation).
--
-- RLS follows the project's lead-intake pattern: authenticated users get no INSERT or
-- UPDATE at all; every write goes through a service-role client after admin validation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.atishare_console_manual_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.users(id),
  phone text NOT NULL,
  bundle_mb integer NOT NULL CHECK (bundle_mb > 0),
  client_reference text NOT NULL UNIQUE,
  transaction_id text,
  status text NOT NULL DEFAULT 'queued',
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atishare_manual_sends_admin_created
  ON public.atishare_console_manual_sends (admin_id, created_at DESC);

ALTER TABLE public.atishare_console_manual_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read manual sends"
  ON public.atishare_console_manual_sends FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'));

NOTIFY pgrst, 'reload schema';
