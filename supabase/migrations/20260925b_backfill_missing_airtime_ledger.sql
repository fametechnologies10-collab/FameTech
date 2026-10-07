-- Backfill missing wallet_transactions DEBIT history rows for web airtime/mashup orders.
--
-- From 2026-03-23 (feature launch, commit d8b35582) until ~2026-07-02 the airtime route
-- (app/api/airtime/create/route.ts) debited the wallet via deduct_wallet_balance but its
-- fire-and-forget ledger insert omitted the NOT NULL columns user_id and description,
-- so every insert failed silently. Balances were charged correctly; only history is missing.
-- Verified 2026-09-25: 161 orders / GHS 891.47 / 49 users; 39 users reconcile to the pesewa
-- after this backfill, the other 10 keep unrelated positive residuals (tracked as F11).
-- See docs/security-audits/2026-09-24-client-order-forgery.md (follow-up F2).
--
-- History rows ONLY — wallets.balance / total_spent are NOT touched.
-- Idempotent: NOT EXISTS skips any order that already has a debit with its reference.

INSERT INTO public.wallet_transactions
  (wallet_id, user_id, type, amount, description, reference, source, status, created_at)
SELECT
  w.id,
  a.user_id,
  'debit',
  a.total_paid,
  CASE WHEN a.type = 'mashup'
       THEN 'Mashup: GHS ' || to_char(a.airtime_amount, 'FM999999990.00') || ' bundle for ' || a.beneficiary_phone || ' (MTN)'
       ELSE 'Airtime: GHS ' || to_char(a.airtime_amount, 'FM999999990.00') || ' for ' || a.beneficiary_phone || ' (' || a.network || ')'
  END,
  a.reference_code,
  'airtime',
  'completed',
  a.created_at
FROM public.airtime_orders a
JOIN public.wallets w ON w.user_id = a.user_id
WHERE a.shop_id IS NULL
  AND coalesce(a.source, '') <> 'shop'
  AND a.reference_code NOT LIKE 'USSD-%'
  AND a.user_id IS NOT NULL
  AND a.created_at >= '2026-03-23'
  AND a.created_at <  '2026-07-03'
  AND NOT EXISTS (
    SELECT 1 FROM public.wallet_transactions t
    WHERE t.type = 'debit' AND t.reference = a.reference_code
  );
