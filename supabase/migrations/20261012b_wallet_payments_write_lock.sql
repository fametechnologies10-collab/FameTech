-- Wallet audit hardening, part 2: lock client-side writes on wallet_payments and
-- revoke TRUNCATE on the money tables.
--
-- Why:
--   * wallet_payments had RLS enabled and only a SELECT policy, but `authenticated`
--     still held table-level INSERT/UPDATE/DELETE grants and there was no guard
--     trigger. Every writer in the app uses a service-role client (verified by grep:
--     lib/payments.ts, lib/dealer-payments.ts, lib/pending-payment-runner.ts,
--     app/api/webhooks/paystack, app/api/payments/{initialize,charge},
--     app/api/user/upgrade/initialize), so the grants are dead weight that only
--     matter if a client write policy is ever added. Make that impossible, same as
--     wallets / wallet_transactions / user_payment_references
--     (see 20260924b_lock_client_money_writes.sql).
--   * `anon` and `authenticated` held TRUNCATE on the money tables. TRUNCATE is not
--     subject to RLS and does not fire row-level triggers, so the guard trigger
--     cannot stop it. Revoke it. Only TRUNCATE is revoked here: the momo_* tables
--     keep their INSERT/UPDATE/DELETE grants (admin pages write them through RLS
--     admin policies) and admin_settings is not touched at all.
--
-- Idempotent: REVOKE is a no-op when the privilege is already absent and the trigger
-- is dropped before being re-created. Reuses public.block_client_money_writes() from
-- 20260924b_lock_client_money_writes.sql (SECURITY INVOKER; rejects only the
-- 'anon'/'authenticated' JWT roles, so service_role, migrations and pg_cron pass).

-- 1. wallet_payments: no client write privileges.
REVOKE INSERT, UPDATE, DELETE ON public.wallet_payments FROM anon, authenticated;

-- 2. Guard trigger: stays shut even if a future grant/policy reopens the door.
--    INSERT, UPDATE and DELETE (the guard returns coalesce(NEW, OLD), so DELETE is safe).
DROP TRIGGER IF EXISTS trg_block_client_write ON public.wallet_payments;
CREATE TRIGGER trg_block_client_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_payments
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();

-- 3. TRUNCATE bypasses RLS and row triggers: revoke it on every money table in scope.
REVOKE TRUNCATE ON
  public.wallets,
  public.wallet_transactions,
  public.wallet_payments,
  public.user_payment_references,
  public.momo_transactions,
  public.momo_claim_attempts
FROM anon, authenticated;
