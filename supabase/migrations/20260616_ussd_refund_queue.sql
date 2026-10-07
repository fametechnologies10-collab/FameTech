-- ============================================================
-- USSD Refund Queue (Option B: always-success to Hubtel, team refunds)
--
-- We always send ServiceStatus='success' to Hubtel so it never auto-refunds
-- (Hubtel's refund forces customers to install the Hubtel app to withdraw —
-- bad UX for USSD users). Instead, every failed-but-paid USSD order lands in
-- this queue for the team to refund: MoMo = manual (mark refunded), wallet =
-- one-click "Refund to wallet" (team-approved, idempotent). Nothing is auto.
--
-- Inserted by app/api/ussd/fulfill/route.ts (momo) and the wallet handlers.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ussd_refund_queue (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id              text NOT NULL,
    order_id                uuid,
    user_id                 uuid REFERENCES public.users(id),
    mobile                  text NOT NULL,
    service_type            text NOT NULL,                     -- data | results_checker | afa
    amount                  numeric NOT NULL,
    payment_method          text NOT NULL,                     -- momo | wallet
    hubtel_order_id         text,
    wallet_debit_reference  text,
    reason                  text,
    status                  text NOT NULL DEFAULT 'pending',   -- pending | refunded | dismissed
    refunded_by             uuid REFERENCES public.users(id),
    refunded_at             timestamptz,
    refund_reference        text,
    created_at              timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: at most one queue row per (session, payment method), so a Hubtel
-- retry / status-check replay does not pile up duplicate refund tasks.
CREATE UNIQUE INDEX IF NOT EXISTS ussd_refund_queue_session_method_uniq
    ON public.ussd_refund_queue (session_id, payment_method);

CREATE INDEX IF NOT EXISTS ussd_refund_queue_status_idx
    ON public.ussd_refund_queue (status, created_at DESC);

-- RLS on, no public policies: only the server (service_role) and admin tooling
-- (admin/service client) may read or mutate. No end-user access.
ALTER TABLE public.ussd_refund_queue ENABLE ROW LEVEL SECURITY;

-- P2-1: record the real network operator on pending orders (was always 'unknown'
-- for MoMo/status-check-recovered orders because it was never persisted).
ALTER TABLE public.ussd_pending_orders ADD COLUMN IF NOT EXISTS operator text;
