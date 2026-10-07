-- ============================================================
-- Migration: Dealer Paystack fee + configurable wallet top-up limits
-- Run in Supabase SQL Editor.
--
-- The application read paths fall back to safe defaults (dealer fee →
-- customer fee → 1.95; min 5 / max 5000), so the app works before this
-- runs. This just makes the keys explicit and editable from the admin
-- System Settings → Fees & Pricing tab.
--
-- admin_settings.value is JSONB; the admin UI upserts plain strings as
-- JSON strings, so we seed quoted-string values to match that shape.
-- ============================================================
INSERT INTO public.admin_settings (key, value) VALUES
  ('dealer_paystack_fee_percent', '""'::jsonb),   -- blank → falls back to customer fee
  ('paystack_min_topup',          '"5"'::jsonb),
  ('paystack_max_topup',          '"5000"'::jsonb)
ON CONFLICT (key) DO NOTHING;
