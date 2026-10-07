-- Backfill orders.status (and, for the two rows where it's also stale, shop_orders.status)
-- for shop-attributed airtime orders whose delivery outcome was resolved by the Hubtel
-- Commission webhook's async completion callback but never written back to the `orders`
-- ledger row.
--
-- Root cause: app/api/webhooks/hubtel-commission/route.ts's completion branch called
-- syncShopOrderStatus(), which updates shop_orders.status and (for SHOP- refs) airtime_orders
-- .status, but never writes orders.status itself. Fixed in the same change as this migration
-- to call syncAirtimeShopMirror() instead (lib/airtime-fulfillment.ts), which updates both
-- `orders` and `shop_orders`. This migration is the one-time correction for orders already
-- stuck before that fix.
--
-- Verified 2026-09-25: 53 orders stuck 'pending' despite shop_orders/airtime_orders already
-- showing 'completed' (airtime genuinely delivered), spanning 2026-09-16 through 2026-09-25;
-- 2 more stuck 'pending' in BOTH orders and shop_orders despite airtime_orders showing
-- 'failed' (delivery genuinely failed, from 2026-09-09). airtime_orders.status is the
-- authoritative record in every case (written directly by the dispatch/webhook code), so it
-- drives both updates below.
--
-- No money movement — status/history correction only. Idempotent: only touches rows still
-- sitting at 'pending' with a resolved (completed/failed) airtime_orders counterpart.

begin;

-- 1. orders.status
update public.orders o
set status = ao.status, updated_at = now()
from public.airtime_orders ao
where ao.reference_code = o.reference_code
  and o.status = 'pending'
  and ao.status in ('completed', 'failed');

-- 2. shop_orders.status (covers the 2 rows where the shop-side ledger was also never synced)
update public.shop_orders so
set status = ao.status, updated_at = now()
from public.orders o
join public.airtime_orders ao on ao.reference_code = o.reference_code
where o.shop_order_id = so.id
  and so.status = 'pending'
  and ao.status in ('completed', 'failed');

commit;
