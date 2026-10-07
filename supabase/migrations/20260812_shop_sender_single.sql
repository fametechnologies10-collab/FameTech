-- supabase/migrations/20260812_shop_sender_single.sql
-- Collapses the "up to 5 concurrent, switchable default" sender-ID model down to
-- "exactly one active (approved) sender per shop, new approval auto-replaces the
-- old one" (see docs/superpowers/specs/2026-08-12-shop-feature-improvements-design.md
-- §1). For any shop that currently has more than one approved row, keep the row
-- that is `is_default = true` and hard-delete the rest – confirmed acceptable
-- (no audit-trail requirement) during design review.

-- 1. Hard-delete extra approved rows per shop, keeping the current default.
delete from shop_sender_ids ssi
using (
    select id, shop_id,
           row_number() over (partition by shop_id order by is_default desc, reviewed_at desc nulls last) as rn
    from shop_sender_ids
    where status = 'approved'
) ranked
where ssi.id = ranked.id
  and ranked.rn > 1;

-- 2. Backstop: at most one approved sender per shop going forward. Mirrors the
-- existing idx_shop_sender_ids_one_default pattern from 20260709_shop_sender_ids.sql.
create unique index if not exists idx_shop_sender_ids_one_approved
    on shop_sender_ids (shop_id)
    where status = 'approved';
