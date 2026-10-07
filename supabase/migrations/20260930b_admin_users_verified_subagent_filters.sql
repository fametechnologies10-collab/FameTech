-- Admin users page: add a phone_verified filter dimension to admin_search_users,
-- and subagent/verified/unverified counts to admin_user_stats. Additive only —
-- p_phone_verified defaults to 'all' so existing callers are unaffected.

create or replace function public.admin_search_users(
  p_term text default null,
  p_role text default 'all',
  p_status text default 'all',
  p_limit integer default 50,
  p_offset integer default 0,
  p_phone_verified text default 'all'
)
returns table(
  id uuid, email text, first_name text, last_name text, phone_number text,
  role text, status text, agent_expires_at timestamptz, dealer_expires_at timestamptz,
  suspended_until timestamptz, suspension_reason text, phone_verified boolean,
  created_at timestamptz, updated_at timestamptz, wallet_balance numeric, total_count bigint
)
language sql stable security definer
set search_path to 'public'
as $function$
  with base as (
    select u.*, coalesce(w.balance, 0) as wbal
    from public.users u
    left join public.wallets w on w.user_id = u.id
    where
      ( p_role = 'all'
        or (p_role = 'staff' and u.role in ('admin','sub-admin'))
        or u.role = p_role )
      and ( p_status = 'all'
        or (p_status = 'active'    and u.status = 'active')
        or (p_status = 'suspended' and u.status = 'suspended')
        or (p_status = 'expired'   and (
              (u.role = 'agent'  and u.agent_expires_at  is not null and u.agent_expires_at  <= now())
           or (u.role = 'dealer' and u.dealer_expires_at is not null and u.dealer_expires_at <= now()) )) )
      and ( p_phone_verified = 'all'
        or (p_phone_verified = 'verified'   and u.phone_verified is true)
        or (p_phone_verified = 'unverified' and u.phone_verified is not true) )
      and ( p_term is null or btrim(p_term) = ''
        or ( length(regexp_replace(p_term,'\D','','g')) >= 3 and (
               regexp_replace(coalesce(u.phone_number,''),'\D','','g') ilike '%'||regexp_replace(p_term,'\D','','g')||'%'
               or right(regexp_replace(coalesce(u.phone_number,''),'\D','','g'),9)
                  = right(regexp_replace(p_term,'\D','','g'),9) ) )
        or not exists (
             select 1 from unnest(string_to_array(lower(btrim(p_term)),' ')) as tok
             where tok <> ''
               and lower(coalesce(u.first_name,'')) not like '%'||tok||'%'
               and lower(coalesce(u.last_name,''))  not like '%'||tok||'%'
               and lower(coalesce(u.email,''))      not like '%'||tok||'%' ) )
  )
  select id, email, first_name, last_name, phone_number, role, status,
         agent_expires_at, dealer_expires_at, suspended_until, suspension_reason,
         phone_verified, created_at, updated_at, wbal as wallet_balance,
         count(*) over() as total_count
  from base
  order by created_at desc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$function$;

create or replace function public.admin_user_stats()
returns jsonb
language sql stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'total',           count(*),
    'customers',       count(*) filter (where role = 'customer'),
    'agents',          count(*) filter (where role = 'agent'),
    'active_agents',   count(*) filter (where role = 'agent'  and (agent_expires_at  is null or agent_expires_at  > now())),
    'expired_agents',  count(*) filter (where role = 'agent'  and agent_expires_at  is not null and agent_expires_at  <= now()),
    'dealers',         count(*) filter (where role = 'dealer'),
    'active_dealers',  count(*) filter (where role = 'dealer' and (dealer_expires_at is null or dealer_expires_at > now())),
    'expired_dealers', count(*) filter (where role = 'dealer' and dealer_expires_at is not null and dealer_expires_at <= now()),
    'staff',           count(*) filter (where role in ('admin','sub-admin')),
    'subagents',       count(*) filter (where role = 'subagent'),
    'suspended',       count(*) filter (where status = 'suspended'),
    'expired',         count(*) filter (where
                          (role = 'agent'  and agent_expires_at  is not null and agent_expires_at  <= now())
                       or (role = 'dealer' and dealer_expires_at is not null and dealer_expires_at <= now())),
    'verified',        count(*) filter (where phone_verified is true),
    'unverified',      count(*) filter (where phone_verified is not true)
  ) from public.users
$function$;
