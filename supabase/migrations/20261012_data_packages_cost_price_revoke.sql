-- 20261012_data_packages_cost_price_revoke
-- Data Bundles page audit (2026-10-12), finding: data_packages.cost_price is our
-- WHOLESALE cost, but the table has a public-read RLS policy ("Anyone can view
-- packages", USING true) and anon/authenticated held table-level SELECT, so anyone
-- with the public anon key could read every package's margin:
--   GET /rest/v1/data_packages?select=size,price,cost_price
--
-- RLS is row-level, not column-level, and a column REVOKE alone is INEFFECTIVE while
-- the role still holds a table-level SELECT (the table grant covers every column).
-- Same pattern as 20260706g_shop_pricing_col_privs: revoke the table-level SELECT and
-- re-grant it on every column EXCEPT cost_price.
--
-- agent_price / dealer_price stay readable on purpose: the dashboard and the shop
-- pricing page render the viewer's tier price client-side, and those tiers are
-- advertised pricing, not cost.
--
-- cost_price is only read server-side (service_role is unaffected by these grants):
-- the purchase routes, retry-service, shop-order-processor, admin routes, USSD, v2 API.
-- The two browser `select('*')` readers (app/dashboard/data-packages/page.tsx and
-- app/dashboard/shop/pricing/page.tsx) are pinned to explicit column lists in the same
-- change, so they no longer expand to the now-ungranted column.
--
-- DEPLOY ORDER: ship the app change FIRST. Until it is live, the old bundle's
-- `select('*')` is rejected by this migration and the Data Bundles page cannot load
-- packages. (Cached browsers also purge the legacy kf-packages-cache key on first load.)
--
-- NOTE: columns added to data_packages LATER are not auto-granted to anon/authenticated
-- any more — add `GRANT SELECT (<new_col>) ON public.data_packages TO anon, authenticated;`
-- to the migration that adds them, or the browser readers will not see them.

REVOKE SELECT ON public.data_packages FROM anon;
REVOKE SELECT ON public.data_packages FROM authenticated;

-- Defensive: drop any pre-existing column-level grant on the secret column too.
REVOKE SELECT (cost_price) ON public.data_packages FROM anon;
REVOKE SELECT (cost_price) ON public.data_packages FROM authenticated;

GRANT SELECT (id, network, size, price, description, is_available, sort_order, created_at, updated_at,
              agent_price, dealer_price, ussd_price, ussd_enabled, category)
  ON public.data_packages TO anon;
GRANT SELECT (id, network, size, price, description, is_available, sort_order, created_at, updated_at,
              agent_price, dealer_price, ussd_price, ussd_enabled, category)
  ON public.data_packages TO authenticated;
