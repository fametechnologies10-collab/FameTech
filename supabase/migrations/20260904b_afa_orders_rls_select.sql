-- ═══════════════════════════════════════════════════════════
-- afa_orders' existing SELECT policy (afa_orders_select_combined, present
-- before this migration — verified live) only ever covered:
--   (user_id = auth.uid()) OR (admin/sub-admin)
-- There has NEVER been a shop-owner clause. A shop-attributed AFA order is
-- placed by a GUEST (user_id IS NULL, shop_id set), so a shop owner querying
-- afa_orders by shop_id from the browser got zero rows back — always, for
-- every shop, since the day shop AFA orders were introduced.
--
-- credit_shop_afa_profit and the storefront/USSD fulfillment paths all run
-- as SECURITY DEFINER (owner-role execution, bypasses RLS entirely), so
-- profit crediting and order creation always worked. But every BROWSER-
-- FACING read goes through an RLS-bound client:
--   - app/dashboard/shop/orders/page.tsx's AFA tab (direct supabase-js call)
--   - app/api/shop/profit-logs/route.ts (createRouteClient — RLS-aware)
-- Both returned zero rows regardless of real data — read from the outside
-- as "profit credits but the UI never shows the order."
--
-- Mirrors shop_orders_select_combined's exact shape for the added clause.
-- Drop-and-recreate rather than ALTER POLICY, since ALTER POLICY cannot
-- change USING in one statement across all Postgres versions this project
-- targets; DROP+CREATE is what every prior policy migration in this repo
-- already does when widening a qual.
-- ═══════════════════════════════════════════════════════════

DROP POLICY IF EXISTS afa_orders_select_combined ON public.afa_orders;

CREATE POLICY afa_orders_select_combined ON public.afa_orders
  FOR SELECT
  TO public
  USING (
    -- The applicant reading their own dashboard/API/USSD submission.
    (user_id = (SELECT auth.uid()))
    OR
    -- NEW: the shop owner reading an order attributed to their shop.
    (EXISTS (
      SELECT 1 FROM public.shop_profiles
      WHERE shop_profiles.owner_id = (SELECT auth.uid())
        AND shop_profiles.id = afa_orders.shop_id
    ))
    OR
    -- Admin / sub-admin (unchanged from the existing policy).
    (EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = (SELECT auth.uid())
        AND users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])
    ))
  );

NOTIFY pgrst, 'reload schema';
