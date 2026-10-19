-- Recompute sent_count/failed_count from actual recipient row state instead
-- of adding deltas. If a per-row status UPDATE throws partway through a
-- batch in dispatchAdminSmsBroadcastChunk, a delta-based update would
-- permanently undercount the parent (the already-updated rows' contribution
-- never gets folded in), and the affected recipient row — still stuck at
-- 'sending' — would get reclaimed and sent a SECOND time after the
-- 2-minute staleness window. Recomputing from ground truth each call removes
-- that whole class of drift. Signature kept identical to the caller in
-- lib/admin-sms-broadcast.ts; the delta params are now ignored.
create or replace function increment_admin_sms_broadcast_counts(
  p_broadcast_id uuid, p_sent_delta int, p_failed_delta int
) returns admin_sms_broadcasts language plpgsql as $$
declare
  remaining int;
  computed_sent int;
  computed_failed int;
  result admin_sms_broadcasts;
begin
  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status in ('queued','sending'))
    into computed_sent, computed_failed, remaining
    from admin_sms_broadcast_recipients
    where broadcast_id = p_broadcast_id;

  update admin_sms_broadcasts
    set sent_count = computed_sent,
        failed_count = computed_failed,
        status = case when status = 'queued' then 'sending' else status end
    where id = p_broadcast_id;

  if remaining = 0 then
    update admin_sms_broadcasts
      set status = 'done', completed_at = now()
      where id = p_broadcast_id and status != 'done';
  end if;

  select * into result from admin_sms_broadcasts where id = p_broadcast_id;
  return result;
end;
$$;
