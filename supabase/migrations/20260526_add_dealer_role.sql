-- ============================================================================
-- MIGRATION: Add Dealer Role
-- Date:      2026-05-26
-- Description:
--   Introduces the 'dealer' role as a new premium tier above 'agent'.
--   - Adds dealer_expires_at column to users table (6-month time-limited role)
--   - Extends the users.role CHECK constraint to include 'dealer'
--   - Seeds dealer_upgrade_price_6m into admin_settings
--   - On expiry, dealers auto-downgrade to Lifetime Agent (not customer)
--   - Only Lifetime Agents (agent + no expiry) can upgrade to dealer
-- Safe to run on a live Supabase database — uses IF NOT EXISTS / DO blocks.
-- ============================================================================

-- ============================================================================
-- STEP 1: Add dealer_expires_at column to users
-- ============================================================================
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS dealer_expires_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.users.dealer_expires_at IS
    'Expiry timestamp for the dealer role. NULL when not a dealer. '
    'When this timestamp passes, the user is auto-downgraded to Lifetime Agent.';

-- ============================================================================
-- STEP 2: Extend the users.role CHECK constraint to include ''dealer''
-- The existing constraint only allows customer | agent | admin | sub-admin.
-- We drop it and recreate it with dealer included.
-- ============================================================================
ALTER TABLE public.users
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
ADD CONSTRAINT users_role_check
CHECK (role IN ('customer', 'agent', 'dealer', 'admin', 'sub-admin'));

-- ============================================================================
-- STEP 3: Index on dealer_expires_at
-- Allows efficient cron-style queries for expired dealers.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_users_dealer_expires_at
    ON public.users(dealer_expires_at)
    WHERE dealer_expires_at IS NOT NULL;

-- ============================================================================
-- STEP 4: Seed admin_settings — dealer upgrade price
-- Default: GHS 299.99 for 6-month dealer membership.
-- Admin can change this value from the admin settings panel at any time.
-- ============================================================================
INSERT INTO public.admin_settings (key, value)
VALUES ('dealer_upgrade_price_6m', '299.99')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- STEP 5: Seed admin_settings — api_allowed_roles update
-- Ensure 'dealer' is included in the API allowed roles default so that
-- existing deployments without this key also grant dealers API access.
-- Only updates the row if it currently does NOT already include 'dealer'.
-- ============================================================================
DO $$
DECLARE
    current_val JSONB;
    parsed      JSONB;
BEGIN
    SELECT value INTO current_val
    FROM public.admin_settings
    WHERE key = 'api_allowed_roles';

    -- If the key doesn't exist yet, insert it with both agent and dealer
    IF current_val IS NULL THEN
        INSERT INTO public.admin_settings (key, value)
        VALUES ('api_allowed_roles', '["agent","dealer"]'::JSONB)
        ON CONFLICT (key) DO NOTHING;

    -- If it exists but doesn't contain 'dealer', append it
    ELSIF NOT (current_val @> '"dealer"'::JSONB) THEN
        parsed := current_val || '["dealer"]'::JSONB;
        UPDATE public.admin_settings
        SET value = parsed
        WHERE key = 'api_allowed_roles';
    END IF;
END $$;
