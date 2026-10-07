-- A failed or refunded shop order no longer flags its profit credit as
-- 'red'/suspicious in v_shop_profit_credit_reconciliation. Policy (clarified
-- 2026-08-10): shop-owner profit is never reversed on a failed order or a
-- refund (owner_wallet or Paystack) — only cost is ever returned — so a
-- failed/refunded backing order is expected, normal state for a KEPT profit
-- credit, not a red flag.
--
-- Also fixes a related false-positive this uncovered: 'ussd_no_paid_order'
-- required the linked `orders` mirror row to have payment_status = 'paid'
-- exactly. A refund flips that mirror row to payment_status = 'refunded'
-- (see mark_shop_order_refunded / settle_shop_refund_to_owner), so every
-- refunded USSD order was ALSO double-flagged under this reason — the same
-- order, two labels, neither of which is fraud. The check now accepts
-- 'refunded' as evidence the order WAS confirmed paid before the refund;
-- it still fires (correctly) when no paid/refunded mirror row exists at all.
CREATE OR REPLACE VIEW public.v_shop_profit_credit_reconciliation AS
WITH credits AS (
    SELECT
        t.id, t.shop_wallet_id, t.shop_order_id, t.type, t.amount, t.fee, t.net_amount,
        t.description, t.momo_number, t.status, t.admin_note, t.created_at, t.updated_at,
        t.account_name, t.network, t.balance_snapshot, t.moolre_transaction_id,
        t.moolre_external_ref, t.moolre_status, t.payment_type, t.bank_id, t.processed_at,
        t.account_number, t.bank_name, t.branch, t.ussd_ref, t.payout_provider,
        t.paystack_recipient_code, t.paystack_transfer_code, t.paystack_transfer_reference,
        t.paystack_transfer_status, t.paystack_fee, t.processed_by, t.failure_reason,
        t.last_polled_at, t.poll_attempts, t.created_by, t.credit_source, t.name_verified,
        count(*) FILTER (WHERE t.shop_order_id IS NOT NULL) OVER (PARTITION BY t.shop_order_id) AS order_dupe_count
    FROM shop_wallet_transactions t
    WHERE t.type = 'profit'
)
SELECT
    c.id,
    c.shop_wallet_id,
    w.owner_id,
    sp.id AS shop_id,
    COALESCE(sp.shop_name, 'Unknown Shop') AS shop_name,
    TRIM(BOTH FROM (COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))) AS owner_name,
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
    COALESCE(
        c.credit_source,
        CASE
            WHEN c.shop_order_id IS NOT NULL THEN COALESCE(so.source, 'order')
            WHEN c.ussd_ref IS NOT NULL THEN 'ussd'
            ELSE 'unknown'
        END
    ) AS credit_source,
    CASE
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'red'
        WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'red'
        WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL AND abs(c.amount - so.profit) > 0.01 THEN 'red'
        WHEN c.order_dupe_count > 1 THEN 'red'
        WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source, 'website') <> 'ussd' AND so.paystack_reference IS NULL THEN 'red'
        WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source, '') = 'ussd' AND so.package_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.shop_order_id = c.shop_order_id AND o.payment_status IN ('paid', 'refunded')) THEN 'red'
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'amber'
        ELSE 'green'
    END AS risk_status,
    array_remove(ARRAY[
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'orphan_no_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'dangling_order_fk' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL AND abs(c.amount - so.profit) > 0.01 THEN 'amount_mismatch' END,
        CASE WHEN c.order_dupe_count > 1 THEN 'duplicate_for_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source, 'website') <> 'ussd' AND so.paystack_reference IS NULL THEN 'order_unpaid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source, '') = 'ussd' AND so.package_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.shop_order_id = c.shop_order_id AND o.payment_status IN ('paid', 'refunded')) THEN 'ussd_no_paid_order' END,
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'source_uncross_checked' END
    ], NULL) AS risk_reasons
FROM credits c
JOIN shop_wallets w ON w.id = c.shop_wallet_id
LEFT JOIN shop_profiles sp ON sp.owner_id = w.owner_id
LEFT JOIN users u ON u.id = w.owner_id
LEFT JOIN shop_orders so ON so.id = c.shop_order_id;
