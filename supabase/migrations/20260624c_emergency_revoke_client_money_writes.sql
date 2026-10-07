-- =============================================================================
-- EMERGENCY LOCKDOWN (P0) — applied to prod 2026-06-24 via red-team finding.
-- 'authenticated' AND 'anon' held table-level INSERT/UPDATE/DELETE on the money
-- tables, so any logged-in user could (via PostgREST + the public anon key):
--   * INSERT a phantom 'withdrawal' row that never debited their wallet -> admin pays it
--   * UPDATE their own shop_wallets.balance / wallets.balance to any value -> withdraw it
-- Confirmed live (pg_policy + information_schema grants + pg_trigger). Code grep
-- confirmed ZERO client-side .insert/.update on these tables — every legitimate
-- write is a SECURITY DEFINER RPC (process_shop_withdrawal, credit_shop_profit,
-- refund_shop_withdrawal, handle_new_user_wallet, ...) that runs as the definer and
-- is UNAFFECTED by these REVOKEs. SELECT preserved so owners read their own history.
-- =============================================================================
REVOKE INSERT, UPDATE, DELETE ON public.shop_wallets             FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.shop_wallet_transactions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.wallets                  FROM authenticated, anon;

DROP POLICY IF EXISTS "Owners can update their own shop wallet"       ON public.shop_wallets;
DROP POLICY IF EXISTS "Owners can insert their own shop transactions" ON public.shop_wallet_transactions;
