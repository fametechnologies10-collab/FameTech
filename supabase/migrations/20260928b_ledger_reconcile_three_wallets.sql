-- LEDGER HISTORY ONLY — no wallet balance is changed (this file never touches public.wallets).
-- Closes the last 3 wallets that did not reconcile after F11 (history said more money than the
-- balance). Owner-approved 2026-09-28. See docs/security-audits/2026-09-24-client-order-forgery.md.
--
--  * 3b63904a (agent, gap 197.01): the admin compensation credit "Refund for the old site…" was
--    written to history TWICE, 9 ms apart (2026-01-23 09:52:41.971 / .979); the balance was only
--    credited once. Remove the later duplicate row.
--  * b60fc2f0 (owner's admin account, gap 127.50) and 5ba3a6d0 (owner's own test shop
--    felix-s-shop, gap 36.85): no order/refund explains the gap — balances were adjusted directly
--    during testing before the 2026-09-24 money-table lock. Add one labelled reconciliation
--    debit to history so it matches the balance. Owner confirmed both accounts are his.
--
-- Aborts (raises) unless each gap is still exactly what was measured, so live activity or a
-- re-run can never apply a wrong adjustment.

DO $$
DECLARE
    v_gap numeric;
    r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('3b63904a-a26f-48f9-ac2b-c72222bc30e4'::uuid, 197.01::numeric),
        ('b60fc2f0-c438-4d2a-847b-33128ae09b9a'::uuid, 127.50::numeric),
        ('5ba3a6d0-0990-4992-943b-706ac3dc2994'::uuid,  36.85::numeric)) AS x(uid, expected)
    LOOP
        SELECT round(coalesce(sum(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0) - w.balance, 2)
          INTO v_gap
          FROM public.wallets w
          LEFT JOIN public.wallet_transactions t ON t.user_id = w.user_id
         WHERE w.user_id = r.uid
         GROUP BY w.balance;
        IF v_gap IS DISTINCT FROM r.expected THEN
            RAISE EXCEPTION 'Reconcile aborted: user % gap is %, expected %', r.uid, v_gap, r.expected;
        END IF;
    END LOOP;
END $$;

-- 1) Remove the duplicated history row (the later of the two identical 197.01 credits).
DELETE FROM public.wallet_transactions
 WHERE id = '8468267b-3686-47bb-92a4-1e9826aed96e'
   AND user_id = '3b63904a-a26f-48f9-ac2b-c72222bc30e4'
   AND type = 'credit' AND amount = 197.01;

-- 2) Reconciliation history rows for the owner's own two accounts.
INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status, metadata)
SELECT w.id, w.user_id, 'debit', x.amt,
       'Ledger reconciliation (audit 2026-09-28): history adjusted to match balance — no balance change',
       'AUDIT-RECON-20260928-' || left(w.user_id::text, 8), 'admin', 'completed',
       jsonb_build_object('audit', '2026-09-24-client-order-forgery', 'history_only', true)
  FROM public.wallets w
  JOIN (VALUES ('b60fc2f0-c438-4d2a-847b-33128ae09b9a'::uuid, 127.50::numeric),
               ('5ba3a6d0-0990-4992-943b-706ac3dc2994'::uuid,  36.85::numeric)) AS x(uid, amt)
    ON x.uid = w.user_id;

-- Rollback: re-insert the deleted row (id 8468267b-3686-47bb-92a4-1e9826aed96e, copy of
-- b7f1b4cc-d6eb-45fb-aca9-6598276224f5 at 2026-01-23 09:52:41.979953+00) and
--   DELETE FROM public.wallet_transactions WHERE reference LIKE 'AUDIT-RECON-20260928-%';
