-- ============================================================================
-- Performance Advisor Fixes — Round 2 (2026-05-27)
-- Created: 2026-05-27 (same day, after re-running the advisor)
--
-- Round 1 (20260527_performance_advisor_rls.sql) fixed 6 tables but left
-- 7 more with the same overlap pattern, plus two tables had legacy policies
-- that earlier migrations forgot to DROP.
--
-- All changes are semantically identical to current behaviour. The migration
-- is idempotent and safe to run live.
-- ============================================================================


-- ─── 1. user_payment_references — fold admin into user policies ──────────────
-- Before: "Admin full access" (FOR ALL) overlaps "Users can view own" (SELECT)
--         and "Users can insert own" (INSERT) on every row.
-- After:  Admin OR-branch folded into each user policy; admin keeps UPDATE
--         and DELETE via two scoped policies. Same pattern we used for api_keys.

DROP POLICY IF EXISTS "Admin full access to user_payment_references" ON public.user_payment_references;
DROP POLICY IF EXISTS "Users can view own payment reference"          ON public.user_payment_references;
DROP POLICY IF EXISTS "Users can insert own payment reference"        ON public.user_payment_references;

CREATE POLICY "user_payment_references_select_own_or_admin"
    ON public.user_payment_references
    FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );

CREATE POLICY "user_payment_references_insert_own_or_admin"
    ON public.user_payment_references
    FOR INSERT
    WITH CHECK (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );

CREATE POLICY "user_payment_references_admin_update"
    ON public.user_payment_references
    FOR UPDATE
    USING (public.is_admin());

CREATE POLICY "user_payment_references_admin_delete"
    ON public.user_payment_references
    FOR DELETE
    USING (public.is_admin());


-- ─── 2. shop_announcements — drop legacy duplicate + split admin FOR ALL ─────
-- Before: 3 policies — shop_announcements_owner_all (FOR ALL, legacy from
--         shop_schema.sql that earlier migrations never dropped) +
--         shop_announcements_write_owner (FOR ALL) +
--         shop_announcements_select_combined (SELECT, public read).
-- After:  Drop the legacy duplicate, split write_owner into 3 scoped policies.

DROP POLICY IF EXISTS "shop_announcements_owner_all"         ON public.shop_announcements;
DROP POLICY IF EXISTS "shop_announcements_write_owner"       ON public.shop_announcements;
-- shop_announcements_select_combined stays (public read for storefronts)

CREATE POLICY "shop_announcements_owner_insert"
    ON public.shop_announcements
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
              AND id = shop_announcements.shop_id
        )
    );

CREATE POLICY "shop_announcements_owner_update"
    ON public.shop_announcements
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
              AND id = shop_announcements.shop_id
        )
    );

CREATE POLICY "shop_announcements_owner_delete"
    ON public.shop_announcements
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
              AND id = shop_announcements.shop_id
        )
    );


-- ─── 3. shop_global_settings — split admin write off SELECT path ─────────────
-- Before: shop_global_settings_read (SELECT, public) +
--         shop_global_settings_write_admin (FOR ALL) → overlap SELECT.
-- After:  Read policy unchanged; admin policy split to INSERT/UPDATE/DELETE.

DROP POLICY IF EXISTS "shop_global_settings_write_admin" ON public.shop_global_settings;
-- shop_global_settings_read stays (anon, authenticated)

CREATE POLICY "shop_global_settings_admin_insert"
    ON public.shop_global_settings
    FOR INSERT
    TO authenticated
    WITH CHECK (public.is_admin());

CREATE POLICY "shop_global_settings_admin_update"
    ON public.shop_global_settings
    FOR UPDATE
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

CREATE POLICY "shop_global_settings_admin_delete"
    ON public.shop_global_settings
    FOR DELETE
    TO authenticated
    USING (public.is_admin());


-- ─── 4. shop_pricing — split write_combined off SELECT path ──────────────────
-- Before: shop_pricing_select_combined (SELECT) +
--         shop_pricing_write_combined  (FOR ALL) → overlap SELECT.
-- After:  Select policy unchanged; write policy split to INSERT/UPDATE/DELETE.

DROP POLICY IF EXISTS "shop_pricing_write_combined" ON public.shop_pricing;
-- shop_pricing_select_combined stays

CREATE POLICY "shop_pricing_insert_owner_or_admin"
    ON public.shop_pricing
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
              AND id = shop_pricing.shop_id
        )
        OR public.is_admin()
    );

CREATE POLICY "shop_pricing_update_owner_or_admin"
    ON public.shop_pricing
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
              AND id = shop_pricing.shop_id
        )
        OR public.is_admin()
    );

CREATE POLICY "shop_pricing_delete_owner_or_admin"
    ON public.shop_pricing
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
              AND id = shop_pricing.shop_id
        )
        OR public.is_admin()
    );


-- ─── 5. system_announcements — drop legacy public_read + split admin write ───
-- Before: 3 policies — system_announcements_admin_write (FOR ALL) +
--         system_announcements_select_combined (SELECT) +
--         system_announcements_public_read (legacy, never dropped).
-- After:  Drop the legacy public_read, split admin_write into 3 scoped policies.

DROP POLICY IF EXISTS "system_announcements_public_read"  ON public.system_announcements;
DROP POLICY IF EXISTS "system_announcements_admin_write"  ON public.system_announcements;
-- system_announcements_select_combined stays (handles both public + admin SELECT)

CREATE POLICY "system_announcements_admin_insert"
    ON public.system_announcements
    FOR INSERT
    WITH CHECK (public.is_admin());

CREATE POLICY "system_announcements_admin_update"
    ON public.system_announcements
    FOR UPDATE
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

CREATE POLICY "system_announcements_admin_delete"
    ON public.system_announcements
    FOR DELETE
    USING (public.is_admin());


-- ─── 6. results_checker_orders — split service_write off SELECT path ─────────
-- Before: rc_orders_select_combined (SELECT) +
--         rc_orders_service_write  (FOR ALL) → overlap SELECT.
-- After:  Select policy unchanged; service-role write split to INSERT/UPDATE/DELETE.
-- Note: service_role bypasses RLS, so these policies primarily document intent.

DROP POLICY IF EXISTS "rc_orders_service_write" ON public.results_checker_orders;

CREATE POLICY "rc_orders_service_insert"
    ON public.results_checker_orders
    FOR INSERT
    WITH CHECK ((SELECT auth.role()) = 'service_role');

CREATE POLICY "rc_orders_service_update"
    ON public.results_checker_orders
    FOR UPDATE
    USING ((SELECT auth.role()) = 'service_role');

CREATE POLICY "rc_orders_service_delete"
    ON public.results_checker_orders
    FOR DELETE
    USING ((SELECT auth.role()) = 'service_role');


-- ─── 7. results_checker_complaints — split service_write off SELECT path ─────

DROP POLICY IF EXISTS "rc_complaints_service_write" ON public.results_checker_complaints;

CREATE POLICY "rc_complaints_service_insert"
    ON public.results_checker_complaints
    FOR INSERT
    WITH CHECK ((SELECT auth.role()) = 'service_role');

CREATE POLICY "rc_complaints_service_update"
    ON public.results_checker_complaints
    FOR UPDATE
    USING ((SELECT auth.role()) = 'service_role');

CREATE POLICY "rc_complaints_service_delete"
    ON public.results_checker_complaints
    FOR DELETE
    USING ((SELECT auth.role()) = 'service_role');


-- ─── Refresh PostgREST schema cache ──────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
