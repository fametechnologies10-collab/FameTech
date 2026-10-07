-- Queue for USSD Hubtel fulfillment-callback acks that failed after sendHubtelCallback's
-- own 4-attempt retry gave up. Populated by lib/ussd/hubtel-callback.ts on final failure;
-- drained by the existing app/api/ussd/status-check cron (every 15 min), which retries the
-- ack for up to 24h before marking a row escalated (one final alert, no more auto-retries).
-- Mirrors ussd_refund_queue's shape/lockdown convention: service-role only, no RLS policies.
create table if not exists ussd_callback_retry_queue (
    id uuid primary key default gen_random_uuid(),
    session_id text not null,
    hubtel_order_id text not null,
    service_status text not null check (service_status in ('success', 'failed')),
    metadata jsonb,
    attempts int not null default 0,
    first_failed_at timestamptz not null default now(),
    last_attempt_at timestamptz,
    resolved boolean not null default false,
    resolved_at timestamptz,
    escalated boolean not null default false,
    created_at timestamptz not null default now()
);

-- One retry row per session — a session can only need one ack in flight at a time.
create unique index if not exists ussd_callback_retry_queue_session_id_key
    on ussd_callback_retry_queue (session_id);

-- Drain query shape: unresolved, not yet escalated, oldest first.
create index if not exists ussd_callback_retry_queue_pending_idx
    on ussd_callback_retry_queue (first_failed_at)
    where not resolved and not escalated;

alter table ussd_callback_retry_queue enable row level security;
-- No policies — service-role only, same as ussd_refund_queue.
