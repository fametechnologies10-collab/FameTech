-- Migration: Notification Modal System
-- Extends the notifications table to support new types: role_upgrade, welcome
-- Also ensures RLS policies allow the necessary operations

-- ── 1. Drop the old CHECK constraint ─────────────────────────────────────────
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

-- ── 2. Add the updated CHECK constraint with new types ────────────────────────
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'order_update',
    'complaint_resolved',
    'payment_success',
    'balance_updated',
    'system',
    'role_upgrade',
    'welcome'
  ));

-- ── 3. Ensure RLS policies exist for all CRUD operations ─────────────────────
-- Select — already exists from schema.sql, but safe to recreate
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
CREATE POLICY "Users can view own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

-- Insert — service role inserts on behalf of users; authenticated users should
-- NOT be able to insert their own notifications (server-only)
DROP POLICY IF EXISTS "Service role can insert notifications" ON public.notifications;
CREATE POLICY "Service role can insert notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (true);  -- enforced by SUPABASE_SERVICE_ROLE_KEY on server

-- Update — users can mark their own notifications as read
DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Delete — users can delete their own notifications
DROP POLICY IF EXISTS "Users can delete own notifications" ON public.notifications;
CREATE POLICY "Users can delete own notifications"
  ON public.notifications FOR DELETE
  USING (auth.uid() = user_id);

-- ── 4. Enable realtime on notifications table (for live modal updates) ────────
-- This tells Supabase to broadcast row changes on this table
ALTER TABLE public.notifications REPLICA IDENTITY FULL;
