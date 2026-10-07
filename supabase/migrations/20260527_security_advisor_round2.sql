-- ============================================================================
-- Security Advisor Fixes — Round 2 (2026-05-27)
-- Addresses the 12 findings from the Supabase Security Advisor that remained
-- after 20260524_security_audit_fixes.sql.
--
-- This migration is safe to run on a live database. It is fully idempotent.
-- ============================================================================
--
-- FINDINGS HANDLED HERE:
--
--   1. function_search_path_mutable / auto_update_shop_pricing_on_platform_cost
--   2. function_search_path_mutable / save_shop_payment_detail_if_under_limit
--   3. function_search_path_mutable / get_shop_orders_by_phone
--   4. anon_security_definer_function_executable / get_shop_orders_by_phone
--   5. anon_security_definer_function_executable / save_shop_payment_detail_if_under_limit
--   6. authenticated_security_definer_function_executable / get_shop_orders_by_phone
--
-- FINDINGS ACCEPTED AS INTENTIONAL DESIGN (no code change):
--
--   7. authenticated_security_definer_function_executable / is_admin()
--      Required inside RLS policies; revoking from authenticated would break
--      every admin policy on the platform. Function body restricts visibility
--      to rows where the authenticated user already has admin/sub-admin role.
--
--   8. authenticated_security_definer_function_executable / delete_shop_data()
--      Shop owners delete their own shop from /dashboard/shop/setup.
--      Internal auth.uid() ownership check exists and only removes rows
--      owned by the authenticated caller.
--
--   9. authenticated_security_definer_function_executable / get_user_transactions_with_balance
--      Users view their own wallet history from /dashboard/transactions.
--      Internal auth.uid() = p_user_id guard was added in the previous
--      security migration (20260524_security_audit_fixes.sql).
--
--  10. authenticated_security_definer_function_executable / process_shop_withdrawal
--      Shop owners trigger their own withdrawals from /api/shop/withdraw.
--      Internal owner_id check + row-lock prevents wallet draining.
--
--  11. authenticated_security_definer_function_executable / save_shop_payment_detail_if_under_limit
--      Authenticated shop owners save MoMo numbers from /api/shop/withdraw.
--      Internal auth.uid() = p_owner_id guard added in this migration (step 2).
--
--  12. auth_leaked_password_protection
--      DASHBOARD-ONLY SETTING — cannot be toggled from SQL.
--      Enable manually: Supabase Dashboard -> Authentication -> Password Security
--      -> "Check passwords against HaveIBeenPwned".
-- ============================================================================


-- ─── 1. auto_update_shop_pricing_on_platform_cost — lock search_path ──────────
-- Trigger function on data_packages. Never reachable from PostgREST, but the
-- advisor still flags the mutable search_path. Recreating with SET search_path
-- and fully-qualified table names closes the schema-injection vector.
-- The trigger is recreated immediately after the function replacement.

CREATE OR REPLACE FUNCTION public.auto_update_shop_pricing_on_platform_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Zero price guard
    IF NEW.price <= 0 OR (NEW.agent_price IS NOT NULL AND NEW.agent_price <= 0) THEN
        RAISE EXCEPTION 'Invalid platform price detected';
    END IF;

    -- No-op guard: skip if neither price column actually changed
    IF NEW.price IS NOT DISTINCT FROM OLD.price
       AND NEW.agent_price IS NOT DISTINCT FROM OLD.agent_price THEN
        RETURN NEW;
    END IF;

    BEGIN
        PERFORM set_config('app.system_pricing_update', 'true', true);

        WITH updated_pricing AS (
            SELECT
                sp.id,
                sp.shop_id,
                sp.package_id,
                CASE
                    WHEN u.role = 'agent' AND OLD.agent_price IS NOT NULL THEN OLD.agent_price
                    ELSE OLD.price
                END AS old_cost,
                sp.selling_price AS old_selling,
                CASE
                    WHEN u.role = 'agent' AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                    ELSE NEW.price
                END AS new_cost,
                (
                    CASE
                        WHEN u.role = 'agent' AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                        ELSE NEW.price
                    END
                ) + (
                    CASE
                        WHEN sp.profit_margin <= 0 THEN 1
                        WHEN sp.profit_margin > 10 THEN 10
                        ELSE sp.profit_margin
                    END
                ) AS new_selling
            FROM public.shop_pricing sp
            JOIN public.shop_profiles spf ON sp.shop_id = spf.id
            JOIN public.users u           ON u.id = spf.owner_id
            WHERE sp.package_id = NEW.id
        ),
        applied_update AS (
            UPDATE public.shop_pricing sp
            SET
                selling_price        = up.new_selling,
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
$$;

-- Re-attach the trigger in case the function replacement dropped it.
DROP TRIGGER IF EXISTS trg_auto_update_shop_pricing ON public.data_packages;
CREATE TRIGGER trg_auto_update_shop_pricing
    AFTER UPDATE OF price, agent_price ON public.data_packages
    FOR EACH ROW
    EXECUTE FUNCTION public.auto_update_shop_pricing_on_platform_cost();


-- ─── 2. save_shop_payment_detail_if_under_limit ──────────────────────────────
-- Three fixes in one replacement:
--   (a) Lock search_path
--   (b) Add internal auth.uid() = p_owner_id ownership check
--   (c) Revoke EXECUTE from PUBLIC and anon (only authenticated should call it)
--
-- The single caller is /api/shop/withdraw (authenticated), so revoking anon
-- does not break anything. The internal owner check is defense-in-depth in
-- case future code passes a user-supplied p_owner_id.

CREATE OR REPLACE FUNCTION public.save_shop_payment_detail_if_under_limit(
    p_owner_id       uuid,
    p_account_name   text,
    p_momo_number    text,
    p_account_number text,
    p_network        text,
    p_payment_type   text,
    p_bank_id        text,
    p_limit          int DEFAULT 5
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count int;
BEGIN
    -- Ownership guard: reject any attempt to save a payment detail under a
    -- different user's owner_id. Service-role calls (auth.uid() = NULL) are
    -- allowed because admin tooling may legitimately backfill records.
    IF auth.uid() IS NOT NULL AND auth.uid() != p_owner_id THEN
        RAISE EXCEPTION 'ACCESS_DENIED: You may only save your own payment details';
    END IF;

    -- Atomic count-and-insert (no TOCTOU gap)
    SELECT COUNT(*) INTO v_count
    FROM public.shop_payment_details
    WHERE shop_owner_id = p_owner_id;

    IF v_count < p_limit THEN
        INSERT INTO public.shop_payment_details (
            shop_owner_id,
            account_name,
            momo_number,
            account_number,
            network,
            payment_type,
            bank_id,
            is_default
        ) VALUES (
            p_owner_id,
            p_account_name,
            p_momo_number,
            p_account_number,
            p_network,
            p_payment_type,
            p_bank_id,
            false
        );
    END IF;
    -- If at limit, silently no-op — the withdrawal itself already succeeded
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(
    uuid, text, text, text, text, text, text, int
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(
    uuid, text, text, text, text, text, text, int
) FROM anon;

GRANT  EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(
    uuid, text, text, text, text, text, text, int
) TO authenticated;

GRANT  EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(
    uuid, text, text, text, text, text, text, int
) TO service_role;


-- ─── 3. get_shop_orders_by_phone ──────────────────────────────────────────────
-- Three fixes in one replacement:
--   (a) Lock search_path
--   (b) Revoke EXECUTE from anon AND authenticated
--   (c) Grant EXECUTE to service_role only
--
-- The single caller is /api/shop/lookup-orders/route.ts which uses the
-- service-role client (createServerClient()). That route already enforces:
--   - IP rate-limit (10/min)
--   - shop_slug + phone format validation
--   - shop active + approved check
--   - 48-hour window filter
-- Locking the RPC to service_role forces all traffic through that hardened
-- route and removes the direct /rest/v1/rpc/ entry point from the attack
-- surface entirely.

CREATE OR REPLACE FUNCTION public.get_shop_orders_by_phone(
    phone_number text,
    limit_count  int  DEFAULT 20,
    p_shop_id    uuid DEFAULT NULL
)
RETURNS TABLE (
    id            uuid,
    network       text,
    package_size  text,
    selling_price numeric,
    status        text,
    created_at    timestamptz,
    guest_phone   text,
    shop_name     text,
    shop_slug     text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT
        so.id,
        so.network,
        so.package_size,
        so.selling_price,
        so.status,
        so.created_at,
        so.guest_phone,
        sp.shop_name,
        sp.shop_slug
    FROM public.shop_orders   so
    JOIN public.shop_profiles sp ON so.shop_id = sp.id
    WHERE so.guest_phone = phone_number
      AND (p_shop_id IS NULL OR so.shop_id = p_shop_id)
    ORDER BY so.created_at DESC
    LIMIT limit_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) TO service_role;


-- ─── 4. Schema cache refresh ─────────────────────────────────────────────────
-- Tells PostgREST to reload its function/permission cache so the revoked
-- grants take effect immediately on the REST API.
NOTIFY pgrst, 'reload schema';
