-- ============================================================
-- RPC: adjust_shop_pricing_for_role_change
--
-- Called whenever a user's role changes (agent<->dealer<->customer). For each
-- package the shop owner has priced, this re-derives the selling price so the
-- owner's absolute profit per package is preserved as their cost basis shifts.
--
-- Cost basis is resolved through the SINGLE shared source effective_owner_cost()
-- (SQL twin of lib/pricing/cost-basis.ts `tierCost`) so this can never drift from
-- the charge-time resolver again — the drift that previously left this function
-- agent-only and silently under-pricing dealer downgrades.
--
-- Parameters
--   p_user_id  UUID  — the user whose role just changed
--   p_old_role TEXT  — role BEFORE the change (e.g. 'dealer')
--   p_new_role TEXT  — role AFTER  the change (e.g. 'agent')
--
-- Also floors the wholesale sub_price at (new_cost + 0.01) so a Lead never sells to
-- their sub-agents below their own (risen) cost after a downgrade. Bumps only
-- underwater rows. Deployed via migration `adjust_shop_pricing_dealer_branch`.
-- ============================================================

CREATE OR REPLACE FUNCTION adjust_shop_pricing_for_role_change(
    p_user_id  UUID,
    p_old_role TEXT,
    p_new_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_shop_id       UUID;
    v_updated_count INTEGER := 0;
    rec             RECORD;
    v_old_cost      DECIMAL(12,2);
    v_new_cost      DECIMAL(12,2);
    v_profit        DECIMAL(12,2);
    v_new_price     DECIMAL(12,2);
    v_new_sub       DECIMAL(12,2);
BEGIN
    SELECT id INTO v_shop_id
    FROM public.shop_profiles
    WHERE owner_id = p_user_id
    LIMIT 1;

    IF v_shop_id IS NULL THEN
        RETURN jsonb_build_object('success', true, 'updated', 0, 'message', 'No shop found for this user — nothing to adjust');
    END IF;

    FOR rec IN
        SELECT
            sp.id           AS pricing_id,
            sp.selling_price,
            sp.sub_price,
            dp.price        AS customer_price,
            dp.agent_price  AS agent_price,
            dp.dealer_price AS dealer_price
        FROM public.shop_pricing sp
        JOIN public.data_packages dp ON dp.id = sp.package_id
        WHERE sp.shop_id = v_shop_id
    LOOP
        v_old_cost := public.effective_owner_cost(rec.customer_price, rec.agent_price, rec.dealer_price, p_old_role);
        v_new_cost := public.effective_owner_cost(rec.customer_price, rec.agent_price, rec.dealer_price, p_new_role);

        IF v_old_cost = v_new_cost THEN
            CONTINUE;
        END IF;

        v_profit    := rec.selling_price - v_old_cost;
        v_new_price := v_new_cost + v_profit;
        IF v_new_price <= v_new_cost THEN
            v_new_price := v_new_cost + 0.01;
        END IF;
        v_new_price := ROUND(v_new_price, 2);

        v_new_sub := rec.sub_price;
        IF v_new_sub IS NOT NULL AND v_new_sub < v_new_cost + 0.01 THEN
            v_new_sub := ROUND(v_new_cost + 0.01, 2);
        END IF;

        UPDATE public.shop_pricing
        SET selling_price = v_new_price,
            sub_price     = v_new_sub
        WHERE id = rec.pricing_id;

        v_updated_count := v_updated_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'updated', v_updated_count,
        'message', format('Adjusted %s pricing rows from %s to %s cost tier', v_updated_count, p_old_role, p_new_role)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION adjust_shop_pricing_for_role_change(UUID, TEXT, TEXT) TO service_role;
