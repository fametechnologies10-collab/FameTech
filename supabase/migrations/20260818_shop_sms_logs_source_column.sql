-- ============================================================================
-- MIGRATION: Add shop_sms_logs.source so SMS credit usage can be reconciled
-- Date:      2026-08-18
--
-- Problem:   `lib/sms-confirmation-sender.ts` debits SMS credits for automatic
--            shop order-confirmation SMS (fired from lib/shop-order-processor.ts,
--            lib/ussd/fulfillment/data.ts and lib/ussd/fulfillment/airtime.ts)
--            but NEVER inserts a row into `shop_sms_logs`. Every other credit
--            consumer does. The result, measured 2026-08-18 on production:
--
--              shop_sms_wallets.total_used   10,512 credits
--              shop_sms_logs.credits_used     5,835 credits
--              unaccounted                    4,677 credits  (~44% of usage)
--
--            29 shops had total_used > logged and ZERO had the reverse — a
--            strictly one-directional signature, which is what a debit-without-
--            log path produces (random drift would go both ways).
--
--            Consequences: shops cannot see where their credits went, admin
--            dashboards built on shop_sms_logs under-report real usage (and
--            therefore provider cost) by ~44%, and credit disputes cannot be
--            answered from the log.
--
-- Fix:       Add a `source` discriminator so automatic confirmations are logged
--            distinctly from owner-initiated sends, and so the historical gap
--            can be backfilled as clearly-marked reconciliation rows without
--            being mistaken for real sends.
--
--            'manual'            — owner-initiated send (app/api/shop/sms/send)
--                                  and admin-initiated (app/api/admin/shop-sms).
--                                  Correct default for every pre-existing row,
--                                  since those were the only writers.
--            'auto_confirmation' — automatic order-confirmation SMS.
--            'reconciliation'    — synthetic row closing the historical gap.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS, DROP+ADD CONSTRAINT, CREATE INDEX
--            IF NOT EXISTS are all idempotent.
-- ============================================================================

-- Step 1: the discriminator. Existing rows become 'manual', which is accurate.
ALTER TABLE public.shop_sms_logs
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Step 2: constrain it, mirroring how `status` is constrained on this table.
ALTER TABLE public.shop_sms_logs
  DROP CONSTRAINT IF EXISTS shop_sms_logs_source_check;

ALTER TABLE public.shop_sms_logs
  ADD CONSTRAINT shop_sms_logs_source_check
  CHECK (source IN ('manual', 'auto_confirmation', 'reconciliation'));

-- Step 3: the shop usage view groups by source over a time window, and the
-- reconcile query filters by it, so index the exact access pattern.
CREATE INDEX IF NOT EXISTS idx_shop_sms_logs_shop_source_created
  ON public.shop_sms_logs (shop_id, source, created_at DESC);
