-- ═══════════════════════════════════════════════════════════
-- Plan 2 | Stage 1: Configurable Data Profit Limits
-- ═══════════════════════════════════════════════════════════

-- 1. Configurable data profit caps (0 = no limit)
INSERT INTO public.shop_global_settings (key, value) VALUES
  ('data_profit_max_customer', '5'),
  ('data_profit_max_agent', '10')
ON CONFLICT (key) DO NOTHING;

-- 2. Change default fee columns from 0 → 1 so NEW shops
--    auto-earn GHS 1 on airtime/RC without config.
--    NOTE: Existing shops keep their current values.
ALTER TABLE public.shop_profiles
  ALTER COLUMN airtime_fee_mtn SET DEFAULT 1,
  ALTER COLUMN airtime_fee_telecel SET DEFAULT 1,
  ALTER COLUMN airtime_fee_at SET DEFAULT 1;

ALTER TABLE public.shop_profiles
  ALTER COLUMN results_checker_markup_customer SET DEFAULT 1,
  ALTER COLUMN results_checker_markup_agent SET DEFAULT 1;

-- NOTE: Existing shops keep their current 0 values.
-- Only NEW shops created after this migration get the default of 1.
-- Admin can run a bulk update if they want existing shops updated too.
