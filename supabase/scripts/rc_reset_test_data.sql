-- ═══════════════════════════════════════════════════════════
-- RC Test Data Reset Script
-- ═══════════════════════════════════════════════════════════
-- PURPOSE: Safely wipe all Results Checker test data while
--          preserving exam types, admin settings, and user accounts.
--
-- USAGE:   Run ONCE manually in Supabase SQL Editor.
--          This is NOT an auto-migration — it permanently deletes
--          all RC orders, inventory, and complaints.
--
-- PRESERVED:
--   ✓ results_checker_types (all exam types stay)
--   ✓ All admin_settings keys (enable flags, pricing, backorder toggle, markup limits)
--   ✓ User wallets, user accounts, profit logs
--   ✓ admin_profit_logs entries (historical records — harmless)
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ── Pre-check: show what will be deleted ──────────────────
SELECT 'complaints' AS table_name, COUNT(*) AS rows FROM results_checker_complaints
UNION ALL
SELECT 'orders', COUNT(*) FROM results_checker_orders
UNION ALL
SELECT 'inventory', COUNT(*) FROM results_checker_inventory;

-- ── Delete in FK-safe order ───────────────────────────────
DELETE FROM results_checker_complaints;
DELETE FROM results_checker_orders;      -- references inventory via inventory_ids
DELETE FROM results_checker_inventory;   -- references types via type_id

-- ── Post-check: confirm zero rows ────────────────────────
SELECT 'complaints' AS table_name, COUNT(*) AS remaining FROM results_checker_complaints
UNION ALL
SELECT 'orders', COUNT(*) FROM results_checker_orders
UNION ALL
SELECT 'inventory', COUNT(*) FROM results_checker_inventory;

-- ── Preserved tables (verify) ────────────────────────────
SELECT 'types_preserved' AS check, COUNT(*) AS count FROM results_checker_types;

COMMIT;
