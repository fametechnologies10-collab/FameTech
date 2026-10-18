-- supabase/migrations/20261018b_seed_afa_price_customer.sql
-- =============================================================================
-- AFA selling price for the customer tier.
--
-- afa_price_agent (14.5) and afa_price_dealer (14) were saved from the admin
-- settings UI on 2026-10-18, but afa_price_customer was never written: that
-- form only upserts fields whose value differs from the baseline captured at
-- load (app/admin/settings/page.tsx:519), and the untouched customer input
-- still held its own `|| '15'` fallback, so it was not considered dirty.
--
-- With the key absent, resolveAfaPrice() (lib/afa-pricing.ts) returns null for
-- the customer role, which callers surface as "pricing not configured" — a 500
-- on the dashboard, the v2 developer API and shop storefronts. USSD was
-- unaffected: lib/ussd/price-resolver.ts falls through to afa_price_ussd ?? 15.
--
-- Owner-chosen value: GHS 15, which matches both the admin UI default and the
-- price USSD customers were already paying, so every channel now agrees.
-- Against afa_cost_price = 13 this is a GHS 2.00 margin (13.33%), and the tier
-- ordering stays correct (dealer 14 < agent 14.5 < customer 15).
--
-- jsonb STRING form, matching every sibling AFA price key and what the admin
-- settings upsert writes.
--
-- Applied to the live project via the apply_migration MCP tool on 2026-10-18;
-- saved here for repo history per CLAUDE.md's DB-migrations convention.
-- See also: 20261018_seed_afa_cost_price.sql (the matching cost input).
-- =============================================================================
INSERT INTO public.admin_settings (key, value)
VALUES ('afa_price_customer', '"15"')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
