-- Allow an admin to permanently delete any user.
-- 36 FKs to public.users / auth.users had ON DELETE NO ACTION, so deleting a user
-- failed whenever they had a row in any of these tables (e.g. admin_sms_broadcasts_created_by_fkey).
--   * "actor" columns (approved_by, processed_by, created_by, ...): keep the record, null the actor (SET NULL)
--   * rows the user owns (their orders, purchases, pricing, refunds): CASCADE, matching orders/wallets

-- Audit/actor columns that were NOT NULL must become nullable to allow SET NULL.
ALTER TABLE public.atishare_console_manual_sends ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE public.order_retry_attempts          ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.admin_sms_broadcasts          ALTER COLUMN created_by DROP NOT NULL;

DO $$
DECLARE
  r record;
  cascade_cols text[] := ARRAY[
    'sms_purchases.user_id','shop_sms_activations.owner_id','shop_sms_purchases.owner_id',
    'sub_agent_default_pricing.recruiter_id','sub_agent_order_earnings.recruiter_id',
    'sub_agent_order_earnings.sub_user_id','sub_agent_pricing.recruiter_id','sub_agent_pricing.sub_user_id',
    'results_checker_complaints.user_id','results_checker_orders.user_id','ussd_pending_orders.user_id',
    'ussd_refund_queue.user_id','utility_orders.user_id','utility_refund_queue.user_id'
  ];
  action text;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl, c.confrelid::regclass AS ref, a.attname AS col,
           c.conrelid::regclass::text AS tbl_txt
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f'
      AND c.confrelid IN ('public.users'::regclass, 'auth.users'::regclass)
      AND c.confdeltype IN ('a','r')
      AND array_length(c.conkey,1) = 1
  LOOP
    action := CASE WHEN (regexp_replace(r.tbl_txt,'^public\.','') || '.' || r.col) = ANY (cascade_cols)
                   THEN 'CASCADE' ELSE 'SET NULL' END;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(id) ON DELETE %s',
                   r.tbl, r.conname, r.col, r.ref, action);
  END LOOP;
END $$;
