-- supabase/migrations/20260823_shop_sms_delivery_tracking.sql

ALTER TABLE shop_sms_logs
  ADD COLUMN IF NOT EXISTS delivered_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS undelivered_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_count     integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS shop_sms_delivery_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id               uuid NOT NULL REFERENCES shop_sms_logs(id) ON DELETE CASCADE,
  phone                text NOT NULL,
  provider_message_id  text,
  status               text NOT NULL DEFAULT 'sent'
                          CHECK (status IN ('sent','delivered','undelivered','rejected','expired')),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_sms_delivery_receipts_provider_message_id
  ON shop_sms_delivery_receipts (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shop_sms_delivery_receipts_log_id
  ON shop_sms_delivery_receipts (log_id);

-- Scope guard for the reconcile cron's stuck-row scan (mirrors sms_messages'
-- (provider, status, status_updated_at) query shape).
CREATE INDEX IF NOT EXISTS idx_shop_sms_delivery_receipts_stuck_scan
  ON shop_sms_delivery_receipts (status, updated_at)
  WHERE status = 'sent';

-- Mirrors apply_sms_delivery_report's transition-guard discipline exactly:
-- only a 'sent' row may move, terminal states are immutable, so a replayed
-- webhook or a redundant cron pass is a no-op. Additionally, atomically,
-- rolls the outcome up into the parent shop_sms_logs row's counters.
CREATE OR REPLACE FUNCTION apply_shop_sms_delivery_report(
  p_provider_message_id text,
  p_status text,
  p_detail text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt shop_sms_delivery_receipts;
BEGIN
  UPDATE shop_sms_delivery_receipts
  SET status = p_status, updated_at = now()
  WHERE provider_message_id = p_provider_message_id
    AND status = 'sent'
  RETURNING * INTO v_receipt;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false);
  END IF;

  UPDATE shop_sms_logs
  SET pending_count = GREATEST(pending_count - 1, 0),
      delivered_count = delivered_count
        + CASE WHEN p_status = 'delivered' THEN 1 ELSE 0 END,
      undelivered_count = undelivered_count
        + CASE WHEN p_status IN ('undelivered','rejected','expired') THEN 1 ELSE 0 END
  WHERE id = v_receipt.log_id;

  RETURN jsonb_build_object('updated', true);
END;
$$;

-- Restrict execute to service_role only, matching every other SECURITY DEFINER
-- RPC in this codebase (e.g. apply_sms_delivery_report, claim_order_retry).
-- Without this, Postgres's unrestricted default grants EXECUTE to PUBLIC,
-- letting any anon-key caller mutate delivery counters via PostgREST.
REVOKE EXECUTE ON FUNCTION public.apply_shop_sms_delivery_report(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_shop_sms_delivery_report(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
