-- Admin Payments Center: audit log + aggregate stats RPC
-- Date: 2026-06-15

-- 1) Audit log for manual admin payment actions (money-touching → traceable)
CREATE TABLE IF NOT EXISTS public.admin_payment_actions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id    UUID REFERENCES public.users(id),
  action      TEXT NOT NULL,            -- 'verify' | 'reconcile' | 'retry_fulfillment'
  reference   TEXT,
  source      TEXT,                     -- 'main' | 'shop' | 'results_checker'
  outcome     TEXT,                     -- 'processed' | 'already_processed' | 'not_paid' | 'failed'
  detail      JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_payment_actions_created   ON public.admin_payment_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_payment_actions_reference ON public.admin_payment_actions(reference);

-- Locked down: RLS on, no policies → only the service-role key (admin routes) can read/write.
ALTER TABLE public.admin_payment_actions ENABLE ROW LEVEL SECURITY;

-- 2) Aggregate stats in one round-trip. Filters by created_at >= from_ts.
--    RC "collected" keys on payment_status (its row can exist unpaid); shop/wallet rows
--    only exist once paid/initialized.
CREATE OR REPLACE FUNCTION public.admin_payment_stats(from_ts timestamptz)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'main', jsonb_build_object(
      'completed_count',  (SELECT count(*)                       FROM wallet_payments WHERE status='completed' AND created_at >= from_ts),
      'completed_amount', (SELECT coalesce(sum(total_amount),0)  FROM wallet_payments WHERE status='completed' AND created_at >= from_ts),
      'pending_count',    (SELECT count(*)                       FROM wallet_payments WHERE status='pending'   AND created_at >= from_ts),
      'pending_amount',   (SELECT coalesce(sum(total_amount),0)  FROM wallet_payments WHERE status='pending'   AND created_at >= from_ts),
      'failed_count',     (SELECT count(*)                       FROM wallet_payments WHERE status='failed'    AND created_at >= from_ts)
    ),
    'shop', jsonb_build_object(
      'completed_count',  (SELECT count(*)                       FROM shop_orders WHERE status IN ('pending','processing','completed') AND created_at >= from_ts),
      'completed_amount', (SELECT coalesce(sum(selling_price),0) FROM shop_orders WHERE status IN ('pending','processing','completed') AND created_at >= from_ts),
      'pending_count',    (SELECT count(*)                       FROM shop_orders WHERE status IN ('pending','processing')             AND created_at >= from_ts),
      'pending_amount',   (SELECT coalesce(sum(selling_price),0) FROM shop_orders WHERE status IN ('pending','processing')             AND created_at >= from_ts),
      'failed_count',     (SELECT count(*)                       FROM shop_orders WHERE status IN ('failed','refunded')                AND created_at >= from_ts)
    ),
    'results_checker', jsonb_build_object(
      'completed_count',  (SELECT count(*)                       FROM results_checker_orders WHERE payment_status='completed'                       AND created_at >= from_ts),
      'completed_amount', (SELECT coalesce(sum(total_paid),0)    FROM results_checker_orders WHERE payment_status='completed'                       AND created_at >= from_ts),
      'pending_count',    (SELECT count(*)                       FROM results_checker_orders WHERE status='pending' AND payment_status='completed'  AND created_at >= from_ts),
      'pending_amount',   (SELECT coalesce(sum(total_paid),0)    FROM results_checker_orders WHERE status='pending' AND payment_status='completed'  AND created_at >= from_ts),
      'failed_count',     (SELECT count(*)                       FROM results_checker_orders WHERE status IN ('failed','refunded')                  AND created_at >= from_ts)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.admin_payment_stats(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_payment_stats(timestamptz) TO service_role;
