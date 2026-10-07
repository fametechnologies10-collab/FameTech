-- =============================================================================
-- HUBTEL USSD INTEGRATION — Full migration
-- =============================================================================

-- 1. Add USSD fields to data_packages
--    ussd_price  : price shown to non-account USSD users (NULL = not on USSD)
--    ussd_enabled: independent switch — controls USSD visibility separately from
--                  is_available (which controls the website)
ALTER TABLE public.data_packages
    ADD COLUMN IF NOT EXISTS ussd_price   NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS ussd_enabled BOOLEAN NOT NULL DEFAULT false;

-- 2. Add USSD price to results_checker_types
--    NULL → falls back to customer_price for USSD guests
ALTER TABLE public.results_checker_types
    ADD COLUMN IF NOT EXISTS ussd_price NUMERIC(12,2);

-- 3. Allow NULL user_id on afa_orders so USSD guest users (no account) can register
ALTER TABLE public.afa_orders
    ALTER COLUMN user_id DROP NOT NULL;

-- 4. Add source column to afa_orders (web / ussd)
ALTER TABLE public.afa_orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';

-- 5. Admin settings for USSD feature control
INSERT INTO public.admin_settings (key, value) VALUES
    ('ussd_enabled',                'true'),
    ('ussd_data_enabled',           'true'),
    ('ussd_rc_enabled',             'true'),
    ('ussd_afa_enabled',            'true'),
    ('afa_price_ussd',              '15.00'),
    ('ussd_max_rc_quantity',        '3'),
    ('ussd_session_resume_minutes', '30')
ON CONFLICT (key) DO NOTHING;

-- 6. USSD sessions — records every dial, supports resume after network timeout
CREATE TABLE IF NOT EXISTS public.ussd_sessions (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id        TEXT        NOT NULL UNIQUE,
    mobile            TEXT        NOT NULL,   -- 0XXXXXXXXX normalised
    operator          TEXT,
    platform          TEXT        NOT NULL DEFAULT 'USSD',
    steps             INTEGER     NOT NULL DEFAULT 0,
    service_used      TEXT,
    completed         BOOLEAN     NOT NULL DEFAULT false,
    interrupted_state JSONB,
    interrupted_at    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. USSD pending orders — bridge between AddToCart response and fulfillment callback
CREATE TABLE IF NOT EXISTS public.ussd_pending_orders (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      TEXT        NOT NULL UNIQUE,
    mobile          TEXT        NOT NULL,
    service_type    TEXT        NOT NULL
                    CHECK (service_type IN ('data', 'results_checker', 'afa')),
    order_payload   JSONB       NOT NULL,
    user_id         UUID        REFERENCES auth.users(id),   -- NULL for guests
    price           NUMERIC(12,2) NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'fulfilled', 'failed', 'expired')),
    hubtel_order_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    fulfilled_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '2 hours'
);

-- 8. USSD guest customers — tracks non-account users for analytics and re-engagement
CREATE TABLE IF NOT EXISTS public.ussd_customers (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile       TEXT          NOT NULL UNIQUE,
    operator     TEXT,
    first_seen   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    total_orders INTEGER       NOT NULL DEFAULT 0,
    total_spent  NUMERIC(12,2) NOT NULL DEFAULT 0,
    last_service TEXT
);

-- 9. Row-level security (service role only for all USSD tables)
ALTER TABLE public.ussd_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ussd_pending_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ussd_customers      ENABLE ROW LEVEL SECURITY;

-- 10. Indexes
CREATE INDEX IF NOT EXISTS idx_data_packages_ussd
    ON public.data_packages(network, sort_order)
    WHERE ussd_enabled = true AND is_available = true;

CREATE INDEX IF NOT EXISTS idx_rc_types_ussd
    ON public.results_checker_types(display_order)
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_ussd_pending_session
    ON public.ussd_pending_orders(session_id);

CREATE INDEX IF NOT EXISTS idx_ussd_pending_mobile
    ON public.ussd_pending_orders(mobile);

CREATE INDEX IF NOT EXISTS idx_ussd_pending_status
    ON public.ussd_pending_orders(status, created_at);

CREATE INDEX IF NOT EXISTS idx_ussd_sessions_mobile
    ON public.ussd_sessions(mobile, interrupted_at)
    WHERE interrupted_state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ussd_customers_mobile
    ON public.ussd_customers(mobile);
