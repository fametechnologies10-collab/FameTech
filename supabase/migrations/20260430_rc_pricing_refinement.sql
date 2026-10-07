-- ============================================================================
-- RESULTS CHECKER PRICING & MARKUP REFINEMENTS
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

-- 2. Add constraint to results_checker_types to ensure selling price >= cost price
-- This is a secondary safety net for the database level.
-- We will also enforce this in the API.

-- Fix any existing rows that violate the constraint first
UPDATE public.results_checker_types 
SET 
  customer_price = GREATEST(customer_price, cost_price),
  agent_price = GREATEST(agent_price, cost_price)
WHERE customer_price < cost_price OR agent_price < cost_price;

ALTER TABLE public.results_checker_types 
  ADD CONSTRAINT rc_types_pricing_sanity 
  CHECK (customer_price >= cost_price AND agent_price >= cost_price);
