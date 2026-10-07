-- ============================================================
-- 1. Backfill total_credited for all existing users
--    Uses wallet_transactions as the source of truth so the
--    figure is accurate regardless of when the RPC was added.
-- ============================================================
UPDATE wallets w
SET
    total_credited = COALESCE((
        SELECT SUM(t.amount)
        FROM wallet_transactions t
        WHERE t.user_id = w.user_id
          AND t.type    = 'credit'
          AND t.status  = 'completed'
    ), 0),
    updated_at = NOW();

-- ============================================================
-- 2. Replace get_user_transactions_with_balance with a
--    window-function version (O(n) instead of O(n²)).
-- ============================================================
DROP FUNCTION IF EXISTS public.get_user_transactions_with_balance(
    uuid, integer, integer, text, text,
    timestamp with time zone, timestamp with time zone
);

CREATE OR REPLACE FUNCTION public.get_user_transactions_with_balance(
    p_user_id      UUID,
    p_limit        INTEGER,
    p_offset       INTEGER,
    p_source_filter TEXT                    DEFAULT 'all',
    p_type_filter   TEXT                    DEFAULT 'all',
    p_start_date    TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_end_date      TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS TABLE (
    id          UUID,
    amount      DECIMAL,
    type        TEXT,
    description TEXT,
    reference   TEXT,
    source      TEXT,
    status      TEXT,
    created_at  TIMESTAMP WITH TIME ZONE,
    balance_before DECIMAL,
    balance_after  DECIMAL
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH
    all_txns AS (
        SELECT
            id,
            amount,
            type,
            description,
            reference,
            source,
            status,
            created_at,
            COALESCE(
                SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
                    OVER (
                        PARTITION BY user_id
                        ORDER BY created_at DESC, id DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                    ),
                0
            ) AS sum_of_later_txns
        FROM wallet_transactions
        WHERE user_id = p_user_id
    ),
    wallet_bal AS (
        SELECT COALESCE(balance, 0) AS balance
        FROM wallets
        WHERE user_id = p_user_id
    )
    SELECT
        t.id,
        t.amount::DECIMAL,
        t.type::TEXT,
        t.description::TEXT,
        t.reference::TEXT,
        t.source::TEXT,
        t.status::TEXT,
        t.created_at,
        (w.balance
            - t.sum_of_later_txns
            - CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END
        )::DECIMAL AS balance_before,
        (w.balance - t.sum_of_later_txns)::DECIMAL AS balance_after
    FROM all_txns t, wallet_bal w
    WHERE (p_source_filter = 'all' OR t.source = p_source_filter)
      AND (p_type_filter   = 'all' OR t.type   = p_type_filter)
      AND (p_start_date IS NULL OR t.created_at >= p_start_date)
      AND (p_end_date   IS NULL OR t.created_at <= p_end_date)
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT  p_limit
    OFFSET p_offset;
$$;

-- ============================================================
-- 3. Index to speed up the window-function sort and filter.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_time
    ON wallet_transactions (user_id, created_at DESC, id DESC);
