-- supabase/migrations/20260812_add_shop_orders_momo_payer_cache.sql
alter table shop_orders
  add column if not exists payer_momo_number text,
  add column if not exists payer_momo_name text,
  add column if not exists payer_momo_network text,
  add column if not exists payer_momo_resolved_at timestamptz;
