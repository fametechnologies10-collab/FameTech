-- Delivery status / gateway strength: record WHEN an order was actually delivered.
-- Additive + idempotent. Apply to live via apply_migration, then keep this file for history.
--
-- 1. orders.delivered_at (nullable, no backfill: history stays empty rather than faked)
-- 2. BEFORE UPDATE trigger: first write wins (DB-enforced, a later writer can never move it);
--    its function has EXECUTE revoked from PUBLIC/anon/authenticated
-- 3. Two partial indexes for the stats query (delivered side + failed/refunded-unconfirmed side)
-- 4. get_gateway_delivery_stats(): aggregates only, SERVICE ROLE ONLY

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

CREATE OR REPLACE FUNCTION public.orders_keep_first_delivered_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.delivered_at IS NOT NULL THEN
    NEW.delivered_at := OLD.delivered_at;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_orders_keep_first_delivered_at ON public.orders;
CREATE TRIGGER trg_orders_keep_first_delivered_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_keep_first_delivered_at();

-- Trigger functions run regardless of EXECUTE privilege; revoke to drop the pointless RPC surface.
REVOKE ALL ON FUNCTION public.orders_keep_first_delivered_at() FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_orders_network_delivered_at
  ON public.orders (network, delivered_at DESC)
  WHERE delivered_at IS NOT NULL;

-- Serves the failed side of get_gateway_delivery_stats() (failed/refunded, never delivered, by updated_at).
CREATE INDEX IF NOT EXISTS idx_orders_failed_unconfirmed_updated
  ON public.orders (updated_at DESC)
  WHERE status IN ('failed','refunded') AND delivered_at IS NULL;

-- One row per key: MTN, Telecel, AT-iShare, AT-BigTime, standard_bundles (always 5 rows).
--  * delivery_minutes: minutes (delivered_at - created_at) of the newest 20 qualifying delivered
--    rows in the last 6h, newest first. Qualifying = category 'data', delivered_at >= created_at,
--    retry_count = 0, retry_of_order_id IS NULL.
--  * last_placed_at / last_delivered_at: from the newest qualifying delivered row.
--  * resolved_count / failed_count: over the newest 20 of the UNION of delivered rows (keyed by
--    delivered_at) and failed/refunded rows that were never delivered (keyed by updated_at),
--    within the last 6h. failed_count counts the failed side only.
--  * standard_bundles: same logic over standard_bundle_orders with completed_at as delivered time.
-- SECURITY INVOKER + EXECUTE granted to service_role only (exposes no order ids/phones/users).
CREATE OR REPLACE FUNCTION public.get_gateway_delivery_stats()
RETURNS TABLE (
  key text,
  last_placed_at timestamptz,
  last_delivered_at timestamptz,
  delivery_minutes numeric[],
  resolved_count int,
  failed_count int
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH win AS (
    SELECT now() - interval '6 hours' AS since
  ),
  keys(k, ord) AS (
    VALUES ('MTN', 1), ('Telecel', 2), ('AT-iShare', 3), ('AT-BigTime', 4), ('standard_bundles', 5)
  ),
  delivered AS (
    SELECT o.network AS k, o.created_at, o.delivered_at
    FROM public.orders o, win
    WHERE o.category = 'data'
      AND o.network IN ('MTN', 'Telecel', 'AT-iShare', 'AT-BigTime')
      AND o.delivered_at >= win.since
      AND o.delivered_at >= o.created_at
      AND o.retry_count = 0
      AND o.retry_of_order_id IS NULL
    UNION ALL
    SELECT 'standard_bundles', s.created_at, s.completed_at
    FROM public.standard_bundle_orders s, win
    WHERE s.completed_at >= win.since
      AND s.completed_at >= s.created_at
  ),
  failed AS (
    SELECT o.network AS k, o.updated_at AS ts
    FROM public.orders o, win
    WHERE o.category = 'data'
      AND o.network IN ('MTN', 'Telecel', 'AT-iShare', 'AT-BigTime')
      AND o.status IN ('failed', 'refunded')
      AND o.delivered_at IS NULL
      AND o.updated_at >= win.since
    UNION ALL
    SELECT 'standard_bundles', s.updated_at
    FROM public.standard_bundle_orders s, win
    WHERE s.status IN ('failed', 'refunded')
      AND s.completed_at IS NULL
      AND s.updated_at >= win.since
  ),
  d_ranked AS (
    SELECT d.k, d.created_at, d.delivered_at,
           row_number() OVER (PARTITION BY d.k ORDER BY d.delivered_at DESC) AS rn
    FROM delivered d
  ),
  r_ranked AS (
    SELECT u.k, u.is_failed,
           row_number() OVER (PARTITION BY u.k ORDER BY u.ts DESC) AS rn
    FROM (
      SELECT d.k, d.delivered_at AS ts, false AS is_failed FROM delivered d
      UNION ALL
      SELECT f.k, f.ts, true FROM failed f
    ) u
  )
  SELECT
    keys.k::text,
    (SELECT dr.created_at   FROM d_ranked dr WHERE dr.k = keys.k AND dr.rn = 1),
    (SELECT dr.delivered_at FROM d_ranked dr WHERE dr.k = keys.k AND dr.rn = 1),
    COALESCE(
      (SELECT array_agg(round(extract(epoch FROM (dr.delivered_at - dr.created_at)) / 60.0, 2)::numeric
                        ORDER BY dr.delivered_at DESC)
       FROM d_ranked dr WHERE dr.k = keys.k AND dr.rn <= 20),
      '{}'::numeric[]
    ),
    (SELECT count(*)::int FROM r_ranked rr WHERE rr.k = keys.k AND rr.rn <= 20),
    (SELECT count(*) FILTER (WHERE rr.is_failed)::int FROM r_ranked rr WHERE rr.k = keys.k AND rr.rn <= 20)
  FROM keys
  ORDER BY keys.ord;
$$;

REVOKE ALL ON FUNCTION public.get_gateway_delivery_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gateway_delivery_stats() TO service_role;
