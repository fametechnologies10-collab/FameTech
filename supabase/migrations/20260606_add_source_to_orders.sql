-- Add source column to orders and results_checker_orders
-- so USSD-originated purchases are identifiable (mirrors afa_orders.source added in 20260604_ussd_tables.sql)

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';

ALTER TABLE public.results_checker_orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';
