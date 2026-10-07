-- supabase/migrations/20260605_rc_dealer_price.sql

-- 1. Add dealer_price column to results_checker_types
ALTER TABLE results_checker_types
  ADD COLUMN IF NOT EXISTS dealer_price DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 2. Seed dealer_price = agent_price for all existing rows (reasonable default)
UPDATE results_checker_types
  SET dealer_price = agent_price
  WHERE dealer_price = 0 AND agent_price > 0;

-- 3. Add dealer markup column to shop_profiles for storefront orders
ALTER TABLE shop_profiles
  ADD COLUMN IF NOT EXISTS results_checker_markup_dealer DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 4. Seed the new admin_settings keys (max markup cap for dealer shops)
INSERT INTO admin_settings (key, value)
VALUES ('results_checker_max_markup_dealer', '0')
ON CONFLICT (key) DO NOTHING;

-- 5. Seed AFA dealer price (matches agent price by default)
INSERT INTO admin_settings (key, value)
  SELECT 'afa_price_dealer', value
  FROM admin_settings
  WHERE key = 'afa_price_agent'
ON CONFLICT (key) DO NOTHING;

-- Fallback if afa_price_agent not set
INSERT INTO admin_settings (key, value)
VALUES ('afa_price_dealer', '12.00')
ON CONFLICT (key) DO NOTHING;
