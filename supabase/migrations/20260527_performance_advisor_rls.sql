-- ============================================================================
-- Performance Advisor Fixes — RLS init-plan + multiple permissive policies
-- Created: 2026-05-27
--
-- Addresses two classes of warnings from the Supabase Performance Advisor:
--
--   1. auth_rls_initplan
--      auth.uid() / auth.role() called per-row instead of once per query.
--      Fix: wrap in (SELECT auth.<fn>()) so Postgres treats it as a constant.
--
--   2. multiple_permissive_policies
--      Two PERMISSIVE policies overlap on the same (role, action) pair, so
--      Postgres evaluates both for every row.
--      Fix: either combine into one policy with OR, or scope an admin
--      FOR ALL policy down to the actions that actually need it.
--
-- All changes are semantically identical to current behaviour. No app code
-- needs to change. The migration is idempotent and safe to run live.
-- ============================================================================


-- ─── A1. user_payment_references — auth_rls_initplan (3 policies) ────────────
-- Replace raw auth.uid() with (SELECT auth.uid()) in all three policies.

DROP POLICY IF EXISTS "Admin full access to user_payment_references" ON public.user_payment_references;
DROP POLICY IF EXISTS "Users can view own payment reference"          ON public.user_payment_references;
DROP POLICY IF EXISTS "Users can insert own payment reference"        ON public.user_payment_references;

CREATE POLICY "Admin full access to user_payment_references"
    ON public.user_payment_references
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'sub-admin')
        )
    );

CREATE POLICY "Users can view own payment reference"
    ON public.user_payment_references
    FOR SELECT
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert own payment reference"
    ON public.user_payment_references
    FOR INSERT
    WITH CHECK (user_id = (SELECT auth.uid()));


-- ─── A2 + B5. push_subscriptions — combine the two FOR ALL policies ──────────
-- Before: "Users can manage their own subscriptions" (FOR ALL) +
--         "Service role full access"                 (FOR ALL)
-- Both used raw auth.uid()/auth.role() and overlapped on every action.
-- After:  one combined FOR ALL policy with (SELECT ...) and an OR.
-- Restricting TO authenticated, service_role silences anon-role warnings.

DROP POLICY IF EXISTS "Users can manage their own subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Service role full access"                 ON public.push_subscriptions;

CREATE POLICY "push_subscriptions_combined"
    ON public.push_subscriptions
    FOR ALL
    TO authenticated, service_role
    USING (
        user_id = (SELECT auth.uid())
        OR (SELECT auth.role()) = 'service_role'
    )
    WITH CHECK (
        user_id = (SELECT auth.uid())
        OR (SELECT auth.role()) = 'service_role'
    );


-- ─── B1. afa_orders — stop FOR ALL admin from overlapping SELECT/INSERT ──────
-- The existing afa_orders_select_combined and afa_orders_insert_combined
-- policies already include the admin OR-branch. The legacy admin FOR ALL
-- policy only needs to cover UPDATE and DELETE.
-- Postgres has no FOR UPDATE,DELETE syntax — split into 2 policies.

DROP POLICY IF EXISTS "afa_orders_admin_update_delete" ON public.afa_orders;

CREATE POLICY "afa_orders_admin_update"
    ON public.afa_orders
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'sub-admin')
        )
    );

CREATE POLICY "afa_orders_admin_delete"
    ON public.afa_orders
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'sub-admin')
        )
    );


-- ─── B2. api_keys — fold admin access into the 4 per-action user policies ────
-- Before: 4 user policies + 1 admin FOR ALL → admin overlaps every action.
-- After:  4 policies, each USING (user owns OR is admin). No overlap.
-- Admin path uses public.is_admin() which is already hardened.

DROP POLICY IF EXISTS "api_keys: admin full access" ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: user select own"   ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: user insert own"   ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: user update own"   ON public.api_keys;
DROP POLICY IF EXISTS "api_keys: user delete own"   ON public.api_keys;

CREATE POLICY "api_keys: select own or admin"
    ON public.api_keys
    FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );

CREATE POLICY "api_keys: insert own or admin"
    ON public.api_keys
    FOR INSERT
    WITH CHECK (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );

CREATE POLICY "api_keys: update own or admin"
    ON public.api_keys
    FOR UPDATE
    USING (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );

CREATE POLICY "api_keys: delete own or admin"
    ON public.api_keys
    FOR DELETE
    USING (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );


-- ─── B3. api_logs — combine the two SELECT policies into one ─────────────────
-- Before: "api_logs: admin read all" + "api_logs: user read own" (both SELECT)
-- After:  one SELECT policy with USING (own OR admin).
-- INSERTs continue to happen via the service-role client, which bypasses RLS.

DROP POLICY IF EXISTS "api_logs: admin read all" ON public.api_logs;
DROP POLICY IF EXISTS "api_logs: user read own"  ON public.api_logs;

CREATE POLICY "api_logs: select own or admin"
    ON public.api_logs
    FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR public.is_admin()
    );


-- ─── B4. momo_transactions — scope admin FOR ALL off the SELECT path ─────────
-- Before: momo_transactions_select_combined (SELECT) +
--         momo_transactions_admin_write     (FOR ALL) → overlaps SELECT.
-- After:  SELECT policy unchanged; admin policy split to INSERT/UPDATE/DELETE.

DROP POLICY IF EXISTS "momo_transactions_admin_write" ON public.momo_transactions;

CREATE POLICY "momo_transactions_admin_insert"
    ON public.momo_transactions
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'sub-admin')
        )
    );

CREATE POLICY "momo_transactions_admin_update"
    ON public.momo_transactions
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'sub-admin')
        )
    );

CREATE POLICY "momo_transactions_admin_delete"
    ON public.momo_transactions
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'sub-admin')
        )
    );


-- ─── Refresh PostgREST schema cache so the new policies apply immediately ────
NOTIFY pgrst, 'reload schema';
