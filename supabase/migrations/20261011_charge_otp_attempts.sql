-- Backend attempt cap for MoMo charge OTP submission (/api/payments/charge/submit-otp).
-- Mirrors momo_claim_attempts: a permanent, service-role-only table so the cap survives
-- cold starts and multi-instance scaling, keyed per charge reference (not per user), since
-- the attack is brute-forcing one charge's OTP, not volume across charges.
create table public.charge_otp_attempts (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create index charge_otp_attempts_reference_created_idx on public.charge_otp_attempts (reference, created_at);

alter table public.charge_otp_attempts enable row level security;

create policy charge_otp_attempts_admin_write on public.charge_otp_attempts
  for all
  using (
    exists (
      select 1 from users
      where users.id = (select auth.uid())
        and users.role = any (array['admin', 'sub-admin'])
    )
  );

revoke all on public.charge_otp_attempts from anon, authenticated;
grant select, insert on public.charge_otp_attempts to service_role;
