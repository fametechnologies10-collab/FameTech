-- lib/shop-order-processor.ts has written fraud/audit events to public.security_events
-- since it was authored (amount mismatches at :246, underwater orders at :288), but the
-- table was never created — supabase-js returns an error object instead of throwing, so
-- those writes silently no-op'd and the audit trail recorded nothing. Creating it here
-- repairs those two existing call sites and gives the AFA processor somewhere to record
-- a paid-but-unregistered failure.
CREATE TABLE IF NOT EXISTS public.security_events (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type      text NOT NULL,
  reference       text,
  shop_id         uuid REFERENCES public.shop_profiles(id),
  paid_amount     numeric,
  expected_amount numeric,
  guest_phone     text,
  network         text,
  order_type      text,
  detail          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_reference_idx  ON public.security_events (reference);
CREATE INDEX IF NOT EXISTS security_events_created_at_idx ON public.security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_type_idx       ON public.security_events (event_type, created_at DESC);

-- Security/fraud records: service_role only, never client-readable.
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.security_events TO service_role;

NOTIFY pgrst, 'reload schema';
