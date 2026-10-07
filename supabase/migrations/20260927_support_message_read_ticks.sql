-- supabase/migrations/20260927_support_message_read_ticks.sql
-- =============================================================================
-- WhatsApp-style in-app read ticks for support_messages.
--   * read_by_user / read_by_admin (booleans) each only ever meant something
--     for ONE direction per row (a message's counterpart is fully determined
--     by sender_role — a 'user' message is only ever relevant to admin, and
--     vice versa), so they collapse cleanly into direction-scoped timestamps:
--       delivered_to_user_at / delivered_to_admin_at — counterpart's client
--         fetched the message (set server-side, first GET wins)
--       read_by_user_at / read_by_admin_at — counterpart explicitly opened
--         the thread (existing "mark as read" actions, now timestamped)
--   * Same column-level grant boundary as before: authenticated may only
--     ever write the user-direction columns on their own threads.
-- =============================================================================

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS delivered_to_user_at  timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_to_admin_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_by_user_at        timestamptz,
  ADD COLUMN IF NOT EXISTS read_by_admin_at       timestamptz;

-- Backfill: exact original read time is not recoverable, so already-read
-- rows get `now()` (worst case, an old message briefly shows as unread
-- before the next real read/delivery event supersedes it). Read implies
-- delivered, so backfill delivered_at from created_at for those rows too.
UPDATE public.support_messages SET read_by_user_at  = now()       WHERE read_by_user  = true  AND read_by_user_at  IS NULL;
UPDATE public.support_messages SET read_by_admin_at = now()       WHERE read_by_admin = true  AND read_by_admin_at IS NULL;
UPDATE public.support_messages SET delivered_to_user_at  = created_at WHERE read_by_user  = true AND delivered_to_user_at  IS NULL;
UPDATE public.support_messages SET delivered_to_admin_at = created_at WHERE read_by_admin = true AND delivered_to_admin_at IS NULL;

ALTER TABLE public.support_messages
  DROP COLUMN read_by_user,
  DROP COLUMN read_by_admin;

-- Dropping the columns above also drops their grants automatically; restate
-- the writable surface explicitly on the replacement columns.
GRANT UPDATE (read_by_user_at, delivered_to_user_at) ON public.support_messages TO authenticated;
