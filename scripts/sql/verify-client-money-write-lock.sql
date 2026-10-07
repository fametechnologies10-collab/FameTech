-- Read-only. Verifies client-side writes to money tables are locked.
-- Covers the 5 core money tables (orders, airtime_orders, afa_orders, wallets,
-- wallet_transactions) plus 4 adjacent tables (user_payment_references,
-- ussd_pending_orders, shop_orders, shop_customers) added by the
-- 2026-09-25 amendment. Run via Supabase MCP execute_sql. Every row must
-- have pass = true. 67 rows total.
-- See docs/security-audits/2026-09-24-client-order-forgery.md
with t(tbl) as (values ('orders'),('airtime_orders'),('afa_orders'),('wallets'),('wallet_transactions')),
t2(tbl) as (values ('user_payment_references'),('ussd_pending_orders'),('shop_orders'),('shop_customers')),
t3(tbl) as (values ('user_payment_references')),
r(rl) as (values ('anon'),('authenticated')),
p(priv) as (values ('INSERT'),('UPDATE'),('DELETE')),
expected_trg(tbl, tgname, needs_update) as (values
  ('orders','trg_block_client_insert',false),
  ('airtime_orders','trg_block_client_insert',false),
  ('afa_orders','trg_block_client_insert',false),
  ('wallets','trg_block_client_write',true),
  ('wallet_transactions','trg_block_client_write',true),
  ('user_payment_references','trg_block_client_write',true))
-- 1. No client write privileges (30 checks)
select format('no %s %s on %s', r.rl, p.priv, t.tbl) as check_name,
       not has_table_privilege(r.rl, 'public.' || t.tbl, p.priv) as pass,
       null::text as detail
from t cross join r cross join p
union all
-- 1b. No client write privileges on adjacent tables (24 checks)
select format('no %s %s on %s', r.rl, p.priv, t2.tbl) as check_name,
       not has_table_privilege(r.rl, 'public.' || t2.tbl, p.priv) as pass,
       null::text as detail
from t2 cross join r cross join p
union all
-- 2. Only SELECT policies remain on each table (5 checks)
select format('only SELECT policies on %s', t.tbl),
       not exists (select 1 from pg_policies pp where pp.schemaname='public' and pp.tablename=t.tbl and pp.cmd <> 'SELECT'),
       (select string_agg(pp.policyname || ':' || pp.cmd, ', ') from pg_policies pp
          where pp.schemaname='public' and pp.tablename=t.tbl and pp.cmd <> 'SELECT')
from t
union all
-- 2b. Only SELECT policies remain on user_payment_references (1 check)
select format('only SELECT policies on %s', t3.tbl),
       not exists (select 1 from pg_policies pp where pp.schemaname='public' and pp.tablename=t3.tbl and pp.cmd <> 'SELECT'),
       (select string_agg(pp.policyname || ':' || pp.cmd, ', ') from pg_policies pp
          where pp.schemaname='public' and pp.tablename=t3.tbl and pp.cmd <> 'SELECT')
from t3
union all
-- 3. Guard trigger present, enabled, BEFORE INSERT (+UPDATE on wallet tables and
--    user_payment_references), calling the guard fn (6 checks)
select format('guard trigger on %s', e.tbl),
       exists (select 1 from pg_trigger tg join pg_proc fn on fn.oid = tg.tgfoid
               join pg_namespace n on n.oid = fn.pronamespace
               where tg.tgrelid = ('public.' || e.tbl)::regclass and tg.tgname = e.tgname
                 and fn.proname = 'block_client_money_writes'
                 and n.nspname = 'public'
                 and tg.tgenabled = 'O'
                 and (tg.tgtype & 1) = 1            -- ROW
                 and (tg.tgtype & 2) = 2            -- BEFORE
                 and (tg.tgtype & 4) = 4            -- INSERT
                 and (tg.tgtype & 8) = 0            -- NOT DELETE
                 and ((tg.tgtype & 16) = 16) = e.needs_update), -- UPDATE only where required
       null
from expected_trg e
union all
-- 4. Guard function exists and is NOT security definer (it must evaluate the caller's JWT)
select 'guard function exists (security invoker)',
       exists (select 1 from pg_proc fn join pg_namespace n on n.oid = fn.pronamespace
               where n.nspname = 'public' and fn.proname = 'block_client_money_writes' and not fn.prosecdef),
       null
order by pass, check_name;
