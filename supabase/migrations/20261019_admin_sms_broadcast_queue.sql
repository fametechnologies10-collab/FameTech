create table admin_sms_broadcasts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references users(id),
  message text not null,
  audience_type text not null check (audience_type in ('users','group')),
  total_recipients int not null,
  sent_count int not null default 0,
  failed_count int not null default 0,
  status text not null default 'queued' check (status in ('queued','sending','done')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table admin_sms_broadcasts enable row level security;

create table admin_sms_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references admin_sms_broadcasts(id) on delete cascade,
  phone text not null,
  resolved_message text not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  provider_message_id text,
  error text,
  updated_at timestamptz not null default now()
);
alter table admin_sms_broadcast_recipients enable row level security;
create index on admin_sms_broadcast_recipients (broadcast_id, status);

-- Self-healing claim: reclaims any row stuck in 'sending' for >2 minutes
-- (a crashed dispatch call) back to 'queued' before claiming fresh rows,
-- so neither the cron nor a retried client call needs special-case logic.
create or replace function claim_admin_sms_broadcast_recipients(
  p_broadcast_id uuid, p_limit int default 10
) returns setof admin_sms_broadcast_recipients language plpgsql as $$
begin
  update admin_sms_broadcast_recipients
    set status = 'queued'
    where broadcast_id = p_broadcast_id
      and status = 'sending'
      and updated_at < now() - interval '2 minutes';

  return query
    update admin_sms_broadcast_recipients
      set status = 'sending', updated_at = now()
      where id in (
        select id from admin_sms_broadcast_recipients
        where broadcast_id = p_broadcast_id and status = 'queued'
        order by id
        for update skip locked
        limit p_limit
      )
      returning *;
end;
$$;

-- Atomically folds a chunk's results into the parent's running counts and
-- flips it to 'done' once nothing queued/sending remains for it. Safe to
-- call with zero deltas (e.g. a dispatch call that claimed nothing) purely
-- to re-check whether the broadcast can now be finalized.
create or replace function increment_admin_sms_broadcast_counts(
  p_broadcast_id uuid, p_sent_delta int, p_failed_delta int
) returns admin_sms_broadcasts language plpgsql as $$
declare
  remaining int;
  result admin_sms_broadcasts;
begin
  update admin_sms_broadcasts
    set sent_count = sent_count + p_sent_delta,
        failed_count = failed_count + p_failed_delta,
        status = case when status = 'queued' then 'sending' else status end
    where id = p_broadcast_id;

  select count(*) into remaining
    from admin_sms_broadcast_recipients
    where broadcast_id = p_broadcast_id and status in ('queued','sending');

  if remaining = 0 then
    update admin_sms_broadcasts
      set status = 'done', completed_at = now()
      where id = p_broadcast_id and status != 'done';
  end if;

  select * into result from admin_sms_broadcasts where id = p_broadcast_id;
  return result;
end;
$$;
