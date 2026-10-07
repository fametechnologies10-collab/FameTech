-- supabase/migrations/20260708_support_threads.sql
-- =============================================================================
-- Support & Complaints overhaul — chat-style support threads:
--   * support_threads / support_messages tables
--   * RLS: owner is READ-ONLY from the client; every write goes through
--     service-role API routes after validation. Sole exception: authenticated
--     may flip support_messages.read_by_user on messages in their own threads
--     (column-level grant), so "mark as read" needs no extra route.
--   * Per-user open-thread cap (3) enforced race-safely in a BEFORE INSERT
--     trigger via a per-user advisory xact lock (double-tap / parallel-tab safe).
--   * support_threads.last_message_at maintained by an AFTER INSERT trigger on
--     support_messages (atomic — API routes cannot forget to bump it).
--   * notifications type CHECK gains 'support_reply'.
--   * Realtime publication on both tables (postgres_changes is RLS-guarded).
-- service_role bypasses RLS, so no service policies are declared (advisor-clean).
-- =============================================================================

-- ── 1. Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_threads (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  order_id        uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  subject         text NOT NULL,
  category        text NOT NULL DEFAULT 'other'
                    CHECK (category IN ('order', 'payment', 'account', 'other')),
  phone_number    text NOT NULL,
  whatsapp_number text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at       timestamptz,
  closed_by       uuid,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id     uuid NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  sender_role   text NOT NULL CHECK (sender_role IN ('user', 'admin')),
  sender_id     uuid NOT NULL,
  body          text NOT NULL,
  read_by_user  boolean NOT NULL DEFAULT false,
  read_by_admin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_threads_user_id
  ON public.support_threads(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_status
  ON public.support_threads(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread
  ON public.support_messages(thread_id, created_at);
-- Covering index for the order_id FK (partial — most threads are general)
CREATE INDEX IF NOT EXISTS idx_support_threads_order_id
  ON public.support_threads(order_id)
  WHERE order_id IS NOT NULL;

-- ── 2. Open-thread cap (race-safe) ───────────────────────────────────────────
-- Advisory xact lock serializes thread creation per user, so two concurrent
-- inserts cannot both pass the count check. Lock releases at commit/rollback.
CREATE OR REPLACE FUNCTION public.enforce_support_thread_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('support_thread_cap:' || NEW.user_id::text));
  SELECT count(*) INTO open_count
  FROM public.support_threads
  WHERE user_id = NEW.user_id AND status = 'open';
  IF open_count >= 3 THEN
    RAISE EXCEPTION 'OPEN_THREAD_LIMIT'
      USING HINT = 'A user may have at most 3 open support threads.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_thread_cap ON public.support_threads;
CREATE TRIGGER trg_support_thread_cap
  BEFORE INSERT ON public.support_threads
  FOR EACH ROW EXECUTE FUNCTION public.enforce_support_thread_cap();

-- ── 3. last_message_at / updated_at maintenance ──────────────────────────────
CREATE OR REPLACE FUNCTION public.bump_support_thread_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.support_threads
  SET last_message_at = NEW.created_at,
      updated_at      = now()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_thread_bump ON public.support_messages;
CREATE TRIGGER trg_support_thread_bump
  AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_support_thread_last_message();

CREATE OR REPLACE FUNCTION public.update_support_threads_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_threads_updated_at ON public.support_threads;
CREATE TRIGGER trg_support_threads_updated_at
  BEFORE UPDATE ON public.support_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_support_threads_updated_at();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.support_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_threads_owner_select" ON public.support_threads;
CREATE POLICY "support_threads_owner_select"
  ON public.support_threads
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "support_messages_owner_select" ON public.support_messages;
CREATE POLICY "support_messages_owner_select"
  ON public.support_messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.support_threads t
    WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())
  ));

-- Owner may UPDATE messages in their own threads, but the column grant below
-- restricts the writable surface to read_by_user only.
DROP POLICY IF EXISTS "support_messages_owner_mark_read" ON public.support_messages;
CREATE POLICY "support_messages_owner_mark_read"
  ON public.support_messages
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.support_threads t
    WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.support_threads t
    WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())
  ));

-- ── 5. Grants (Supabase default-grants new tables to anon/authenticated) ─────
REVOKE ALL ON public.support_threads  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.support_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_threads  TO authenticated;
GRANT SELECT ON public.support_messages TO authenticated;
GRANT UPDATE (read_by_user) ON public.support_messages TO authenticated;

-- ── 6. Notification type for admin replies ───────────────────────────────────
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'order_update',
    'complaint_resolved',
    'payment_success',
    'balance_updated',
    'system',
    'role_upgrade',
    'welcome',
    'announcement',
    'support_reply'
  ));

-- ── 7. Realtime (postgres_changes respects RLS for authenticated) ────────────
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.support_threads;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
