-- Payment cron hardening: indexes + age-out setting (2026-06-16)

-- Accelerate the pending-payment FIFO select (status='pending' ORDER BY created_at)
CREATE INDEX IF NOT EXISTS idx_wallet_payments_status_created
  ON public.wallet_payments (status, created_at);

-- Prevent duplicate transaction-log rows for Paystack payments on retry/overlap.
-- Verified 0 existing source='payment' reference duplicates in prod, so this is safe.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_payment_reference_unique
  ON public.wallet_transactions (reference)
  WHERE source = 'payment';

-- Admin-configurable age-out window (hours) for stuck pending payments.
-- Stored as a JSON string ("24") to match the existing admin_settings convention
-- (all values are jsonb strings, e.g. paystack fee percents).
INSERT INTO public.admin_settings (key, value)
SELECT 'payment_ageout_hours', to_jsonb('24'::text)
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'payment_ageout_hours');
