-- ============================================================================
-- Security: UNIQUE constraint on shop_orders.paystack_reference
--
-- Without this, two concurrent lambda invocations (e.g. Paystack webhook +
-- frontend verify hitting at the same millisecond) could both pass the
-- idempotency SELECT check and both INSERT a new order, resulting in
-- duplicate orders and double profit credits.
--
-- The UNIQUE constraint is the only reliable distributed guard — it forces
-- the DB to reject the second concurrent INSERT with a unique violation,
-- which the application catches and treats as a duplicate (safe no-op).
-- ============================================================================

ALTER TABLE public.shop_orders
    DROP CONSTRAINT IF EXISTS shop_orders_paystack_reference_key;

ALTER TABLE public.shop_orders
    ADD CONSTRAINT shop_orders_paystack_reference_key
    UNIQUE (paystack_reference);

-- Index is created automatically by the UNIQUE constraint, but add it
-- explicitly for query plans that filter/join on paystack_reference.
CREATE INDEX IF NOT EXISTS idx_shop_orders_paystack_reference
    ON public.shop_orders (paystack_reference);
