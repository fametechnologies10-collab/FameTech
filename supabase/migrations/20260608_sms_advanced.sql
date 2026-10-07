-- ============================================================
-- Migration: Advanced SMS System
-- Created: 2026-06-08
-- Tables: sms_groups, sms_contacts, sms_templates
-- Settings: sms_primary_provider, sms_fallback_providers
-- ============================================================

-- ─── SMS Groups ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── SMS Contacts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_contacts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     UUID NOT NULL REFERENCES public.sms_groups(id) ON DELETE CASCADE,
    first_name   TEXT,
    last_name    TEXT,
    phone_number TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_contacts_group_id ON public.sms_contacts(group_id);
CREATE INDEX IF NOT EXISTS idx_sms_contacts_phone ON public.sms_contacts(phone_number);
-- Prevent duplicate phone numbers within the same group (e.g. importing same CSV twice)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_contacts_unique_group_phone ON public.sms_contacts(group_id, phone_number);

-- ─── SMS Templates ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── RLS Policies ─────────────────────────────────────────────────────────────
ALTER TABLE public.sms_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_templates ENABLE ROW LEVEL SECURITY;

-- Admins/sub-admins only (service role bypasses RLS on the server anyway)
-- These are admin-only tables — no public read needed
CREATE POLICY "sms_groups_admin_all"    ON public.sms_groups    FOR ALL USING (false) WITH CHECK (false);
CREATE POLICY "sms_contacts_admin_all"  ON public.sms_contacts  FOR ALL USING (false) WITH CHECK (false);
CREATE POLICY "sms_templates_admin_all" ON public.sms_templates FOR ALL USING (false) WITH CHECK (false);

-- ─── Seed Default SMS Templates ───────────────────────────────────────────────
INSERT INTO public.sms_templates (name, body) VALUES
    (
        'Welcome Promo',
        'Hi [FirstName], welcome to KiNG FLEXY GH! We offer the cheapest data bundles in Ghana. Visit kingflexygh.com to place your first order today!'
    ),
    (
        'Order Confirmation',
        'Hi [FirstName], your order has been received and is being processed. You will receive your bundle within 1 hour. Thank you for choosing KiNG FLEXY GH!'
    ),
    (
        'Top-Up Reminder',
        'Hi [FirstName], your Flexy-Wallet is running low. Top up now at kingflexygh.com and never miss a deal. Fast & reliable bundles every time!'
    ),
    (
        'Agent Renewal Reminder',
        'Hi [FirstName], your Agent membership is expiring soon! Renew now to keep enjoying our exclusive agent prices. Visit: kingflexygh.com/dashboard/upgrade'
    ),
    (
        'Holiday Greeting',
        'Happy Holidays [FirstName]! From all of us at KiNG FLEXY GH, we wish you joy and celebration. Thank you for your continued trust and support!'
    ),
    (
        'Maintenance Notice',
        'Dear [FirstName], our platform will undergo scheduled maintenance shortly. Service will be briefly unavailable. We apologize for any inconvenience. Thank you!'
    ),
    (
        'Promo Announcement',
        'Hi [FirstName]! BIG NEWS - We just dropped new data prices! Log in now at kingflexygh.com and take advantage of our latest offers. Limited time only!'
    ),
    (
        'Referral Incentive',
        'Hi [FirstName], refer a friend to KiNG FLEXY GH and both of you benefit! Share your referral link today. See your dashboard for details. Thank you!'
    )
ON CONFLICT DO NOTHING;

-- ─── Admin Settings Keys for SMS Provider Routing ─────────────────────────────
INSERT INTO public.admin_settings (key, value)
VALUES
    ('sms_primary_provider',    '"hubtel"'),
    ('sms_fallback_providers',  '["moolre","mnotify"]')
ON CONFLICT (key) DO NOTHING;
