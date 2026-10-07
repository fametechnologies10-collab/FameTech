-- supabase/migrations/20260627_rc_orders_shop_owner_select.sql
-- =============================================================================
-- Fix: shop owners cannot see their shop's results-checker orders.
--
-- The original RC RLS (20260428_results_checker.sql) only granted SELECT to the
-- BUYER: rc_orders_user_select USING (auth.uid() = user_id OR service_role).
-- Storefront RC sales are made by GUESTS (user_id IS NULL), so the shop owner
-- viewing /dashboard/shop/orders through the RLS-aware browser client matches
-- neither branch and sees ZERO results-checker orders — while data orders
-- (shop_orders) DO show because that table has an owner-by-shop_id read policy.
--
-- This mirrors the shop_orders owner-read policy for results_checker_orders.
-- Additive, SELECT-only, read-only — no writes, no data change. The
-- (SELECT auth.uid()) wrapper is the Supabase initplan optimization used
-- elsewhere in this codebase (fix_01_auth_rls_initplan.sql).
-- =============================================================================

DROP POLICY IF EXISTS "rc_orders_shop_owner_select" ON public.results_checker_orders;

CREATE POLICY "rc_orders_shop_owner_select"
  ON public.results_checker_orders
  FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM public.shop_profiles WHERE owner_id = (SELECT auth.uid())
    )
  );
