-- HOTFIX (applied live 2026-09-03, out of band).
--
-- An earlier revision of 20260903_afa_amount_markup.sql dropped
-- shop_profiles.afa_fee_percent. The code deployed on main at that moment still
-- named that column in its PostgREST select list on every shop storefront page
-- load (app/shop/[shopSlug]/page.tsx, app/shop-domain/[shopSlug]/page.tsx) and in
-- the shop pricing dashboard + save route. PostgREST rejects a select naming a
-- column that does not exist, so every storefront started failing to resolve its
-- shop row. TypeScript could not catch it: those selects are runtime strings.
--
-- This restores the column as a nullable, unused compatibility shim so the
-- deployed code keeps working until the v2 branch (which stops referencing it)
-- ships. It carries no data — the same migration had already nulled it.
--
-- 20260903_afa_amount_markup.sql has since been corrected to NOT drop the column.
-- The real drop belongs in its own later migration, applied only after the
-- referencing code is deployed. Expand first, contract later.
ALTER TABLE public.shop_profiles
  ADD COLUMN IF NOT EXISTS afa_fee_percent numeric;

NOTIFY pgrst, 'reload schema';
