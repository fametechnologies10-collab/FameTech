-- Extends shop_orders_effective (20260816b) with self-service completion fields
-- (self_completed_at, self_completed_by_role) so app/dashboard/shop/orders/page.tsx
-- can render the "Completed by ..." tag and gate the "Confirm Received" button off
-- the same current-order-in-retry-chain row it already uses for retry_count etc.
-- Same drop/recreate as 20260816b (CREATE OR REPLACE VIEW can't insert a column
-- ahead of existing ones) — CASCADE drops get_shop_orders_stats too, recreated
-- identically right after.
drop view if exists public.shop_orders_effective cascade;

create view public.shop_orders_effective
  with (security_invoker = true) as
select
  so.*,
  coalesce(retry.status, mirror.status, so.status) as effective_status,
  coalesce(retry.id, mirror.id) as current_order_id,
  coalesce(retry.refunded_at, mirror.refunded_at) as current_refunded_at,
  coalesce(retry.retry_count, mirror.retry_count) as current_retry_count,
  coalesce(retry.retry_from_status, mirror.retry_from_status) as current_retry_from_status,
  coalesce(retry.retry_of_order_id, mirror.retry_of_order_id) as current_retry_of_order_id,
  coalesce(retry.retried_by_role, mirror.retried_by_role) as current_retried_by_role,
  coalesce(retry.self_completed_at, mirror.self_completed_at) as current_self_completed_at,
  coalesce(retry.self_completed_by_role, mirror.self_completed_by_role) as current_self_completed_by_role,
  mirror.id as mirror_order_id,
  mirror.refunded_at as mirror_refunded_at,
  mirror.retry_count,
  mirror.retry_from_status,
  mirror.retry_of_order_id,
  mirror.retried_by_role
from public.shop_orders so
left join public.orders mirror on mirror.shop_order_id = so.id
left join lateral (
  select
    o2.id,
    o2.status,
    o2.refunded_at,
    o2.retry_count,
    o2.retry_from_status,
    o2.retry_of_order_id,
    o2.retried_by_role,
    o2.self_completed_at,
    o2.self_completed_by_role
  from public.orders o2
  where o2.retry_of_order_id = mirror.id
  order by o2.created_at desc
  limit 1
) retry on mirror.id is not null;

grant select on public.shop_orders_effective to authenticated;

create or replace function public.get_shop_orders_stats(
  p_shop_id uuid,
  p_tab text default 'all',
  p_status text default null,
  p_network text default null,
  p_source text default null,
  p_search text default null,
  p_date_from timestamptz default null
)
returns table (
  total_count bigint,
  pending_count bigint,
  queued_count bigint,
  processing_count bigint,
  completed_count bigint,
  failed_count bigint,
  refunded_count bigint,
  revenue numeric,
  profit numeric
)
language sql
stable
set search_path = ''
as $$
  select
    count(*) as total_count,
    count(*) filter (where v.effective_status = 'pending') as pending_count,
    count(*) filter (where v.effective_status = 'queued') as queued_count,
    count(*) filter (where v.effective_status = 'processing') as processing_count,
    count(*) filter (where v.effective_status = 'completed') as completed_count,
    count(*) filter (where v.effective_status = 'failed') as failed_count,
    count(*) filter (where v.effective_status = 'refunded') as refunded_count,
    coalesce(sum(v.selling_price) filter (
      where v.effective_status in ('pending', 'queued', 'processing', 'completed')
    ), 0) as revenue,
    coalesce(sum(v.profit) filter (
      where v.effective_status in ('pending', 'queued', 'processing', 'completed')
    ), 0) as profit
  from public.shop_orders_effective v
  where v.shop_id = p_shop_id
    and (
      p_tab = 'all'
      or (p_tab = 'data' and v.package_id is not null)
      or (p_tab = 'airtime' and v.package_id is null)
    )
    and (p_status is null or v.effective_status = p_status)
    and (p_network is null or lower(v.network) = lower(p_network))
    and (
      p_source is null
      or (p_source = 'ussd' and v.source in ('ussd', 'ussd_shop'))
      or (p_source = 'storefront' and (v.source is null or v.source not in ('ussd', 'ussd_shop')))
    )
    and (p_search is null or v.guest_phone ilike '%' || p_search || '%')
    and (p_date_from is null or v.created_at >= p_date_from);
$$;

revoke all on function public.get_shop_orders_stats from public, anon;
grant execute on function public.get_shop_orders_stats to authenticated;

NOTIFY pgrst, 'reload schema';
