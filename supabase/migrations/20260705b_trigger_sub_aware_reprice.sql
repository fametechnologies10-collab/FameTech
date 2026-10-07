-- supabase/migrations/20260705b_trigger_sub_aware_reprice.sql
-- =============================================================================
-- Global auto-reprice trigger: dealer-aware + sub-aware (spec §7.1/§8.2 + D16/D17).
--
-- What was wrong with the DEPLOYED function (verified via pg_get_functiondef):
--   1. NO dealer branch — dealer-owned shops were repriced on the CUSTOMER cost
--      basis when platform prices moved (same drift family as the fixed
--      adjust_shop_pricing_for_role_change bug; the 20260527 file version with a
--      dealer branch was never applied).
--   2. The trigger didn't fire on dealer_price changes at all.
--   3. Sub-agent shops (new) would have been repriced on role tiers, corrupting
--      their retail rows — a sub's cost basis is the Lead's sub_price, not a tier.
--
-- New behavior:
--   * old/new cost via the shared effective_owner_cost() (single SQL source).
--   * Sub-agent shops' rows are SKIPPED (their basis is wholesale sub_price; the
--     drift cron + checkout floors protect them; subs re-price manually in v1).
--   * Leads' wholesale sub_price is bumped alongside selling_price, preserving the
--     wholesale margin and floored at new_cost + 0.01 (never wholesale at a loss).
--   * Margin preserved with a 0.01 floor; the legacy >10 clamp is dropped (the
--     profit_margin CHECK is now only > 0, and clamping corrupted dealer margins).
--   * Trigger refires on price, agent_price AND dealer_price changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.auto_update_shop_pricing_on_platform_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    -- Zero price guard
    IF NEW.price <= 0
       OR (NEW.agent_price IS NOT NULL AND NEW.agent_price <= 0)
       OR (NEW.dealer_price IS NOT NULL AND NEW.dealer_price <= 0) THEN
        RAISE EXCEPTION 'Invalid platform price detected';
    END IF;

    -- No-op guard: skip if no cost column actually changed
    IF NEW.price IS NOT DISTINCT FROM OLD.price
       AND NEW.agent_price IS NOT DISTINCT FROM OLD.agent_price
       AND NEW.dealer_price IS NOT DISTINCT FROM OLD.dealer_price THEN
        RETURN NEW;
    END IF;

    BEGIN
        PERFORM set_config('app.system_pricing_update', 'true', true);

        WITH updated_pricing AS (
            SELECT
                sp.id,
                sp.shop_id,
                sp.package_id,
                public.effective_owner_cost(OLD.price, OLD.agent_price, OLD.dealer_price, u.role) AS old_cost,
                sp.selling_price AS old_selling,
                public.effective_owner_cost(NEW.price, NEW.agent_price, NEW.dealer_price, u.role) AS new_cost,
                public.effective_owner_cost(NEW.price, NEW.agent_price, NEW.dealer_price, u.role)
                    + GREATEST(sp.profit_margin, 0.01) AS new_selling,
                sp.sub_price AS old_sub_price
            FROM public.shop_pricing sp
            JOIN public.shop_profiles spf ON sp.shop_id = spf.id
            JOIN public.users u           ON u.id = spf.owner_id
            WHERE sp.package_id = NEW.id
              -- Sub-agent shops are excluded: their cost basis is the Lead's
              -- wholesale sub_price, not a platform role tier.
              AND NOT EXISTS (SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id)
        ),
        applied_update AS (
            UPDATE public.shop_pricing sp
            SET
                selling_price        = up.new_selling,
                -- Preserve the Lead's wholesale margin; never below the new cost.
                sub_price            = CASE
                    WHEN up.old_sub_price IS NULL THEN NULL
                    ELSE ROUND(GREATEST(up.new_cost + (up.old_sub_price - up.old_cost), up.new_cost + 0.01), 2)
                END,
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
            old_selling, new_selling, NOW()
        FROM applied_update;

        PERFORM set_config('app.system_pricing_update', 'false', true);
        RETURN NEW;
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM set_config('app.system_pricing_update', 'false', true);
            RAISE;
    END;
END;
$function$;

-- Re-arm the trigger to also fire on dealer_price changes.
DROP TRIGGER IF EXISTS trg_auto_update_shop_pricing ON public.data_packages;
CREATE TRIGGER trg_auto_update_shop_pricing
    AFTER UPDATE OF price, agent_price, dealer_price ON public.data_packages
    FOR EACH ROW
    EXECUTE FUNCTION public.auto_update_shop_pricing_on_platform_cost();

-- =============================================================================
-- Drift detector v2: sub-shop-aware. A sub shop drifts when its retail falls
-- below the upline's wholesale sub_price (their real cost basis).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.find_drifted_shop_pricing()
RETURNS TABLE(
  shop_id       uuid,
  package_id    uuid,
  owner_id      uuid,
  role          text,
  selling_price numeric,
  owner_cost    numeric,
  sub_price     numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  -- Normal (non-sub) shops: selling below role-tier cost, or wholesale below cost
  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, u.role,
    sp.selling_price,
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role) AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.users u           ON u.id  = spf.owner_id
  JOIN public.data_packages dp  ON dp.id = sp.package_id
  WHERE NOT EXISTS (SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id)
    AND (
      sp.selling_price <= public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role)
      OR (sp.sub_price IS NOT NULL
          AND sp.sub_price < public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role))
    )

  UNION ALL

  -- Sub-agent shops: retail below the upline's wholesale sub_price (their cost)
  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, 'sub-agent'::text AS role,
    sp.selling_price,
    up.sub_price AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.sub_agents sa     ON sa.user_id = spf.owner_id
  JOIN public.shop_pricing up   ON up.shop_id = sa.upline_shop_id AND up.package_id = sp.package_id
  WHERE up.sub_price IS NOT NULL
    AND sp.selling_price < up.sub_price;
$$;

REVOKE ALL ON FUNCTION public.find_drifted_shop_pricing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_drifted_shop_pricing() TO service_role;
