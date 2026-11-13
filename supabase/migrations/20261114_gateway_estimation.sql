-- Delivery estimation engine: data layer.
-- Additive + idempotent. Apply to live (SQL editor / apply_migration), then keep this file for history.
-- Does NOT touch get_gateway_delivery_stats() or its indexes.
--
-- 1. gateway_status_overrides: manual "gateway down" state per channel. SERVER-WRITE-ONLY
--    (RLS on, no policies, no anon/authenticated grants).
-- 2. Four partial indexes serving the signal lookups.
-- 3. get_gateway_signals(): exactly 5 rows (MTN, Telecel, AT-iShare, AT-BigTime, standard_bundles).
--    Two signals per channel, timestamps only:
--      C = newest-PLACED completed, supplier-confirmed order in the last 24h (by created_at).
--      P = OLDEST still-open order placed AFTER C, anchored on C's created_at (never its delivery time).
--    SECURITY INVOKER, EXECUTE for service_role only.

CREATE TABLE IF NOT EXISTS public.gateway_status_overrides (
  channel text PRIMARY KEY
    CHECK (channel IN ('MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'standard_bundles')),
  is_manually_down boolean NOT NULL DEFAULT false,
  reason text,
  since timestamptz,
  snapshot jsonb,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gateway_status_overrides ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: only the service role (which bypasses RLS) may read or write.
REVOKE ALL ON public.gateway_status_overrides FROM PUBLIC, anon, authenticated;

INSERT INTO public.gateway_status_overrides (channel)
VALUES ('MTN'), ('Telecel'), ('AT-iShare'), ('AT-BigTime'), ('standard_bundles')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_orders_gw_completed
  ON public.orders (network, created_at DESC)
  WHERE delivered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_gw_open
  ON public.orders (network, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_sbo_gw_completed
  ON public.standard_bundle_orders (created_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sbo_gw_open
  ON public.standard_bundle_orders (created_at)
  WHERE status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.get_gateway_signals()
RETURNS TABLE (
  key text,
  c_created_at timestamptz,
  c_delivered_at timestamptz,
  p_created_at timestamptz,
  is_manually_down boolean,
  down_reason text,
  down_since timestamptz,
  down_snapshot jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH keys(k, ord) AS (
    VALUES ('MTN', 1), ('Telecel', 2), ('AT-iShare', 3), ('AT-BigTime', 4), ('standard_bundles', 5)
  )
  SELECT
    keys.k::text,
    CASE WHEN keys.k = 'standard_bundles' THEN cb.created_at ELSE co.created_at END,
    CASE WHEN keys.k = 'standard_bundles' THEN cb.completed_at ELSE co.delivered_at END,
    CASE WHEN keys.k = 'standard_bundles' THEN pb.created_at ELSE po.created_at END,
    COALESCE(ov.is_manually_down, false),
    ov.reason,
    ov.since,
    ov.snapshot
  FROM keys
  LEFT JOIN public.gateway_status_overrides ov ON ov.channel = keys.k
  -- C (orders): newest-placed supplier-confirmed delivery in the last 24h.
  LEFT JOIN LATERAL (
    SELECT o.created_at, o.delivered_at
    FROM public.orders o
    WHERE keys.k <> 'standard_bundles'
      AND o.network = keys.k
      AND o.category = 'data'
      AND o.delivered_at IS NOT NULL
      AND o.delivered_at >= o.created_at
      AND o.retry_count = 0
      AND o.retry_of_order_id IS NULL
      AND o.created_at >= now() - interval '24 hours'
    ORDER BY o.created_at DESC
    LIMIT 1
  ) co ON true
  -- C (standard bundles).
  LEFT JOIN LATERAL (
    SELECT s.created_at, s.completed_at
    FROM public.standard_bundle_orders s
    WHERE keys.k = 'standard_bundles'
      AND s.completed_at IS NOT NULL
      AND s.completed_at >= s.created_at
      AND s.created_at >= now() - interval '24 hours'
    ORDER BY s.created_at DESC
    LIMIT 1
  ) cb ON true
  -- P (orders): oldest open paid order placed after C. No row when C is NULL.
  LEFT JOIN LATERAL (
    SELECT o.created_at
    FROM public.orders o
    WHERE keys.k <> 'standard_bundles'
      AND co.created_at IS NOT NULL
      AND o.network = keys.k
      AND o.category = 'data'
      AND o.status IN ('pending', 'processing')
      AND o.payment_status = 'paid'
      AND o.retry_count = 0
      AND o.retry_of_order_id IS NULL
      AND o.created_at > co.created_at
    ORDER BY o.created_at ASC
    LIMIT 1
  ) po ON true
  -- P (standard bundles): oldest open order placed after C. No row when C is NULL.
  LEFT JOIN LATERAL (
    SELECT s.created_at
    FROM public.standard_bundle_orders s
    WHERE keys.k = 'standard_bundles'
      AND cb.created_at IS NOT NULL
      AND s.status IN ('pending', 'processing')
      AND s.created_at > cb.created_at
    ORDER BY s.created_at ASC
    LIMIT 1
  ) pb ON true
  ORDER BY keys.ord;
$$;

REVOKE ALL ON FUNCTION public.get_gateway_signals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gateway_signals() TO service_role;
