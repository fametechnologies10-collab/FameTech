-- ============================================================
-- SCRIPT 2: Merge Multiple Permissive Policies
-- Each table is wrapped in its own transaction for safety
-- If a table fails, only that table is affected
-- ============================================================

-- ── users ─────────────────────────────────────────────────────
-- BEFORE: "Admins view all users" + "Users can view own profile" (2 SELECT policies)
-- AFTER: 1 combined SELECT policy
BEGIN;
DROP POLICY IF EXISTS "Admins view all users" ON public.users;
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "users_select_combined" ON public.users
    FOR SELECT USING (
        id = (SELECT auth.uid())
        OR public.is_admin()
    );
COMMIT;

-- ── wallet_payments ───────────────────────────────────────────
-- BEFORE: "Users can view own" + "Admins can view all" (2 SELECT policies)
-- AFTER: 1 combined SELECT policy
BEGIN;
DROP POLICY IF EXISTS "Users can view own wallet payments" ON public.wallet_payments;
DROP POLICY IF EXISTS "Admins can view all wallet payments" ON public.wallet_payments;
CREATE POLICY "wallet_payments_select_combined" ON public.wallet_payments
    FOR SELECT USING (
        user_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── afa_orders ────────────────────────────────────────────────
-- BEFORE: "Admin full access" + "Users can view own" + "Users can create" 
-- AFTER: Admin gets ALL, users get SELECT + INSERT via combined logic
BEGIN;
DROP POLICY IF EXISTS "Admin full access to afa_orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Users can view own AFA orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Users can create AFA orders" ON public.afa_orders;

CREATE POLICY "afa_orders_select_combined" ON public.afa_orders
    FOR SELECT USING (
        user_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
CREATE POLICY "afa_orders_insert_combined" ON public.afa_orders
    FOR INSERT WITH CHECK (
        user_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
CREATE POLICY "afa_orders_admin_update_delete" ON public.afa_orders
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── airtime_orders ────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admins can view all airtime orders" ON public.airtime_orders;
DROP POLICY IF EXISTS "Users can view own airtime orders" ON public.airtime_orders;
CREATE POLICY "airtime_orders_select_combined" ON public.airtime_orders
    FOR SELECT USING (
        user_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_orders ───────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_orders_admin_read" ON public.shop_orders;
DROP POLICY IF EXISTS "shop_orders_shop_owner_read" ON public.shop_orders;
CREATE POLICY "shop_orders_select_combined" ON public.shop_orders
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_orders.shop_id
        )
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_profiles ─────────────────────────────────────────────
-- BEFORE: 4 SELECT policies (admin + owner_all + owner_read + public_read)
-- AFTER: 1 combined SELECT policy
BEGIN;
DROP POLICY IF EXISTS "Admins view all shops" ON public.shop_profiles;
DROP POLICY IF EXISTS "shop_profiles_owner_all" ON public.shop_profiles;
DROP POLICY IF EXISTS "shop_profiles_owner_read" ON public.shop_profiles;
DROP POLICY IF EXISTS "shop_profiles_public_read" ON public.shop_profiles;

-- Public can read approved shops; owners can read their own; admins read all
CREATE POLICY "shop_profiles_select_combined" ON public.shop_profiles
    FOR SELECT USING (
        (approval_status = 'approved' AND is_active = true)
        OR owner_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

-- Owners can update their own; admins can update all
DROP POLICY IF EXISTS "Admins update all shops" ON public.shop_profiles;
CREATE POLICY "shop_profiles_update_combined" ON public.shop_profiles
    FOR UPDATE USING (
        owner_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_pricing ──────────────────────────────────────────────
-- BEFORE: shop_pricing_admin_write + shop_pricing_owner_all + shop_pricing_owner_read + shop_pricing_public_read (4 policies)
-- NOTE: Must also drop shop_pricing_public_read to avoid orphan overlap
BEGIN;
DROP POLICY IF EXISTS "shop_pricing_admin_write" ON public.shop_pricing;
DROP POLICY IF EXISTS "shop_pricing_owner_all" ON public.shop_pricing;
DROP POLICY IF EXISTS "shop_pricing_owner_read" ON public.shop_pricing;
DROP POLICY IF EXISTS "shop_pricing_public_read" ON public.shop_pricing;

-- Combined SELECT (owner + admin + public approved shops)
CREATE POLICY "shop_pricing_select_combined" ON public.shop_pricing
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_pricing.shop_id
        )
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
        OR EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE id = shop_pricing.shop_id
            AND approval_status = 'approved'
            AND is_active = true
        )
    );
-- Combined INSERT/UPDATE/DELETE (owner + admin)
CREATE POLICY "shop_pricing_write_combined" ON public.shop_pricing
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_pricing.shop_id
        )
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_pricing_pending ──────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_pricing_pending_admin" ON public.shop_pricing_pending;
DROP POLICY IF EXISTS "shop_pricing_pending_owner" ON public.shop_pricing_pending;
CREATE POLICY "shop_pricing_pending_combined" ON public.shop_pricing_pending
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_pricing_pending.shop_id
        )
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_payment_details ──────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admins can view all payment details" ON public.shop_payment_details;
DROP POLICY IF EXISTS "Owners can view their own payment details" ON public.shop_payment_details;
CREATE POLICY "shop_payment_details_select_combined" ON public.shop_payment_details
    FOR SELECT USING (
        shop_owner_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_wallets ──────────────────────────────────────────────
-- NOTE: shop_wallets has owner_id directly, NOT shop_id
BEGIN;
DROP POLICY IF EXISTS "Admins view all shop wallets" ON public.shop_wallets;
DROP POLICY IF EXISTS "shop_wallets_owner_read" ON public.shop_wallets;
CREATE POLICY "shop_wallets_select_combined" ON public.shop_wallets
    FOR SELECT USING (
        owner_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_wallet_transactions ──────────────────────────────────
-- NOTE: shop_wallet_transactions links via shop_wallet_id → shop_wallets, NOT shop_id
BEGIN;
DROP POLICY IF EXISTS "Admins view all shop transaction history" ON public.shop_wallet_transactions;
DROP POLICY IF EXISTS "Admins view all shop transactions" ON public.shop_wallet_transactions;
DROP POLICY IF EXISTS "shop_wallet_transactions_owner_read" ON public.shop_wallet_transactions;
CREATE POLICY "shop_wallet_transactions_select_combined" ON public.shop_wallet_transactions
    FOR SELECT USING (
        shop_wallet_id IN (
            SELECT id FROM public.shop_wallets
            WHERE owner_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_announcements ────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Public can read shop announcements" ON public.shop_announcements;
DROP POLICY IF EXISTS "Shop owners can manage their own announcements" ON public.shop_announcements;
CREATE POLICY "shop_announcements_select_combined" ON public.shop_announcements
    FOR SELECT USING (true);  -- public read for storefront
CREATE POLICY "shop_announcements_write_owner" ON public.shop_announcements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_announcements.shop_id
        )
    );
COMMIT;

-- ── shop_global_settings ──────────────────────────────────────
-- NOTE: Explicit TO roles to match original hardened migration
BEGIN;
DROP POLICY IF EXISTS "shop_global_settings_admin_write" ON public.shop_global_settings;
DROP POLICY IF EXISTS "shop_global_settings_public_read" ON public.shop_global_settings;
DROP POLICY IF EXISTS "Admins manage global settings" ON public.shop_global_settings;
DROP POLICY IF EXISTS "Anyone can view global settings" ON public.shop_global_settings;
DROP POLICY IF EXISTS "shop_global_settings_read" ON public.shop_global_settings;
CREATE POLICY "shop_global_settings_read" ON public.shop_global_settings
    FOR SELECT
    TO anon, authenticated
    USING (true);
CREATE POLICY "shop_global_settings_write_admin" ON public.shop_global_settings
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── system_announcements ──────────────────────────────────────
-- NOTE: Real policy name is "Public read access" (schema.sql line 335)
-- NOTE: Table uses is_active (boolean), NOT status (text)
BEGIN;
DROP POLICY IF EXISTS "Admin full access" ON public.system_announcements;
DROP POLICY IF EXISTS "Public read access" ON public.system_announcements;
CREATE POLICY "system_announcements_select_combined" ON public.system_announcements
    FOR SELECT USING (
        is_active = true
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
CREATE POLICY "system_announcements_admin_write" ON public.system_announcements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── momo_transactions ─────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access to momo_transactions" ON public.momo_transactions;
DROP POLICY IF EXISTS "Users can view their own claimed transactions" ON public.momo_transactions;
CREATE POLICY "momo_transactions_select_combined" ON public.momo_transactions
    FOR SELECT USING (
        claimed_by = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
CREATE POLICY "momo_transactions_admin_write" ON public.momo_transactions
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── momo_claim_attempts ───────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access to momo_claim_attempts" ON public.momo_claim_attempts;
DROP POLICY IF EXISTS "Users can view their own claim attempts" ON public.momo_claim_attempts;
-- VULN-10 fix: Users should not be able to read their own rate limit attempts
-- Only admins need access to this table.
DROP POLICY IF EXISTS "momo_claim_attempts_select_combined" ON public.momo_claim_attempts;
CREATE POLICY "momo_claim_attempts_admin_write" ON public.momo_claim_attempts
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── results_checker_orders ────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "rc_orders_service_all" ON public.results_checker_orders;
DROP POLICY IF EXISTS "rc_orders_user_select" ON public.results_checker_orders;
CREATE POLICY "rc_orders_select_combined" ON public.results_checker_orders
    FOR SELECT USING (
        user_id = (SELECT auth.uid())
        OR (SELECT auth.role()) = 'service_role'
    );
CREATE POLICY "rc_orders_service_write" ON public.results_checker_orders
    FOR ALL USING ((SELECT auth.role()) = 'service_role');
COMMIT;

-- ── results_checker_complaints ────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "rc_complaints_service_all" ON public.results_checker_complaints;
DROP POLICY IF EXISTS "rc_complaints_shop_select" ON public.results_checker_complaints;
DROP POLICY IF EXISTS "rc_complaints_user_select" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_select_combined" ON public.results_checker_complaints
    FOR SELECT USING (
        user_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = results_checker_complaints.shop_id
        )
        OR (SELECT auth.role()) = 'service_role'
    );
CREATE POLICY "rc_complaints_service_write" ON public.results_checker_complaints
    FOR ALL USING ((SELECT auth.role()) = 'service_role');
COMMIT;
