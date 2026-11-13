-- Admin SMS broadcast: detect messages the supplier (KingFlexyGH) accepted but
-- its carrier gateway rejected afterwards, and let the admin resend only those.
--
--   verified_at  — set once FameTech has checked the supplier's outcome for the
--                  broadcast. NULL = "delivery check pending".
--   mark_admin_sms_broadcast_rejected  — flips matching `sent` recipients to
--                  `failed` (never the reverse), recomputes counts from rows,
--                  stamps verified_at.
--   retry_failed_admin_sms_broadcast_recipients — requeues `failed` recipients
--                  and reopens the broadcast so the normal dispatch loop resends
--                  them. A second concurrent call finds nothing to requeue.
--
-- Both RPCs lock the broadcast row (FOR UPDATE) BEFORE reading recipients, and
-- are service-role only.

alter table admin_sms_broadcasts add column if not exists verified_at timestamptz;

create or replace function mark_admin_sms_broadcast_rejected(
  p_broadcast_id uuid, p_campaign_ids text[]
) returns admin_sms_broadcasts language plpgsql as $$
declare
  result admin_sms_broadcasts;
begin
  perform 1 from admin_sms_broadcasts where id = p_broadcast_id for update;

  if coalesce(array_length(p_campaign_ids, 1), 0) > 0 then
    update admin_sms_broadcast_recipients
      set status = 'failed',
          error = 'Rejected by SMS provider after acceptance',
          updated_at = now()
      where broadcast_id = p_broadcast_id
        and status = 'sent'
        and provider_message_id = any(p_campaign_ids);
  end if;

  update admin_sms_broadcasts b
    set sent_count   = (select count(*) from admin_sms_broadcast_recipients r where r.broadcast_id = b.id and r.status = 'sent'),
        failed_count = (select count(*) from admin_sms_broadcast_recipients r where r.broadcast_id = b.id and r.status = 'failed'),
        verified_at  = now()
    where b.id = p_broadcast_id;

  select * into result from admin_sms_broadcasts where id = p_broadcast_id;
  return result;
end;
$$;

-- Returns { "requeued": <int>, "broadcast": <admin_sms_broadcasts row as json> }
create or replace function retry_failed_admin_sms_broadcast_recipients(
  p_broadcast_id uuid
) returns jsonb language plpgsql as $$
declare
  n int;
  result admin_sms_broadcasts;
begin
  perform 1 from admin_sms_broadcasts where id = p_broadcast_id for update;

  update admin_sms_broadcast_recipients
    set status = 'queued', error = null, provider_message_id = null, updated_at = now()
    where broadcast_id = p_broadcast_id and status = 'failed';
  get diagnostics n = row_count;

  if n > 0 then
    update admin_sms_broadcasts b
      set status = 'sending',
          completed_at = null,
          verified_at = null,
          sent_count   = (select count(*) from admin_sms_broadcast_recipients r where r.broadcast_id = b.id and r.status = 'sent'),
          failed_count = 0
      where b.id = p_broadcast_id;
  end if;

  select * into result from admin_sms_broadcasts where id = p_broadcast_id;
  return jsonb_build_object('requeued', n, 'broadcast', to_jsonb(result));
end;
$$;

revoke execute on function mark_admin_sms_broadcast_rejected(uuid, text[]) from public, anon, authenticated;
revoke execute on function retry_failed_admin_sms_broadcast_recipients(uuid) from public, anon, authenticated;
grant execute on function mark_admin_sms_broadcast_rejected(uuid, text[]) to service_role;
grant execute on function retry_failed_admin_sms_broadcast_recipients(uuid) to service_role;
