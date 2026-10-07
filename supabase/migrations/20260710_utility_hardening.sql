-- ============================================================================
-- 20260710_utility_hardening.sql
-- Pre-enable hardening items from the B-routes review (utility bills feature):
--
-- 1) DB backstop for concurrent same-client_reference replays on wallet-paid
--    utility orders. The create route stores 'WALLET-<client_reference>' in
--    utility_orders.payment_reference and does a user-scoped check-then-act
--    before debiting; two truly simultaneous requests with the same key could
--    both pass the check. This unique index makes the SECOND insert fail, which
--    lands in the route's existing insert-failure compensating-refund path —
--    net exactly one debit (same mechanics airtime gets from its UNIQUE
--    reference_code). Scoped to user_id so different users may reuse the same
--    client_reference string; guest rows (user_id IS NULL, storefront checkout)
--    are excluded — their payment_reference is a server-generated checkout ref
--    whose uniqueness is handled by that flow.
CREATE UNIQUE INDEX IF NOT EXISTS uq_utility_orders_user_payref
  ON public.utility_orders(user_id, payment_reference)
  WHERE payment_reference IS NOT NULL AND user_id IS NOT NULL;

-- 2) 'utility' value for the wallet_transactions source CHECK (ledger clarity —
--    utility purchase debits currently ship as source='purchase', which is
--    valid; this permits switching to a distinct 'utility' source without a
--    follow-up DDL). Same drop/recreate pattern as 20260702a (which last set
--    this constraint to the 6-value list below).
ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
  CHECK (source IN ('payment','refund','admin','purchase','ussd','airtime','utility'));
