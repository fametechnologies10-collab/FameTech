-- ============================================================================
-- RC BULK PRICING, TOGGLES, & PRICING SANITY FIX
-- ============================================================================

-- 1. Split results_checker_markup into customer and agent markups
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shop_profiles' AND column_name = 'results_checker_markup') THEN
        ALTER TABLE public.shop_profiles RENAME COLUMN results_checker_markup TO results_checker_markup_customer;
    END IF;
END $$;

ALTER TABLE public.shop_profiles 
  ADD COLUMN IF NOT EXISTS results_checker_markup_agent DECIMAL(12,2) DEFAULT 0;

-- 2. Fix NULL values before applying the pricing sanity constraint
UPDATE public.results_checker_types 
SET 
  cost_price = COALESCE(cost_price, 0),
  customer_price = GREATEST(COALESCE(customer_price, 0), COALESCE(cost_price, 0)),
  agent_price = GREATEST(COALESCE(agent_price, 0), COALESCE(cost_price, 0))
WHERE 
  customer_price < cost_price 
  OR agent_price < cost_price 
  OR customer_price IS NULL 
  OR agent_price IS NULL 
  OR cost_price IS NULL;

-- 3. Add the pricing sanity constraint (safely handling NULLs)
ALTER TABLE public.results_checker_types 
  DROP CONSTRAINT IF EXISTS rc_types_pricing_sanity;

ALTER TABLE public.results_checker_types 
  ADD CONSTRAINT rc_types_pricing_sanity 
  CHECK (COALESCE(customer_price, 0) >= COALESCE(cost_price, 0) AND COALESCE(agent_price, 0) >= COALESCE(cost_price, 0));

-- 4. Add bulk_pricing JSONB column to results_checker_types
ALTER TABLE public.results_checker_types
  ADD COLUMN IF NOT EXISTS bulk_pricing JSONB DEFAULT '[]'::jsonb;

-- 5. Add the storefront-specific enable key to admin_settings
INSERT INTO public.admin_settings (key, value)
VALUES ('results_checker_storefront_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
