-- get_dashboard_summary(): single-round-trip read model for the dashboard home.
--
-- READ-ONLY. SECURITY INVOKER (RLS on orders/wallets still applies) and scoped
-- to auth.uid() only — it takes no user argument, so a caller can never read
-- another user's numbers. Shop customer orders (shop_order_id IS NOT NULL) are
-- excluded: this is the user's own purchase history.
--
-- Uses existing index idx_orders_user_created (user_id, created_at DESC)
-- WHERE shop_order_id IS NULL — no new index needed.
--
-- Day boundaries are Africa/Accra. Spend counts orders in pending, queued,
-- processing or completed (failed/refunded are not spend).
--
-- Returns:
-- { counts: {total,pending,queued,processing,completed,failed,refunded},
--   wallet_balance: number,
--   spend: { last7: number[7] (oldest first), total7, total30, top_network|null },
--   active_order: null | {id,network,size,phone_masked,status,created_at,updated_at} }

CREATE OR REPLACE FUNCTION public.get_dashboard_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH my_orders AS (
    SELECT id, status, price, network, size, phone_number, created_at, updated_at
    FROM public.orders
    WHERE user_id = auth.uid()
      AND shop_order_id IS NULL
),
counts AS (
    SELECT
        count(*)                                      AS total,
        count(*) FILTER (WHERE status = 'pending')    AS pending,
        count(*) FILTER (WHERE status = 'queued')     AS queued,
        count(*) FILTER (WHERE status = 'processing') AS processing,
        count(*) FILTER (WHERE status = 'completed')  AS completed,
        count(*) FILTER (WHERE status = 'failed')     AS failed,
        count(*) FILTER (WHERE status = 'refunded')   AS refunded
    FROM my_orders
),
spend_rows AS (
    SELECT network, price, (created_at AT TIME ZONE 'Africa/Accra')::date AS day
    FROM my_orders
    WHERE status IN ('pending', 'queued', 'processing', 'completed')
      AND created_at >= now() - interval '30 days'
),
days AS (
    SELECT d::date AS day
    FROM generate_series(
        (now() AT TIME ZONE 'Africa/Accra')::date - 6,
        (now() AT TIME ZONE 'Africa/Accra')::date,
        interval '1 day'
    ) AS d
),
per_day AS (
    SELECT days.day, coalesce(sum(s.price), 0) AS amount
    FROM days
    LEFT JOIN spend_rows s ON s.day = days.day
    GROUP BY days.day
),
top_net AS (
    SELECT network
    FROM spend_rows
    WHERE network IS NOT NULL
    GROUP BY network
    ORDER BY sum(price) DESC NULLS LAST, network
    LIMIT 1
),
active AS (
    SELECT id, network, size, phone_number, status, created_at, updated_at
    FROM my_orders
    WHERE status IN ('pending', 'queued', 'processing')
      AND created_at > now() - interval '24 hours'
    ORDER BY created_at DESC
    LIMIT 1
)
SELECT jsonb_build_object(
    'counts', (
        SELECT jsonb_build_object(
            'total', total, 'pending', pending, 'queued', queued,
            'processing', processing, 'completed', completed,
            'failed', failed, 'refunded', refunded
        ) FROM counts
    ),
    'wallet_balance', coalesce((SELECT balance FROM public.wallets WHERE user_id = auth.uid()), 0),
    'spend', jsonb_build_object(
        'last7', (SELECT jsonb_agg(amount ORDER BY day) FROM per_day),
        'total7', (SELECT coalesce(sum(amount), 0) FROM per_day),
        'total30', (SELECT coalesce(sum(price), 0) FROM spend_rows),
        'top_network', (SELECT network FROM top_net)
    ),
    'active_order', (
        SELECT jsonb_build_object(
            'id', id,
            'network', network,
            'size', size,
            'phone_masked', '••••' || right(phone_number, 4),
            'status', status,
            'created_at', created_at,
            'updated_at', updated_at
        ) FROM active
    )
);
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary() TO authenticated;

-- ---------------------------------------------------------------------------
-- Verification queries (comments only; run inside a transaction via execute_sql)
-- ---------------------------------------------------------------------------
-- Impersonate a user (replace <uuid>):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>"}';
--   select public.get_dashboard_summary();
--   rollback;
--
-- Counts equivalence (run as the same user, same transaction):
--   select count(*) total,
--          count(*) filter (where status='pending') pending,
--          count(*) filter (where status='queued') queued,
--          count(*) filter (where status='processing') processing,
--          count(*) filter (where status='completed') completed,
--          count(*) filter (where status='failed') failed,
--          count(*) filter (where status='refunded') refunded
--   from public.orders where user_id = '<uuid>' and shop_order_id is null;
--
-- Wallet equivalence:
--   select balance from public.wallets where user_id = '<uuid>';
--
-- 30-day spend equivalence:
--   select coalesce(sum(price),0) from public.orders
--   where user_id='<uuid>' and shop_order_id is null
--     and status in ('pending','queued','processing','completed')
--     and created_at >= now() - interval '30 days';
--
-- Second user returns different numbers: repeat with another <uuid>.
-- Zero-order / no-wallet user: expect zeros, last7 = seven 0s, top_network null, active_order null.
-- anon must fail (permission denied for function):
--   begin; set local role anon; select public.get_dashboard_summary(); rollback;
