-- Server-side pagination for order-history pages (my-orders, shop/orders).
--
-- Adds composite indexes matching the new paginated queries, a
-- security_invoker view that resolves shop_orders' retry-aware effective
-- status once (instead of duplicating the retry-descendant lookup in every
-- query), and small read-only stats RPCs so the summary cards stay accurate
-- across the full filtered set, not just the current page.

-- === Indexes ================================================================

-- my-orders: WHERE user_id = X AND shop_order_id IS NULL ORDER BY created_at DESC
create index if not exists idx_orders_user_created
  on public.orders (user_id, created_at desc)
  where shop_order_id is null;

-- shop/orders (data+airtime tabs): WHERE shop_id = X ORDER BY created_at DESC
create index if not exists idx_shop_orders_shop_created
  on public.shop_orders (shop_id, created_at desc);

-- shop/orders (vouchers tab): WHERE shop_id = X ORDER BY created_at DESC
create index if not exists idx_rc_orders_shop_created
  on public.results_checker_orders (shop_id, created_at desc);

-- Supports the LATERAL retry-descendant lookup in shop_orders_effective below.
create index if not exists idx_orders_retry_of_created
  on public.orders (retry_of_order_id, created_at desc)
  where retry_of_order_id is not null;

-- === View: shop_orders with retry-aware effective_status ==================
--
-- shop_orders.status only stays in sync with the mirrored orders.status for
-- the ORIGINAL order — a retry on a refunded order creates a NEW orders row
-- (retry_of_order_id pointing back at the original) rather than mutating the
-- original in place, so shop_orders.status can go stale ("refunded" forever)
-- even after a successful retry. app/dashboard/shop/orders/page.tsx has
-- always re-resolved this client-side (see effectiveStatus()); this view
-- moves that same resolution server-side so filtering/pagination can use it
-- without silently missing retried orders or misclassifying them.
--
-- security_invoker = true is required: without it, Postgres checks the VIEW
-- OWNER's privileges against shop_orders/orders, silently bypassing RLS for
-- every caller. With it, the view enforces exactly the same RLS policies
-- (owner, parent-shop, admin) as querying shop_orders directly.
create or replace view public.shop_orders_effective
  with (security_invoker = true) as
select
  so.*,
  coalesce(retry.status, mirror.status, so.status) as effective_status,
  mirror.id as mirror_order_id,
  mirror.refunded_at as mirror_refunded_at,
  mirror.retry_count,
  mirror.retry_from_status,
  mirror.retry_of_order_id,
  mirror.retried_by_role
from public.shop_orders so
left join public.orders mirror on mirror.shop_order_id = so.id
left join lateral (
  select o2.status
  from public.orders o2
  where o2.retry_of_order_id = mirror.id
  order by o2.created_at desc
  limit 1
) retry on mirror.id is not null;

grant select on public.shop_orders_effective to authenticated;

-- === Stats RPCs ==============================================================
--
-- Read-only, SECURITY INVOKER (the default — no `security definer` here),
-- so RLS applies exactly as if the caller queried these tables directly.
-- Deliberately NOT security definer: these are plain reads of the caller's
-- own already-RLS-scoped data, not privileged writes, so there is no reason
-- to bypass RLS and every reason not to.

create or replace function public.get_my_orders_stats(
  p_user_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_network text default null,
  p_category text default null,
  p_search text default null
)
returns table (
  total_count bigint,
  pending_count bigint,
  queued_count bigint,
  processing_count bigint,
  completed_count bigint,
  failed_count bigint,
  refunded_count bigint,
  total_amount numeric,
  total_data_gb numeric
)
language sql
stable
set search_path = ''
as $$
  with matched as (
    select
      o.status,
      o.price,
      o.payment_status,
      o.size
    from public.orders o
    where o.user_id = p_user_id
      and o.shop_order_id is null
      and o.created_at >= p_date_from
      and o.created_at <= p_date_to
      and (p_network is null or o.network = p_network)
      and (p_category is null or coalesce(o.category, 'data') = p_category)
      and (p_search is null or o.phone_number ilike '%' || p_search || '%')
  ),
  sized as (
    select
      status,
      price,
      payment_status,
      (regexp_match(lower(size), '([\d.]+)\s*(gb|mb)'))[1]::numeric as size_value,
      (regexp_match(lower(size), '([\d.]+)\s*(gb|mb)'))[2] as size_unit
    from matched
  )
  select
    count(*) as total_count,
    count(*) filter (where status = 'pending') as pending_count,
    count(*) filter (where status = 'queued') as queued_count,
    count(*) filter (where status = 'processing') as processing_count,
    count(*) filter (where status = 'completed') as completed_count,
    count(*) filter (where status = 'failed') as failed_count,
    count(*) filter (where status = 'refunded') as refunded_count,
    coalesce(sum(price) filter (where payment_status is distinct from 'refunded'), 0) as total_amount,
    coalesce(sum(
      case
        when size_unit = 'gb' then size_value
        when size_unit = 'mb' then size_value / 1024
        else 0
      end
    ) filter (where payment_status is distinct from 'refunded'), 0) as total_data_gb
  from sized;
$$;

revoke all on function public.get_my_orders_stats from public, anon;
grant execute on function public.get_my_orders_stats to authenticated;

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

create or replace function public.get_shop_voucher_stats(
  p_shop_id uuid,
  p_status text default null,
  p_search text default null,
  p_date_from timestamptz default null
)
returns table (
  total_count bigint,
  pending_count bigint,
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
    count(*) filter (where r.status = 'pending') as pending_count,
    count(*) filter (where r.status = 'processing') as processing_count,
    count(*) filter (where r.status = 'completed') as completed_count,
    count(*) filter (where r.status = 'failed') as failed_count,
    count(*) filter (where r.status = 'refunded') as refunded_count,
    coalesce(sum(r.unit_price * r.quantity) filter (
      where r.status in ('pending', 'processing', 'completed')
    ), 0) as revenue,
    coalesce(sum(r.shop_markup * r.quantity) filter (
      where r.status in ('pending', 'processing', 'completed')
    ), 0) as profit
  from public.results_checker_orders r
  where r.shop_id = p_shop_id
    and r.payment_status != 'pending_payment'
    and (p_status is null or r.status = p_status)
    and (p_search is null or r.customer_phone ilike '%' || p_search || '%')
    and (p_date_from is null or r.created_at >= p_date_from);
$$;

revoke all on function public.get_shop_voucher_stats from public, anon;
grant execute on function public.get_shop_voucher_stats to authenticated;
