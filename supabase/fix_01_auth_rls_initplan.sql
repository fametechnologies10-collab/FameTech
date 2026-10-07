-- ============================================================
-- SCRIPT 1: Fix Auth RLS Initialization Plan
-- Each policy update is wrapped in its own transaction for safety.
-- Replaces auth.uid() with (select auth.uid())
-- ============================================================

-- ── wallets ──────────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet" ON public.wallets
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can update wallets" ON public.wallets;
CREATE POLICY "Admins can update wallets" ON public.wallets
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── wallet_transactions ───────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own transactions" ON public.wallet_transactions;
CREATE POLICY "Users can view own transactions" ON public.wallet_transactions
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can insert wallet transactions" ON public.wallet_transactions;
CREATE POLICY "Admins can insert wallet transactions" ON public.wallet_transactions
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── wallet_payments ───────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own wallet payments" ON public.wallet_payments;
CREATE POLICY "Users can view own wallet payments" ON public.wallet_payments
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can view all wallet payments" ON public.wallet_payments;
CREATE POLICY "Admins can view all wallet payments" ON public.wallet_payments
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── orders ────────────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
CREATE POLICY "Users can view own orders" ON public.orders
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create orders" ON public.orders;
CREATE POLICY "Users can create orders" ON public.orders
    FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
COMMIT;

-- ── notifications ─────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
CREATE POLICY "Users can view own notifications" ON public.notifications
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications" ON public.notifications
    FOR UPDATE USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can delete own notifications" ON public.notifications;
CREATE POLICY "Users can delete own notifications" ON public.notifications
    FOR DELETE USING (user_id = (SELECT auth.uid()));
COMMIT;

-- ── complaints ────────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own complaints" ON public.complaints;
CREATE POLICY "Users can view own complaints" ON public.complaints
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create complaints" ON public.complaints;
CREATE POLICY "Users can create complaints" ON public.complaints
    FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
COMMIT;

-- ── customer_purchases ────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own customer purchases" ON public.customer_purchases;
CREATE POLICY "Users can view own customer purchases" ON public.customer_purchases
    FOR SELECT USING (user_id = (SELECT auth.uid()));
COMMIT;

-- ── afa_orders ────────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own AFA orders" ON public.afa_orders;
CREATE POLICY "Users can view own AFA orders" ON public.afa_orders
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create AFA orders" ON public.afa_orders;
CREATE POLICY "Users can create AFA orders" ON public.afa_orders
    FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admin full access to afa_orders" ON public.afa_orders;
CREATE POLICY "Admin full access to afa_orders" ON public.afa_orders
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── users ─────────────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.users;
CREATE POLICY "Users can insert their own profile" ON public.users
    FOR INSERT WITH CHECK (id = (SELECT auth.uid()));
COMMIT;

-- ── data_packages ─────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admins can insert packages" ON public.data_packages;
CREATE POLICY "Admins can insert packages" ON public.data_packages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Admins can update packages" ON public.data_packages;
CREATE POLICY "Admins can update packages" ON public.data_packages
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Admins can delete packages" ON public.data_packages;
CREATE POLICY "Admins can delete packages" ON public.data_packages
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── download_batches ──────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admins can do everything with batches" ON public.download_batches;
CREATE POLICY "Admins can do everything with batches" ON public.download_batches
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── system_announcements ──────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access" ON public.system_announcements;
CREATE POLICY "Admin full access" ON public.system_announcements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── mtn_fulfillment_tracking ──────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access to mtn fulfillment tracking" ON public.mtn_fulfillment_tracking;
CREATE POLICY "Admin full access to mtn fulfillment tracking" ON public.mtn_fulfillment_tracking
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── fulfillment_logs ──────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access to fulfillment logs" ON public.fulfillment_logs;
CREATE POLICY "Admin full access to fulfillment logs" ON public.fulfillment_logs
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── admin_custom_lists ────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "admin_custom_lists_admin_only" ON public.admin_custom_lists;
CREATE POLICY "admin_custom_lists_admin_only" ON public.admin_custom_lists
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── admin_custom_list_users ───────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "admin_custom_list_users_admin_only" ON public.admin_custom_list_users;
CREATE POLICY "admin_custom_list_users_admin_only" ON public.admin_custom_list_users
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_pricing ──────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_pricing_owner_all" ON public.shop_pricing;
CREATE POLICY "shop_pricing_owner_all" ON public.shop_pricing
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_pricing.shop_id
        )
    );

DROP POLICY IF EXISTS "shop_pricing_owner_read" ON public.shop_pricing;
CREATE POLICY "shop_pricing_owner_read" ON public.shop_pricing
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_pricing.shop_id
        )
    );
COMMIT;

-- ── shop_pricing_pending ──────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_pricing_pending_owner" ON public.shop_pricing_pending;
CREATE POLICY "shop_pricing_pending_owner" ON public.shop_pricing_pending
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_pricing_pending.shop_id
        )
    );
COMMIT;

-- ── shop_pricing_logs ─────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admins can view shop pricing logs" ON public.shop_pricing_logs;
CREATE POLICY "Admins can view shop pricing logs" ON public.shop_pricing_logs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_wallets ──────────────────────────────────────────────
-- NOTE: shop_wallets has owner_id directly, NOT shop_id
BEGIN;
DROP POLICY IF EXISTS "shop_wallets_owner_read" ON public.shop_wallets;
CREATE POLICY "shop_wallets_owner_read" ON public.shop_wallets
    FOR SELECT USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Owners can update their own shop wallet" ON public.shop_wallets;
CREATE POLICY "Owners can update their own shop wallet" ON public.shop_wallets
    FOR UPDATE
    USING (owner_id = (SELECT auth.uid()))
    WITH CHECK (owner_id = (SELECT auth.uid()));
COMMIT;

-- ── shop_wallet_transactions ──────────────────────────────────
-- NOTE: shop_wallet_transactions links via shop_wallet_id → shop_wallets, NOT shop_id
BEGIN;
DROP POLICY IF EXISTS "shop_wallet_transactions_owner_read" ON public.shop_wallet_transactions;
CREATE POLICY "shop_wallet_transactions_owner_read" ON public.shop_wallet_transactions
    FOR SELECT USING (
        shop_wallet_id IN (
            SELECT id FROM public.shop_wallets
            WHERE owner_id = (SELECT auth.uid())
        )
    );

DROP POLICY IF EXISTS "Owners can insert their own shop transactions" ON public.shop_wallet_transactions;
CREATE POLICY "Owners can insert their own shop transactions" ON public.shop_wallet_transactions
    FOR INSERT WITH CHECK (
        shop_wallet_id IN (
            SELECT id FROM public.shop_wallets
            WHERE owner_id = (SELECT auth.uid())
        )
    );

DROP POLICY IF EXISTS "Admins view all shop transactions" ON public.shop_wallet_transactions;
CREATE POLICY "Admins view all shop transactions" ON public.shop_wallet_transactions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_orders ───────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_orders_shop_owner_read" ON public.shop_orders;
CREATE POLICY "shop_orders_shop_owner_read" ON public.shop_orders
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_orders.shop_id
        )
    );

DROP POLICY IF EXISTS "shop_orders_admin_read" ON public.shop_orders;
CREATE POLICY "shop_orders_admin_read" ON public.shop_orders
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── shop_profiles ─────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_profiles_owner_all" ON public.shop_profiles;
CREATE POLICY "shop_profiles_owner_all" ON public.shop_profiles
    FOR ALL USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "shop_profiles_owner_read" ON public.shop_profiles;
CREATE POLICY "shop_profiles_owner_read" ON public.shop_profiles
    FOR SELECT USING (owner_id = (SELECT auth.uid()));
COMMIT;

-- ── shop_announcements ────────────────────────────────────────
-- NOTE: Original policy name is "shop_announcements_owner_all" from shop_schema.sql
BEGIN;
DROP POLICY IF EXISTS "shop_announcements_owner_all" ON public.shop_announcements;
CREATE POLICY "shop_announcements_owner_all" ON public.shop_announcements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = shop_announcements.shop_id
        )
    );
COMMIT;

-- ── shop_payment_details ──────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Owners can view their own payment details" ON public.shop_payment_details;
CREATE POLICY "Owners can view their own payment details" ON public.shop_payment_details
    FOR SELECT USING (shop_owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Owners can insert their own payment details" ON public.shop_payment_details;
CREATE POLICY "Owners can insert their own payment details" ON public.shop_payment_details
    FOR INSERT WITH CHECK (shop_owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Owners can update their own payment details" ON public.shop_payment_details;
CREATE POLICY "Owners can update their own payment details" ON public.shop_payment_details
    FOR UPDATE USING (shop_owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Owners can delete their own payment details" ON public.shop_payment_details;
CREATE POLICY "Owners can delete their own payment details" ON public.shop_payment_details
    FOR DELETE USING (shop_owner_id = (SELECT auth.uid()));
COMMIT;

-- ── shop_global_settings ──────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "shop_global_settings_admin_write" ON public.shop_global_settings;
CREATE POLICY "shop_global_settings_admin_write" ON public.shop_global_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── admin_settings ────────────────────────────────────────────
-- NOTE: Per 20260424_harden_admin_settings_rls.sql, INSERT and UPDATE
-- are deliberately restricted to 'admin' ONLY (not sub-admin).
-- SELECT allows admin + sub-admin. DELETE is intentionally blocked.
BEGIN;
DROP POLICY IF EXISTS "admin_settings_select" ON public.admin_settings;
CREATE POLICY "admin_settings_select" ON public.admin_settings
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "admin_settings_insert" ON public.admin_settings;
CREATE POLICY "admin_settings_insert" ON public.admin_settings
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role = 'admin'
        )
    );

DROP POLICY IF EXISTS "admin_settings_update" ON public.admin_settings;
CREATE POLICY "admin_settings_update" ON public.admin_settings
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role = 'admin'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role = 'admin'
        )
    );
COMMIT;

-- ── admin_profit_logs ─────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admins can view profit logs" ON public.admin_profit_logs;
CREATE POLICY "Admins can view profit logs" ON public.admin_profit_logs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── airtime_orders ────────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Users can view own airtime orders" ON public.airtime_orders;
CREATE POLICY "Users can view own airtime orders" ON public.airtime_orders
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create airtime orders" ON public.airtime_orders;
CREATE POLICY "Users can create airtime orders" ON public.airtime_orders
    FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can view all airtime orders" ON public.airtime_orders;
CREATE POLICY "Admins can view all airtime orders" ON public.airtime_orders
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Admins can update airtime orders" ON public.airtime_orders;
CREATE POLICY "Admins can update airtime orders" ON public.airtime_orders
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── phone_blacklist ───────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "phone_blacklist_admin_only" ON public.phone_blacklist;
CREATE POLICY "phone_blacklist_admin_only" ON public.phone_blacklist
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── pending_settlements ───────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin only access" ON public.pending_settlements;
CREATE POLICY "Admin only access" ON public.pending_settlements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );
COMMIT;

-- ── results_checker_inventory ─────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "rc_inventory_service_only" ON public.results_checker_inventory;
CREATE POLICY "rc_inventory_service_only" ON public.results_checker_inventory
    FOR ALL USING ((SELECT auth.role()) = 'service_role');
COMMIT;

-- ── results_checker_orders ────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "rc_orders_user_select" ON public.results_checker_orders;
CREATE POLICY "rc_orders_user_select" ON public.results_checker_orders
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "rc_orders_service_all" ON public.results_checker_orders;
CREATE POLICY "rc_orders_service_all" ON public.results_checker_orders
    FOR ALL USING ((SELECT auth.role()) = 'service_role');
COMMIT;

-- ── results_checker_complaints ────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "rc_complaints_user_select" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_user_select" ON public.results_checker_complaints
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "rc_complaints_shop_select" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_shop_select" ON public.results_checker_complaints
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles
            WHERE owner_id = (SELECT auth.uid())
            AND id = results_checker_complaints.shop_id
        )
    );

DROP POLICY IF EXISTS "rc_complaints_service_all" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_service_all" ON public.results_checker_complaints
    FOR ALL USING ((SELECT auth.role()) = 'service_role');
COMMIT;

-- ── momo_transactions ─────────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access to momo_transactions" ON public.momo_transactions;
CREATE POLICY "Admin full access to momo_transactions" ON public.momo_transactions
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Users can view their own claimed transactions" ON public.momo_transactions;
CREATE POLICY "Users can view their own claimed transactions" ON public.momo_transactions
    FOR SELECT USING (claimed_by = (SELECT auth.uid()));
COMMIT;

-- ── momo_claim_attempts ───────────────────────────────────────
BEGIN;
DROP POLICY IF EXISTS "Admin full access to momo_claim_attempts" ON public.momo_claim_attempts;
CREATE POLICY "Admin full access to momo_claim_attempts" ON public.momo_claim_attempts
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid())
            AND role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Users can view their own claim attempts" ON public.momo_claim_attempts;
CREATE POLICY "Users can view their own claim attempts" ON public.momo_claim_attempts
    FOR SELECT USING (user_id = (SELECT auth.uid()));
COMMIT;
