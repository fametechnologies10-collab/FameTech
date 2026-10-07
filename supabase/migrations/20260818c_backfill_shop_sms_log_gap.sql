-- ============================================================================
-- MIGRATION: Backfill the shop SMS credit accounting gap
-- Date:      2026-08-18
--
-- Problem:   Until 20260818_shop_sms_logs_source_column.sql, automatic shop
--            order-confirmation SMS debited credits via
--            `lib/sms-confirmation-sender.ts` without ever writing a
--            `shop_sms_logs` row. `shop_sms_wallets.total_used` therefore ran
--            ahead of the sum of `shop_sms_logs.credits_used` — measured at
--            4,753 credits across 29 shops when this ran (and still growing,
--            +76 in the hour the fix was being built).
--
--            Effect on shops: credits appeared to vanish with no entry in their
--            history. Effect on the platform: dashboards built on
--            shop_sms_logs under-reported real usage — and therefore real
--            provider cost — by roughly 44%.
--
-- Fix:       Insert ONE clearly-marked `source = 'reconciliation'` row per
--            affected shop carrying that shop's exact gap, so the log finally
--            sums to the wallet.
--
-- Why this shape:
--   * `status = 'sent'` and `segments/recipients_count = 1` are forced by the
--     table's existing CHECK constraints (`status` is an enum; both counts must
--     be > 0). A reconciliation row is an aggregate, not a real send, so those
--     two counts are structurally meaningless here — the `source` column is
--     what tells a reader (and the shop's History tab) not to read it as a send.
--   * The message text says so explicitly, because this row IS shown to shop
--     owners.
--
-- SELF-CORRECTING: the gap is recomputed from live data at run time, and any
--   reconciliation rows already inserted count toward `logged`. Re-running
--   therefore inserts only the NEW delta and converges to zero — which is the
--   intended usage, since the gap keeps growing until the logging fix is
--   actually deployed. Run it once more after deploy to sweep the interim.
--
-- REVERSIBLE: DELETE FROM shop_sms_logs WHERE source = 'reconciliation';
--
-- Requires: 20260818_shop_sms_logs_source_column.sql (the `source` column).
-- ============================================================================

WITH logged AS (
  SELECT shop_id, COALESCE(SUM(credits_used), 0) AS credits
  FROM public.shop_sms_logs
  GROUP BY shop_id
)
INSERT INTO public.shop_sms_logs
  (shop_id, message, recipients_count, segments, credits_used, status, source)
SELECT w.shop_id,
       'Historical reconciliation — automatic order-confirmation SMS charged before per-send logging existed. Not a real send.',
       1,
       1,
       (w.total_used - COALESCE(l.credits, 0))::int,
       'sent',
       'reconciliation'
FROM public.shop_sms_wallets w
LEFT JOIN logged l ON l.shop_id = w.shop_id
WHERE (w.total_used - COALESCE(l.credits, 0)) > 0;

-- Verification (expect both sums equal and zero unreconciled shops):
--   SELECT (SELECT SUM(total_used)   FROM shop_sms_wallets) AS wallet_used,
--          (SELECT SUM(credits_used) FROM shop_sms_logs)    AS logged_used;
-- Result when this ran: 10,663 = 10,663, 0 shops unreconciled, 0 over-logged.
