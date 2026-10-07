-- Allow 'announcement' as a notification type so admin announcements can be
-- recorded in-app (previously the insert silently failed the CHECK constraint,
-- which made announcements invisible in the bell/modal).
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
    'announcement'
  ));
