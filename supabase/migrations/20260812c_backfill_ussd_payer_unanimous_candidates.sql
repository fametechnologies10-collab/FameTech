-- Second-pass backfill: recover USSD orders whose candidate sessions were
-- multiple but UNANIMOUS about the payer (duplicate / retried sessions for one
-- real payment). The first pass (20260812b) required exactly one candidate row
-- and so skipped these, even though the payer is not actually in doubt.
--
-- Rows whose candidates genuinely DISAGREE are still left NULL, so the UI shows
-- "unavailable" rather than a possibly-wrong refund number.
with candidate as (
  select s.id as shop_order_id,
         '0' || right(regexp_replace(p.mobile, '\D', '', 'g'), 9) as payer
  from shop_orders s
  join ussd_pending_orders p
    on p.shop_id = s.shop_id
   and right(regexp_replace(coalesce(p.order_payload->>'recipientPhone',
                                     p.order_payload->>'beneficiaryPhone'), '\D', '', 'g'), 9)
       = right(regexp_replace(s.guest_phone, '\D', '', 'g'), 9)
   and p.created_at between s.created_at - interval '30 minutes'
                        and s.created_at + interval '30 minutes'
  where s.source = 'ussd'
    and s.payer_momo_number is null
),
unanimous as (
  select shop_order_id, min(payer) as payer
  from candidate
  group by shop_order_id
  having count(distinct payer) = 1
)
update shop_orders s
set payer_momo_number = u.payer
from unanimous u
where u.shop_order_id = s.id;
