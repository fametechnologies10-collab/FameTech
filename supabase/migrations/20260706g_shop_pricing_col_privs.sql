-- 20260706g_shop_pricing_col_privs
-- Audit finding #3 (MEDIUM): shop_pricing.sub_price is the Lead's CONFIDENTIAL
-- wholesale price to its sub-agents, but shop_pricing carries a permissive
-- public-read RLS branch (any approved+active shop) and Postgres RLS is
-- row-level, not column-level. So anon/authenticated could read every Lead's
-- sub_price directly via PostgREST:
--   GET /rest/v1/shop_pricing?shop_id=eq.<id>&select=package_id,sub_price
--
-- A column-level REVOKE alone is INEFFECTIVE while the role still holds a
-- table-level SELECT grant (the table grant covers every column). Both anon and
-- authenticated held table-level SELECT here. So we revoke the table-level
-- SELECT and re-grant it on every column EXCEPT sub_price.
--
-- sub_price is only ever read server-side (service_role): credit_lead_margin /
-- computeSubSplit, /api/shop/sub-pricing GET, and /api/shop/pricing (sub cost
-- resolution) all use the service-role client, which is unaffected by these
-- role grants. The two authenticated `select('*')` readers (the owner pricing
-- page and the admin shop-pricing view) are pinned to explicit column lists in
-- the same change so they no longer expand to the now-ungranted sub_price.
--
-- profit_margin retains its (pre-existing, twice-audited, accepted) exposure:
-- it stays in the granted column list because the owner pricing page reads it as
-- `authenticated`. Only sub_price is removed.

REVOKE SELECT ON public.shop_pricing FROM anon;
REVOKE SELECT ON public.shop_pricing FROM authenticated;

GRANT SELECT (id, shop_id, package_id, selling_price, profit_margin, last_auto_updated_at)
  ON public.shop_pricing TO anon;
GRANT SELECT (id, shop_id, package_id, selling_price, profit_margin, last_auto_updated_at)
  ON public.shop_pricing TO authenticated;
