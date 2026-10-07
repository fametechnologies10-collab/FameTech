-- Phone OTP verification gate: lock email + verified-phone columns, add
-- recovery-attempt lockout tracking. See docs/superpowers/specs/2026-09-30-
-- phone-otp-verification-gate-design.md for full rationale.

-- 1. One-time backfill: 2 accounts have public.users.email out of sync with
-- the real auth.users.email (pre-existing drift). Must run before the email
-- lock below, or these rows could never be corrected again.
update public.users u
set email = au.email
from auth.users au
where au.id = u.id and u.email is distinct from au.email;

-- 2. Extend the existing privilege-change guard (do NOT add a second trigger —
-- one function, one place to read the full set of protected columns).
create or replace function public.guard_users_privilege_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
begin
  if auth.uid() is not null then
    if new.role is distinct from old.role then
      raise exception 'SECURITY: changing account role is not permitted for this session';
    end if;
    if new.agent_expires_at is distinct from old.agent_expires_at
       or new.dealer_expires_at is distinct from old.dealer_expires_at then
      raise exception 'SECURITY: changing reseller expiry is not permitted for this session';
    end if;
    if new.status is distinct from old.status then
      raise exception 'SECURITY: changing account status is not permitted for this session';
    end if;
    if new.pin_hash is distinct from old.pin_hash
       or new.pin_salt is distinct from old.pin_salt
       or new.pin_attempts is distinct from old.pin_attempts
       or new.pin_locked_until is distinct from old.pin_locked_until then
      raise exception 'SECURITY: app-lock PIN can only be changed through the PIN service';
    end if;
    if new.email is distinct from old.email then
      raise exception 'SECURITY: email can only be changed through account support';
    end if;
    if (new.phone_number is distinct from old.phone_number
        or new.phone_verified is distinct from old.phone_verified)
       and old.phone_verified is true then
      raise exception 'SECURITY: a verified phone number can only be changed through the recovery flow';
    end if;
  end if;
  return new;
end;
$function$;

-- 3. Recovery-attempt lockout table. Server-write-only (same convention as
-- money tables) — no client policies, no client grants.
create table public.phone_recovery_attempts (
  user_id           uuid primary key references public.users(id) on delete cascade,
  attempt_count     integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz,
  hard_locked       boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table public.phone_recovery_attempts enable row level security;
revoke all on public.phone_recovery_attempts from anon, authenticated;

-- 4. Atomic lockout state machine. FOR UPDATE locks the row before any
-- read/branch — the same lesson from credit_shop_profit (check-before-lock
-- let concurrent calls both pass). SECURITY DEFINER + execute revoked from
-- anon/authenticated: only the server (service_role) may call this, and the
-- server is responsible for passing the AUTHENTICATED caller's own user_id.
create or replace function public.record_phone_recovery_attempt(
  p_user_id uuid,
  p_correct boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.phone_recovery_attempts;
  v_now timestamptz := now();
  v_count integer;
  v_locked_until timestamptz;
begin
  insert into public.phone_recovery_attempts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_row
  from public.phone_recovery_attempts
  where user_id = p_user_id
  for update;

  if v_now - v_row.window_started_at > interval '1 hour' then
    v_row.attempt_count := 0;
    v_row.window_started_at := v_now;
    v_row.locked_until := null;
    v_row.hard_locked := false;
  end if;

  if v_row.hard_locked then
    update public.phone_recovery_attempts
    set window_started_at = v_row.window_started_at, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'hard_locked');
  end if;

  if v_row.locked_until is not null and v_now < v_row.locked_until then
    update public.phone_recovery_attempts
    set window_started_at = v_row.window_started_at, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'locked', 'retry_at', v_row.locked_until);
  end if;

  if p_correct then
    update public.phone_recovery_attempts
    set attempt_count = 0, window_started_at = v_now, locked_until = null,
        hard_locked = false, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'ok');
  end if;

  v_count := v_row.attempt_count + 1;

  if v_count = 3 then
    v_locked_until := v_now + interval '1 minute';
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at,
        locked_until = v_locked_until, hard_locked = false, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'locked', 'retry_at', v_locked_until);
  elsif v_count = 6 then
    v_locked_until := v_now + interval '2 minutes';
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at,
        locked_until = v_locked_until, hard_locked = false, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'locked', 'retry_at', v_locked_until);
  elsif v_count >= 9 then
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at,
        locked_until = null, hard_locked = true, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'hard_locked');
  else
    update public.phone_recovery_attempts
    set attempt_count = v_count, window_started_at = v_row.window_started_at, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('outcome', 'wrong', 'attempt_count', v_count);
  end if;
end;
$$;

revoke all on function public.record_phone_recovery_attempt(uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_phone_recovery_attempt(uuid, boolean) to service_role;
