-- Bring GhData to parity with CodeCraft/DataKazina reference columns on `orders`.
-- Status sync currently reconstructs order->reference maps from a shared, size-capped
-- mtn_fulfillment_tracking window (crowds out low-volume suppliers as total order volume
-- grows). Storing the reference directly on `orders` lets sync query it directly instead.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ghdata_order_id text;
