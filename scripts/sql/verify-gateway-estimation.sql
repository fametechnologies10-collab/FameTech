-- Read-only verification for supabase/migrations/20261114_gateway_estimation.sql.
-- Run in the Supabase SQL editor after applying. Expected values in the trailing comments. No writes.
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'gateway_status_overrides')            as overrides_table,                    -- 1
  (select count(*) from public.gateway_status_overrides)                                   as seed_rows,                          -- 5
  (select c.relrowsecurity from pg_class c
     where c.oid = 'public.gateway_status_overrides'::regclass)                            as rls_enabled,                        -- true
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'gateway_status_overrides')               as policies_on_overrides,              -- 0
  (select count(*) from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'gateway_status_overrides'
       and grantee in ('anon', 'authenticated', 'PUBLIC'))                                 as anon_or_auth_privileges_on_overrides, -- 0
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('idx_orders_gw_completed', 'idx_orders_gw_open',
                         'idx_sbo_gw_completed', 'idx_sbo_gw_open'))                       as indexes,                            -- 4
  (select p.proacl::text from pg_proc p
     where p.oid = 'public.get_gateway_signals()'::regprocedure)                           as rpc_acl,                            -- only postgres + service_role (no anon/authenticated/public)
  (select p.prosecdef from pg_proc p
     where p.oid = 'public.get_gateway_signals()'::regprocedure)                           as rpc_security_definer,               -- false
  (select count(*) from public.get_gateway_signals())                                      as rpc_rows;                           -- 5
