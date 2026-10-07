-- Lock client-side writes on tables adjacent to the money tables.
-- user_payment_references: a client INSERT policy let any user create reference codes directly;
-- the MoMo SMS auto-claim credits whichever account owns a matching reference.
-- ussd_pending_orders / shop_orders / shop_customers: unused authenticated write grants with no
-- write policy (inert today, one careless policy away from reopening).
-- All app writers use the service role (verified 2026-09-25).
-- See docs/security-audits/2026-09-24-client-order-forgery.md §7.

DROP POLICY user_payment_references_insert_own_or_admin ON public.user_payment_references;
DROP POLICY user_payment_references_admin_update       ON public.user_payment_references;
DROP POLICY user_payment_references_admin_delete       ON public.user_payment_references;

REVOKE INSERT, UPDATE, DELETE
  ON public.user_payment_references, public.ussd_pending_orders,
     public.shop_orders, public.shop_customers
  FROM anon, authenticated;

-- Reuses the guard from 20260924b_lock_client_money_writes.sql
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.user_payment_references
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();
