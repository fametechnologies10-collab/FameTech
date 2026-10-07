-- Lock client-side writes to order & wallet tables.
-- Closes: any logged-in user could INSERT a forged pending order via Supabase REST
-- (wallet minting via /api/user/orders/refund; free data via refulfill cron; free airtime
-- via hubtel-commission-reconcile cron), and admin/sub-admin could write wallets/ledger
-- directly, bypassing the audited admin_adjust_wallet RPC.
-- All legitimate writers use the service role (verified 2026-09-24); see
-- docs/security-audits/2026-09-24-client-order-forgery.md

-- 1. Remove client-side write policies (SELECT "view own" policies are KEPT)
DROP POLICY "Users can create orders"                ON public.orders;
DROP POLICY "Users can create airtime orders"        ON public.airtime_orders;
DROP POLICY "Admins can update airtime orders"       ON public.airtime_orders;
DROP POLICY afa_orders_insert_combined                ON public.afa_orders;
DROP POLICY afa_orders_admin_update                   ON public.afa_orders;
DROP POLICY afa_orders_admin_delete                   ON public.afa_orders;
DROP POLICY "Admins can update wallets"              ON public.wallets;
DROP POLICY "Admins can insert wallet transactions"  ON public.wallet_transactions;

-- 2. Remove the underlying grants (table-level REVOKE also clears column grants)
REVOKE INSERT, UPDATE, DELETE
  ON public.orders, public.airtime_orders, public.afa_orders,
     public.wallets, public.wallet_transactions
  FROM anon, authenticated;

-- 3. Guard trigger: stays shut even if a future grant/policy reopens the door.
-- SECURITY INVOKER on purpose: it must read the CALLER's JWT role.
-- service_role requests -> 'service_role' (allowed); Auth signup / migrations / pg_cron -> NULL (allowed).
CREATE OR REPLACE FUNCTION public.block_client_money_writes()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'SECURITY: % can only be written by the server', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

-- Order tables: INSERT only. An UPDATE trigger would break delete_shop_data(), whose
-- FK cascade updates orders.shop_order_id under the shop owner's JWT.
CREATE TRIGGER trg_block_client_insert BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();
CREATE TRIGGER trg_block_client_insert BEFORE INSERT ON public.airtime_orders
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();
CREATE TRIGGER trg_block_client_insert BEFORE INSERT ON public.afa_orders
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();

-- Wallet tables: INSERT + UPDATE (no user-session cascade touches these;
-- handle_new_user_wallet runs on the Auth-side signup path where auth.role() is NULL).
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();
