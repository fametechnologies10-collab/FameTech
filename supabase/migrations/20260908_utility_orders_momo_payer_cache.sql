-- ============================================================================
-- 20260908_utility_orders_momo_payer_cache.sql
-- Payer MoMo details on utility_orders, mirroring shop_orders' payer_momo_*
-- columns (20260812_add_shop_orders_momo_payer_cache.sql) — gives admin the
-- same "View MoMo" refund-lookup capability for utility bills that already
-- exists for shop data orders.
--
-- Unlike shop_orders (which only learns the payer's number after the fact via
-- a Paystack transaction verify, because the storefront data-purchase flow
-- never collects it directly), BOTH utility charge rails already collect the
-- payer's MoMo number + network as first-class request input at charge time
-- (see app/api/shop/utility/charge/route.ts and lib/hubtel-checkout.ts) — so
-- number/network are written directly on insert, with no external lookup
-- required. Only the payer NAME needs on-demand resolution (same
-- resolveNameSingle provider call the shop_orders path already uses),
-- resolved lazily by the admin momo-details route and cached back here.
--
-- Already applied directly to the live project via the apply_migration MCP
-- tool (per CLAUDE.md's no-local-Supabase-stack convention) — this file is
-- the repo-history record of that same SQL.
-- ============================================================================

ALTER TABLE public.utility_orders
  ADD COLUMN IF NOT EXISTS payer_momo_number text,
  ADD COLUMN IF NOT EXISTS payer_momo_name text,
  ADD COLUMN IF NOT EXISTS payer_momo_network text,
  ADD COLUMN IF NOT EXISTS payer_momo_resolved_at timestamptz;

NOTIFY pgrst, 'reload schema';
