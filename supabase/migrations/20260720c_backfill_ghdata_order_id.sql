-- One-time backfill: ghdata_order_id was added in 20260720b_orders_ghdata_reference.sql,
-- so every pre-existing order has it NULL. Recover the value from
-- mtn_fulfillment_tracking.api_response.ghdata_order_id (the only place it lived before
-- the column existed) so the rewritten sync routes can find these orders — they filter on
-- ghdata_order_id IS NOT NULL. Already applied live on 2026-07-20 (18 rows); safe to re-run,
-- the WHERE clause only ever matches rows still missing the column.
WITH recovered AS (
  SELECT
    o.id AS order_id,
    t.api_response->>'ghdata_order_id' AS ghdata_order_id
  FROM orders o
  JOIN LATERAL (
    SELECT api_response
    FROM mtn_fulfillment_tracking
    WHERE order_id = o.id
      AND lower(api_response->>'supplier') = 'ghdata'
      AND api_response->>'ghdata_order_id' IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  ) t ON true
  WHERE o.status = 'processing'
    AND o.fulfillment_method = 'ghdata'
    AND o.ghdata_order_id IS NULL
)
UPDATE orders
SET ghdata_order_id = recovered.ghdata_order_id
FROM recovered
WHERE orders.id = recovered.order_id;
