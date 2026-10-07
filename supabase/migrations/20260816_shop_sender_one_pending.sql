-- Backstop for the single-pending-slot rule enforced in
-- app/api/shop/sms/sender-request/route.ts POST (check-then-insert was a TOCTOU
-- race with no DB constraint behind it — a double-submitted request could create
-- two 'under_review' rows for one shop). Mirrors the existing
-- idx_shop_sender_ids_one_approved pattern from 20260812_shop_sender_single.sql.
create unique index if not exists idx_shop_sender_ids_one_pending
    on shop_sender_ids (shop_id)
    where status = 'under_review';
