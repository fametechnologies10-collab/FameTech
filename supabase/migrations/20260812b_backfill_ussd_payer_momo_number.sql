-- Backfill the true USSD payer number onto historical shop_orders rows.
-- shop_orders.guest_phone is the BENEFICIARY; the payer is the dialing MSISDN
-- held on ussd_pending_orders.mobile. Matched on shop + beneficiary + a 30-minute
-- window around order creation.
--
-- Only unambiguous matches (exactly one candidate session) are written. Rows with
-- multiple candidates are deliberately LEFT NULL so the UI renders "unavailable"
-- rather than a confidently-wrong refund number.
with candidate as (
  select s.id as shop_order_id,
         '0' || right(regexp_replace(p.mobile, '\D', '', 'g'), 9) as payer,
         count(*) over (partition by s.id) as n_matches
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
)
update shop_orders s
set payer_momo_number = c.payer
from candidate c
where c.shop_order_id = s.id
  and c.n_matches = 1;
