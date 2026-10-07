-- ═══════════════════════════════════════════════════════════
-- Shop storefront AFA: server-side KYC staging
--
-- Mirrors ussd_pending_orders. The applicant's KYC payload (legal name, Ghana
-- Card number, DOB) NEVER goes to the payment provider — Paystack receives only
-- the opaque paystack_reference, exactly as Hubtel receives only an opaque
-- "KFT Order <code>" (lib/ussd/utils.ts:55-74). The real payload is resolved
-- server-side at verify time by paystack_reference -> order_payload.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.shop_afa_pending_orders (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  paystack_reference text NOT NULL UNIQUE,
  shop_id            uuid NOT NULL REFERENCES public.shop_profiles(id),
  guest_phone        text NOT NULL,
  guest_email        text,
  order_payload      jsonb NOT NULL,
  cost_price         numeric NOT NULL,
  selling_price      numeric NOT NULL,
  profit             numeric NOT NULL,
  status             text NOT NULL DEFAULT 'awaiting_payment'
                     CHECK (status IN ('awaiting_payment', 'fulfilled', 'expired')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  fulfilled_at       timestamptz
);

-- Supports the initialize route's "did this same registrant just pay?" lookup.
CREATE INDEX IF NOT EXISTS shop_afa_pending_shop_phone_idx
  ON public.shop_afa_pending_orders (shop_id, guest_phone, status, created_at DESC);

-- Contains KYC PII — service_role only. RLS enabled with NO permissive policy,
-- so anon/authenticated can never read it even if a client key leaks.
ALTER TABLE public.shop_afa_pending_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_afa_pending_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.shop_afa_pending_orders TO service_role;

NOTIFY pgrst, 'reload schema';
