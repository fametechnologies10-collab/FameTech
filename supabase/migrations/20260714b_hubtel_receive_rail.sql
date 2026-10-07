-- ============================================================================
-- 20260714b_hubtel_receive_rail.sql
-- Hubtel Direct Receive Money collection rail — tables + toggles.
-- Additive; ships DARK (all enable toggles seeded 'false'). Both tables are
-- service-role-only (RLS enabled, no policies) — writes go through service-role
-- routes/RPCs; nothing user-facing reads them directly.
-- ============================================================================

-- Permanent first-time-number allowlist (anti-fraud: confirm the payer owns the number).
CREATE TABLE IF NOT EXISTS public.verified_phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,               -- 233XXXXXXXXX
  first_verified_at timestamptz NOT NULL DEFAULT now(),
  verified_via text NOT NULL DEFAULT 'sms_otp'
);
ALTER TABLE public.verified_phone_numbers ENABLE ROW LEVEL SECURITY;  -- service-role only; no policies

-- Single source for pending Receive Money charges across services (powers admin panel + expiry + reconcile).
CREATE TABLE IF NOT EXISTS public.hubtel_receive_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code text NOT NULL UNIQUE,      -- = the service order's reference_code (UTIL-... etc.)
  service_type text NOT NULL CHECK (service_type IN ('utility','airtime','rc')),
  order_id uuid,                            -- FK-by-convention to the service order row
  shop_id uuid,
  amount numeric NOT NULL,
  channel text NOT NULL,                    -- mtn-gh | vodafone-gh | tigo-gh
  provider_transaction_id text,             -- Hubtel Data.TransactionId
  charges numeric,
  amount_charged numeric,
  fees_on_customer boolean,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  expires_at timestamptz
);
ALTER TABLE public.hubtel_receive_charges ENABLE ROW LEVEL SECURITY;  -- service-role only; no policies
CREATE INDEX IF NOT EXISTS idx_hrc_status_created ON public.hubtel_receive_charges (status, created_at);

-- Toggles + fee-bearer config, seeded OFF/defaults (utilities used this plan; airtime/rc seeded for follow-on plans).
INSERT INTO public.admin_settings (key, value) VALUES
  ('hubtel_receive_enabled_utility', to_jsonb('false'::text)),
  ('hubtel_receive_enabled_airtime', to_jsonb('false'::text)),
  ('hubtel_receive_enabled_rc',      to_jsonb('false'::text)),
  ('hubtel_receive_fees_on_customer_utility', to_jsonb('true'::text)),
  ('hubtel_receive_fees_on_customer_airtime', to_jsonb('false'::text)),
  ('hubtel_receive_fees_on_customer_rc',      to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;
