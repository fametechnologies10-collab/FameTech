-- ============================================================================
-- Fix: Remove hardcoded profit_margin <= 10 DB constraint
--
-- The original migration capped profit_margin at 10 in three places:
--   1. The CHECK constraint on shop_pricing
--   2. The auto-update trigger (silently clamped > 10 → 10 on price changes)
--   3. The protect trigger (blocked UPDATE of profit_margin, unnecessary)
--
-- Role-aware caps are enforced at the API layer (shop_global_settings keys
-- data_profit_max_customer / _agent / _dealer). The DB only needs to ensure
-- profit is strictly positive. Removing the upper bound from the DB allows
-- admins to configure any cap they choose per role.
-- ============================================================================

-- 1. Drop and recreate the CHECK constraint — keep only the > 0 invariant
ALTER TABLE public.shop_pricing DROP CONSTRAINT IF EXISTS check_profit_margin_range;
ALTER TABLE public.shop_pricing ADD CONSTRAINT check_profit_margin_range
    CHECK (profit_margin > 0);

-- 2. Fix the auto-update trigger: remove the WHEN > 10 THEN 10 clamp
--    so that dealer and agent margins above 10 are preserved when platform
--    prices change.
CREATE OR REPLACE FUNCTION auto_update_shop_pricing_on_platform_cost()
RETURNS TRIGGER AS $$
BEGIN
    -- Zero Price Guard
    IF NEW.price <= 0 OR (NEW.agent_price IS NOT NULL AND NEW.agent_price <= 0) THEN
        RAISE EXCEPTION 'Invalid platform price detected';
    END IF;

    -- No-op guard: only proceed when price or agent_price actually changed
    IF NEW.price IS NOT DISTINCT FROM OLD.price
       AND NEW.agent_price IS NOT DISTINCT FROM OLD.agent_price THEN
        RETURN NEW;
    END IF;

    BEGIN
        -- Bypass the protect trigger during system-initiated update
        PERFORM set_config('app.system_pricing_update', 'true', true);

        WITH updated_pricing AS (
            SELECT
                sp.id,
                sp.shop_id,
                sp.package_id,
                CASE
                    WHEN u.role = 'agent'  AND OLD.agent_price IS NOT NULL THEN OLD.agent_price
                    WHEN u.role = 'dealer' AND OLD.dealer_price IS NOT NULL AND OLD.dealer_price > 0 THEN OLD.dealer_price
                    ELSE OLD.price
                END AS old_cost,
                sp.selling_price AS old_selling,
                CASE
                    WHEN u.role = 'agent'  AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                    WHEN u.role = 'dealer' AND NEW.dealer_price IS NOT NULL AND NEW.dealer_price > 0 THEN NEW.dealer_price
                    ELSE NEW.price
                END AS new_cost,
                -- Use stored profit_margin as-is; only floor at 1 to prevent zero/negative
                GREATEST(sp.profit_margin, 1) AS safe_margin
            FROM public.shop_pricing sp
            JOIN public.shop_profiles spf ON sp.shop_id = spf.id
            JOIN public.users u ON u.id = spf.owner_id
            WHERE sp.package_id = NEW.id
        ),
        applied_update AS (
            UPDATE public.shop_pricing sp
            SET
                selling_price      = up.new_cost + up.safe_margin,
                last_auto_updated_at = NOW()
            FROM updated_pricing up
            WHERE sp.id = up.id
            RETURNING up.*
        )
        INSERT INTO public.shop_pricing_logs (
            shop_id, package_id, old_cost_price, new_cost_price,
            old_selling_price, new_selling_price, changed_at
        )
        SELECT
            shop_id, package_id, old_cost, new_cost,
            old_selling, new_cost + safe_margin, NOW()
        FROM applied_update;

        PERFORM set_config('app.system_pricing_update', 'false', true);
        RETURN NEW;
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM set_config('app.system_pricing_update', 'false', true);
            RAISE;
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-attach trigger (REPLACE on the function is enough; the trigger itself
-- already exists and points to the same function name)
DROP TRIGGER IF EXISTS trg_auto_update_shop_pricing ON public.data_packages;
CREATE TRIGGER trg_auto_update_shop_pricing
AFTER UPDATE OF price, agent_price ON public.data_packages
FOR EACH ROW
EXECUTE FUNCTION auto_update_shop_pricing_on_platform_cost();

-- 3. Drop the protect trigger — it prevents legitimate re-pricing via UPDATE
--    and is redundant since the API always does DELETE + INSERT for new saves.
DROP TRIGGER IF EXISTS trg_protect_shop_pricing ON public.shop_pricing;
DROP FUNCTION IF EXISTS protect_shop_pricing_updates();
