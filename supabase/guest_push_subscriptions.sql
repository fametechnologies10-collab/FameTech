-- ─────────────────────────────────────────────────────────────────────────────
-- guest_push_subscriptions
-- Web Push subscriptions for unauthenticated storefront visitors.
-- Keyed by (shop_id, endpoint) so one browser can subscribe to multiple shops.
-- guest_phone is optional: when provided, order-completion pushes are matched
-- against it so the guest gets notified when their order is delivered.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.guest_push_subscriptions (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id     uuid        NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    endpoint    text        NOT NULL,
    p256dh      text        NOT NULL,
    auth        text        NOT NULL,
    guest_phone text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE(shop_id, endpoint)
);

CREATE INDEX IF NOT EXISTS guest_push_subscriptions_shop_id_idx
    ON public.guest_push_subscriptions(shop_id);
CREATE INDEX IF NOT EXISTS guest_push_subscriptions_phone_idx
    ON public.guest_push_subscriptions(guest_phone)
    WHERE guest_phone IS NOT NULL;

-- Auto-bump updated_at on modification.
-- SECURITY INVOKER: this is a simple timestamp trigger, no elevated privilege needed.
-- Revoke direct RPC access so anon/authenticated cannot call it as a function.
CREATE OR REPLACE FUNCTION public.update_guest_push_subscriptions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

REVOKE ALL ON FUNCTION public.update_guest_push_subscriptions_updated_at() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_guest_push_updated_at ON public.guest_push_subscriptions;
CREATE TRIGGER trg_guest_push_updated_at
    BEFORE UPDATE ON public.guest_push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.update_guest_push_subscriptions_updated_at();

-- RLS: all writes go through the server-side API route which uses service_role
-- and bypasses RLS entirely. anon never needs direct INSERT/UPDATE access.
ALTER TABLE public.guest_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Drop overly-permissive anon policies (server uses service_role, not anon)
DROP POLICY IF EXISTS "Guests can subscribe" ON public.guest_push_subscriptions;
DROP POLICY IF EXISTS "Guests can update their subscription" ON public.guest_push_subscriptions;

DROP POLICY IF EXISTS "Service role full access" ON public.guest_push_subscriptions;
CREATE POLICY "Service role full access"
    ON public.guest_push_subscriptions FOR ALL TO service_role
    USING (true);
