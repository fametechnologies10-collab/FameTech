-- Fix (security review, HIGH-2): drainCallbackRetryQueue previously had no claim/lock
-- before retrying a row, so two overlapping cron runs could both call sendHubtelCallback
-- for the same session — doubling outbound Hubtel traffic under exactly the proxy-quota
-- pressure that caused the original incidents. Add a claim marker + atomic claim RPC
-- (same CAS-claim pattern already used for ussd_pending_orders.claimed_at in this repo).
alter table ussd_callback_retry_queue
    add column if not exists claimed_at timestamptz;

-- Atomically claims a row for retry: only succeeds if unresolved, unescalated, and not
-- already claimed within the last p_stale_after_seconds (recovers a crashed claim, mirrors
-- the 15-min recovery window used for ussd_pending_orders). Also fixes MEDIUM-3: attempts
-- is now incremented atomically here instead of never incrementing past 1 in the app layer.
create or replace function claim_ussd_callback_retry(p_id uuid, p_stale_after_seconds int default 300)
returns ussd_callback_retry_queue
language plpgsql
as $$
declare
    v_row ussd_callback_retry_queue;
begin
    update ussd_callback_retry_queue
    set attempts = attempts + 1,
        last_attempt_at = now(),
        claimed_at = now()
    where id = p_id
      and resolved = false
      and escalated = false
      and (claimed_at is null or claimed_at < now() - make_interval(secs => p_stale_after_seconds))
    returning * into v_row;
    return v_row;
end;
$$;
