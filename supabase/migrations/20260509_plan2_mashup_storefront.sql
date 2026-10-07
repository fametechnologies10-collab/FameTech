-- ═══════════════════════════════════════════════════════════
-- Plan 2 | Stage 2: Storefront Mashup Integration
-- ═══════════════════════════════════════════════════════════

-- 1. Shop-level mashup markup column (default 1 = GHS 1 auto-profit)
ALTER TABLE public.shop_profiles
  ADD COLUMN IF NOT EXISTS mashup_fee_percent numeric DEFAULT 1;

-- 2. Global mashup fee caps (0 = no limit)
INSERT INTO public.shop_global_settings (key, value) VALUES
  ('mashup_shop_fee_max_customer', '0'),
  ('mashup_shop_fee_max_agent', '0')
ON CONFLICT (key) DO NOTHING;

-- 3. Dedicated storefront mashup toggle (default false)
INSERT INTO public.admin_settings (key, value) VALUES
  ('storefront_mashup_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
