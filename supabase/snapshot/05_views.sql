-- Fametech schema snapshot: views
-- Source: read-only introspection of the KiNG FLEXY GH production DB (schema only, NO data).
-- Apply files in numeric order to a FRESH Supabase project.

CREATE OR REPLACE VIEW public.shop_orders_effective AS  SELECT so.id,
    so.shop_id,
    so.package_id,
    so.guest_phone,
    so.network,
    so.package_size,
    so.selling_price,
    so.cost_price,
    so.profit,
    so.paystack_reference,
    so.status,
    so.fulfillment_reference,
    so.error_message,
    so.created_at,
    so.updated_at,
    so.admin_cost_at_time,
    so.owner_role_at_time,
    so.codecraft_reference_id,
    so.fulfilled_by,
    so.dakazina_reference,
    so.source,
    so.refunded_by,
    so.refunded_at,
    so.refund_reason,
    so.refund_method,
    so.parent_shop_id,
    so.parent_profit,
    so.payer_momo_number,
    so.payer_momo_name,
    so.payer_momo_network,
    so.payer_momo_resolved_at,
    COALESCE(retry.status, mirror.status, so.status) AS effective_status,
    COALESCE(retry.id, mirror.id) AS current_order_id,
    COALESCE(retry.refunded_at, mirror.refunded_at) AS current_refunded_at,
    COALESCE(retry.retry_count, mirror.retry_count) AS current_retry_count,
    COALESCE(retry.retry_from_status, mirror.retry_from_status) AS current_retry_from_status,
    COALESCE(retry.retry_of_order_id, mirror.retry_of_order_id) AS current_retry_of_order_id,
    COALESCE(retry.retried_by_role, mirror.retried_by_role) AS current_retried_by_role,
    COALESCE(retry.self_completed_at, mirror.self_completed_at) AS current_self_completed_at,
    COALESCE(retry.self_completed_by_role, mirror.self_completed_by_role) AS current_self_completed_by_role,
    mirror.id AS mirror_order_id,
    mirror.refunded_at AS mirror_refunded_at,
    mirror.retry_count,
    mirror.retry_from_status,
    mirror.retry_of_order_id,
    mirror.retried_by_role
   FROM ((shop_orders so
     LEFT JOIN orders mirror ON ((mirror.shop_order_id = so.id)))
     LEFT JOIN LATERAL ( SELECT o2.id,
            o2.status,
            o2.refunded_at,
            o2.retry_count,
            o2.retry_from_status,
            o2.retry_of_order_id,
            o2.retried_by_role,
            o2.self_completed_at,
            o2.self_completed_by_role
           FROM orders o2
          WHERE (o2.retry_of_order_id = mirror.id)
          ORDER BY o2.created_at DESC
         LIMIT 1) retry ON ((mirror.id IS NOT NULL)));
CREATE OR REPLACE VIEW public.v_shop_profit_credit_reconciliation AS  WITH credits AS (
         SELECT t.id,
            t.shop_wallet_id,
            t.shop_order_id,
            t.type,
            t.amount,
            t.fee,
            t.net_amount,
            t.description,
            t.momo_number,
            t.status,
            t.admin_note,
            t.created_at,
            t.updated_at,
            t.account_name,
            t.network,
            t.balance_snapshot,
            t.moolre_transaction_id,
            t.moolre_external_ref,
            t.moolre_status,
            t.payment_type,
            t.bank_id,
            t.processed_at,
            t.account_number,
            t.bank_name,
            t.branch,
            t.ussd_ref,
            t.payout_provider,
            t.paystack_recipient_code,
            t.paystack_transfer_code,
            t.paystack_transfer_reference,
            t.paystack_transfer_status,
            t.paystack_fee,
            t.processed_by,
            t.failure_reason,
            t.last_polled_at,
            t.poll_attempts,
            t.created_by,
            t.credit_source,
            t.name_verified,
            count(*) FILTER (WHERE (t.shop_order_id IS NOT NULL)) OVER (PARTITION BY t.shop_order_id) AS order_dupe_count
           FROM shop_wallet_transactions t
          WHERE (t.type = 'profit'::text)
        )
 SELECT c.id,
    c.shop_wallet_id,
    w.owner_id,
    sp.id AS shop_id,
    COALESCE(sp.shop_name, 'Unknown Shop'::text) AS shop_name,
    TRIM(BOTH FROM ((COALESCE(u.first_name, ''::text) || ' '::text) || COALESCE(u.last_name, ''::text))) AS owner_name,
    u.email AS owner_email,
    sp.owner_phone,
    c.amount,
    so.profit AS expected_amount,
    c.created_at,
    c.shop_order_id,
    COALESCE(so.paystack_reference, c.ussd_ref) AS order_ref,
    so.status AS order_status,
    so.network,
    so.package_size,
    so.guest_phone,
    COALESCE(c.credit_source,
        CASE
            WHEN (c.shop_order_id IS NOT NULL) THEN COALESCE(so.source, 'order'::text)
            WHEN (c.ussd_ref IS NOT NULL) THEN 'ussd'::text
            ELSE 'unknown'::text
        END) AS credit_source,
        CASE
            WHEN ((c.shop_order_id IS NULL) AND (c.ussd_ref IS NULL)) THEN 'red'::text
            WHEN ((c.shop_order_id IS NOT NULL) AND (so.id IS NULL)) THEN 'red'::text
            WHEN ((c.shop_order_id IS NOT NULL) AND (so.profit IS NOT NULL) AND (abs((c.amount - so.profit)) > 0.01)) THEN 'red'::text
            WHEN (c.order_dupe_count > 1) THEN 'red'::text
            WHEN ((c.shop_order_id IS NOT NULL) AND (COALESCE(so.source, 'website'::text) <> 'ussd'::text) AND (so.paystack_reference IS NULL)) THEN 'red'::text
            WHEN ((c.shop_order_id IS NOT NULL) AND (COALESCE(so.source, ''::text) = 'ussd'::text) AND (so.package_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
               FROM orders o
              WHERE ((o.shop_order_id = c.shop_order_id) AND (o.payment_status = ANY (ARRAY['paid'::text, 'refunded'::text]))))))) THEN 'red'::text
            WHEN ((c.shop_order_id IS NULL) AND (c.ussd_ref IS NOT NULL)) THEN 'amber'::text
            ELSE 'green'::text
        END AS risk_status,
    array_remove(ARRAY[
        CASE
            WHEN ((c.shop_order_id IS NULL) AND (c.ussd_ref IS NULL)) THEN 'orphan_no_order'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.shop_order_id IS NOT NULL) AND (so.id IS NULL)) THEN 'dangling_order_fk'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.shop_order_id IS NOT NULL) AND (so.profit IS NOT NULL) AND (abs((c.amount - so.profit)) > 0.01)) THEN 'amount_mismatch'::text
            ELSE NULL::text
        END,
        CASE
            WHEN (c.order_dupe_count > 1) THEN 'duplicate_for_order'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.shop_order_id IS NOT NULL) AND (COALESCE(so.source, 'website'::text) <> 'ussd'::text) AND (so.paystack_reference IS NULL)) THEN 'order_unpaid'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.shop_order_id IS NOT NULL) AND (COALESCE(so.source, ''::text) = 'ussd'::text) AND (so.package_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
               FROM orders o
              WHERE ((o.shop_order_id = c.shop_order_id) AND (o.payment_status = ANY (ARRAY['paid'::text, 'refunded'::text]))))))) THEN 'ussd_no_paid_order'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((c.shop_order_id IS NULL) AND (c.ussd_ref IS NOT NULL)) THEN 'source_uncross_checked'::text
            ELSE NULL::text
        END], NULL::text) AS risk_reasons
   FROM ((((credits c
     JOIN shop_wallets w ON ((w.id = c.shop_wallet_id)))
     LEFT JOIN shop_profiles sp ON ((sp.owner_id = w.owner_id)))
     LEFT JOIN users u ON ((u.id = w.owner_id)))
     LEFT JOIN shop_orders so ON ((so.id = c.shop_order_id)));
