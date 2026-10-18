-- supabase/migrations/20261018_seed_afa_cost_price.sql
-- =============================================================================
-- Profit Engine v2 cost input: afa_cost_price.
--
-- The 20260928_profit_engine_v2.sql seed used ON CONFLICT (key) DO NOTHING and
-- never landed on this project (the row was absent as of 2026-10-18), so
-- _profit_totals_v2's afa_setting CTE resolved to NULL — which makes the engine
-- report AFA revenue/cost/profit as 0 and flag every completed AFA order as
-- `excluded` rather than assume a cost. With afa_setting empty, the afa_agg CTE
-- returned ZERO rows, so the 'afa' key was missing from get_profit_summary_v2's
-- by_product object entirely. Owner-supplied real value: GHS 13.
--
-- Stored as a jsonb STRING ('"13"'), matching the sibling cost inputs and what
-- the admin settings page's upsert writes (app/admin/settings/page.tsx:529
-- sends a plain JS string for this key). The engine reads it via
-- NULLIF(trim(both '"' from value::text), '')::numeric, which accepts either
-- shape — the string form is kept so a later save from the admin UI does not
-- change the stored representation.
--
-- Reporting-only: afa_cost_price is read by nothing but the profit engine (and
-- surfaced read/write in the admin settings UI). It is NOT part of any AFA
-- pricing or charging path, so this does not alter what any customer pays.
--
-- Applied to the live project via the apply_migration MCP tool on 2026-10-18;
-- saved here for repo history per CLAUDE.md's DB-migrations convention.
-- =============================================================================
INSERT INTO public.admin_settings (key, value)
VALUES ('afa_cost_price', '"13"')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
