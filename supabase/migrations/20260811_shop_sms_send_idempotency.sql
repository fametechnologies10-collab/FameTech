-- Closes the "no idempotency key" gap on app/api/shop/sms/send/route.ts
-- (see docs/security-audits/2026-08-11-race-condition-fraud-audit.md, finding #5).
--
-- A double-submitted send request (double-click, client-side retry after a
-- timeout, browser back-button resubmit) currently debits shop_sms_wallets
-- twice and physically dispatches the SMS batch twice — real duplicate
-- messages to customers. This table lets the route atomically CLAIM a
-- (shop_id, idempotency_key) pair via INSERT before it ever debits credits
-- or calls the SMS provider; a concurrent/duplicate request hits the UNIQUE
-- constraint and is rejected as a duplicate, mirroring the reserve-the-key
-- pattern already used by create_sms_campaign's sms_credit_ledger.

create table if not exists public.shop_sms_send_claims (
    id              uuid primary key default gen_random_uuid(),
    shop_id         uuid not null references public.shop_profiles(id) on delete cascade,
    idempotency_key text not null,
    created_at      timestamptz not null default now(),
    unique (shop_id, idempotency_key)
);

comment on table public.shop_sms_send_claims is
    'Atomic dedup claim for shop bulk-SMS sends. One row per (shop_id, idempotency_key) — a second insert for the same pair hits the UNIQUE constraint and the route treats it as a duplicate request, never re-debiting or re-sending.';

-- RLS enabled, no policies: deny-all for anon/authenticated (this table is
-- never read/written by RLS-scoped clients — only the service-role client
-- in app/api/shop/sms/send/route.ts touches it). Mirrors shop_sms_refund_failures.
alter table public.shop_sms_send_claims enable row level security;
