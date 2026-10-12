-- ============================================================================
-- MIGRATION: storefront audit lockdown
-- Date:      2026-10-12
-- Audit:     docs/security-audits/2026-10-12-storefront-audit.md
--
-- Findings closed here (all confirmed against the live project):
--   1. shop_orders_effective / v_shop_profit_credit_reconciliation were
--      SECURITY DEFINER views with full anon+authenticated grants — anyone with
--      the public anon key could read every shop order (cost, profit, payer MoMo
--      number/name) and all shop payout/credit rows.
--   2. admin_search_users() is SECURITY DEFINER with NO admin check and was
--      executable by anon — returned every user's email, phone, name, role and
--      wallet balance.
--   3. SECURITY DEFINER trigger functions were executable via /rest/v1/rpc.
--   4. protect_shop_admin_columns() did not cover pricing_status / pricing_*,
--      sms_sender_*, ussd_active / ussd_code — a shop owner could self-approve
--      pricing, self-approve any SMS sender ID, and activate USSD for free by
--      PATCHing their own shop_profiles row.
--   5. shop_pricing was directly writable by the owner (RLS) — bypassing the
--      admin pricing review. Every legitimate writer is service-role / RPC.
--   6. anon/authenticated held DML on verified_phone_numbers (the OTP allowlist)
--      and other server-only tables; TRUNCATE/TRIGGER/REFERENCES everywhere.
--   7. guest_push_subscriptions.guest_phone was client-asserted (and no legitimate
--      client ever sends it) — scrubbed; the route no longer accepts it.
-- ============================================================================

-- ── 1. Views: enforce the caller's RLS + remove public grants ────────────────
DO $$
BEGIN
    IF to_regclass('public.shop_orders_effective') IS NOT NULL THEN
        ALTER VIEW public.shop_orders_effective SET (security_invoker = true);
        REVOKE ALL ON public.shop_orders_effective FROM PUBLIC, anon, authenticated;
        GRANT SELECT ON public.shop_orders_effective TO service_role;
    END IF;
    IF to_regclass('public.v_shop_profit_credit_reconciliation') IS NOT NULL THEN
        ALTER VIEW public.v_shop_profit_credit_reconciliation SET (security_invoker = true);
        REVOKE ALL ON public.v_shop_profit_credit_reconciliation FROM PUBLIC, anon, authenticated;
        GRANT SELECT ON public.v_shop_profit_credit_reconciliation TO service_role;
    END IF;
END $$;

-- ── 2. admin_search_users: service-role only (sole caller is /api/admin/users) ─
REVOKE EXECUTE ON FUNCTION public.admin_search_users(text, text, text, integer, integer)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_search_users(text, text, text, integer, integer, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_users(text, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_search_users(text, text, text, integer, integer, text) TO service_role;

-- ── 3. Trigger functions are never meant to be called as RPCs ────────────────
-- (EXECUTE is only checked at CREATE TRIGGER time, so existing triggers keep firing.)
REVOKE EXECUTE ON FUNCTION public.enforce_subagent_contact_lock() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_sub_agent_earning_by_paystack_reference() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_sub_agent_earning_by_reference_code() FROM PUBLIC, anon, authenticated;

-- ── 4. shop_profiles: protect the remaining admin/paid-feature columns ───────
-- Existing guard preserved verbatim; the new block additionally exempts admins
-- (is_admin()) so any admin RLS-client flow keeps working. Every server write
-- path uses the service role, for which auth.role() <> 'authenticated'.
CREATE OR REPLACE FUNCTION public.protect_shop_admin_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() = 'authenticated' THEN
    NEW.paystack_fee_percent      := OLD.paystack_fee_percent;
    NEW.withdrawal_fee_percent    := OLD.withdrawal_fee_percent;
    NEW.withdrawal_fee_flat       := OLD.withdrawal_fee_flat;
    NEW.min_withdrawal_amount     := OLD.min_withdrawal_amount;
    NEW.approval_status           := OLD.approval_status;
    NEW.fulfillment_mode          := OLD.fulfillment_mode;
    NEW.is_active                 := OLD.is_active;
    NEW.approved_by               := OLD.approved_by;
    NEW.approved_at               := OLD.approved_at;
    NEW.utilities_enabled         := OLD.utilities_enabled;
    NEW.airtime_fee_mtn                   := OLD.airtime_fee_mtn;
    NEW.airtime_fee_telecel               := OLD.airtime_fee_telecel;
    NEW.airtime_fee_at                    := OLD.airtime_fee_at;
    NEW.mashup_fee_percent                := OLD.mashup_fee_percent;
    NEW.results_checker_markup_customer   := OLD.results_checker_markup_customer;
    NEW.results_checker_markup_agent      := OLD.results_checker_markup_agent;
    NEW.results_checker_markup_dealer     := OLD.results_checker_markup_dealer;
    NEW.afa_fee_percent                   := OLD.afa_fee_percent;
    NEW.afa_selling_price                 := OLD.afa_selling_price;

    IF NOT COALESCE(public.is_admin(), false) THEN
      -- Pricing review workflow (only /api/shop/pricing + /api/admin/shops may move these)
      NEW.pricing_status            := OLD.pricing_status;
      NEW.pricing_approved_at       := OLD.pricing_approved_at;
      NEW.pricing_approved_by       := OLD.pricing_approved_by;
      NEW.pricing_note              := OLD.pricing_note;
      NEW.pricing_submitted_at      := OLD.pricing_submitted_at;
      NEW.approval_note             := OLD.approval_note;
      -- SMS sender-ID review (only /api/shop/sms/sender-request + /api/admin/shop-sms)
      NEW.sms_sender_id             := OLD.sms_sender_id;
      NEW.sms_sender_status         := OLD.sms_sender_status;
      NEW.sms_sender_requested_at   := OLD.sms_sender_requested_at;
      NEW.sms_sender_reviewed_at    := OLD.sms_sender_reviewed_at;
      -- Paid USSD activation (only the activation RPC, service role). ussd_code is
      -- deliberately NOT guarded here: /api/shop/ussd-code writes it through the
      -- owner's RLS client (free code changes), and it is inert without ussd_active.
      NEW.ussd_active               := OLD.ussd_active;
      NEW.ussd_activated_at         := OLD.ussd_activated_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 5. shop_pricing: server-only writes (admin review cannot be bypassed) ────
REVOKE INSERT, UPDATE, DELETE ON public.shop_pricing FROM anon, authenticated;

-- ── 6. Server-only tables: no client grants at all ───────────────────────────
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'verified_phone_numbers', 'phone_otp_verifications',
        'guest_push_subscriptions', 'shop_afa_pending_orders', 'security_events'
    ] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
            EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
        END IF;
    END LOOP;
END $$;

-- PostgREST never issues TRUNCATE / TRIGGER / REFERENCES; nothing should hold them.
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.%I FROM anon, authenticated', r.tablename);
    END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;

-- ── 7. Guest push: phone was client-asserted → drop it ───────────────────────
UPDATE public.guest_push_subscriptions SET guest_phone = NULL WHERE guest_phone IS NOT NULL;

-- ── 8. Announcement length (the API caps it at 5000; direct PostgREST did not) ─
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_announcements_message_len') THEN
        ALTER TABLE public.shop_announcements
            ADD CONSTRAINT shop_announcements_message_len CHECK (char_length(message) <= 5000) NOT VALID;
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
