-- Follow-up from security review: the route-level insert-then-count had a TOCTOU gap
-- (two concurrent requests could each pass their own SELECT COUNT before seeing the
-- other's INSERT, letting 1-2 extra guesses through). Serialize per reference with an
-- advisory lock inside a single atomic function, matching the project's lock-before-check
-- convention for wallet RPCs.
create or replace function public.record_and_check_otp_attempt(
  p_reference text,
  p_user_id uuid,
  p_max_attempts int default 5,
  p_window_seconds int default 600
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- Serialize all callers for this reference for the duration of this transaction.
  perform pg_advisory_xact_lock(hashtext(p_reference));

  insert into charge_otp_attempts (reference, user_id) values (p_reference, p_user_id);

  select count(*) into v_count
  from charge_otp_attempts
  where reference = p_reference
    and created_at >= now() - (p_window_seconds || ' seconds')::interval;

  return v_count <= p_max_attempts;
end;
$$;

revoke all on function public.record_and_check_otp_attempt(text, uuid, int, int) from public, anon, authenticated;
grant execute on function public.record_and_check_otp_attempt(text, uuid, int, int) to service_role;

-- Dead code per review: REVOKE ALL FROM anon/authenticated already locks out every
-- authenticated PostgREST session (table-level GRANT is checked before RLS), so this
-- admin policy can never fire -- only service_role (RLS-bypassing) ever touches the table.
drop policy if exists charge_otp_attempts_admin_write on public.charge_otp_attempts;
