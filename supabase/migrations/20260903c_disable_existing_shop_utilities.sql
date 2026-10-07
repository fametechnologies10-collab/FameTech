-- 20260903c_disable_existing_shop_utilities.sql
-- Branch 2: disable ALL currently-enabled shop utility toggles in the same
-- deploy as the new agent/dealer enable-gate (app/api/shop/utility-settings/
-- route.ts). Prevents a window where non-agent shops keep selling under the
-- old unrestricted toggle. Communicated via the user-facing announcement —
-- existing agent/dealer shop owners re-enable it themselves, and will then
-- see the "you'll earn commission" notice on re-enabling.
UPDATE public.shop_profiles SET utilities_enabled = false, updated_at = now()
 WHERE utilities_enabled = true;

-- The column defaulted to TRUE, so every shop was enabled implicitly (nobody
-- opted in) — and, more importantly, every NEW shop would keep bypassing the
-- agent/dealer gate in app/api/shop/utility-settings/route.ts on insert.
-- Flip the default so utility sales are opt-in from here on, for everyone.
ALTER TABLE public.shop_profiles ALTER COLUMN utilities_enabled SET DEFAULT false;
