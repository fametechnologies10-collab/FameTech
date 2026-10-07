-- supabase/migrations/20260907c_sub_agent_order_earnings.sql
-- =============================================================================
-- The pending/credited/reversed earnings ledger (spec §5.1).
--
-- UNIQUE(order_table, order_reference) is the mechanism behind "earned once even if
-- completed a million times" — see the trigger in 20260907e for how a
-- redundant status write never re-enters the credit/reverse branches at all,
-- with this constraint as an independent second layer.
--
-- RLS: recruiter and sub both read their own rows. No client writes — every
-- insert/update goes through the application pricing code (insert, pending)
-- or the SECURITY DEFINER trigger (update, credited/reversed).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sub_agent_order_earnings (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_reference TEXT NOT NULL,
  order_table     TEXT NOT NULL CHECK (order_table IN ('orders', 'afa_orders', 'results_checker_orders', 'shop_orders')),
  recruiter_id    UUID NOT NULL REFERENCES public.users(id),
  sub_user_id     UUID NOT NULL REFERENCES public.users(id),
  amount          DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'credited', 'reversed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at     TIMESTAMPTZ,
  reversed_at     TIMESTAMPTZ,
  UNIQUE (order_table, order_reference)
);

CREATE INDEX IF NOT EXISTS idx_sub_agent_order_earnings_recruiter
  ON public.sub_agent_order_earnings(recruiter_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_agent_order_earnings_sub
  ON public.sub_agent_order_earnings(sub_user_id);

ALTER TABLE public.sub_agent_order_earnings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sub_agent_order_earnings_party_read" ON public.sub_agent_order_earnings;
CREATE POLICY "sub_agent_order_earnings_party_read" ON public.sub_agent_order_earnings
  FOR SELECT USING (recruiter_id = auth.uid() OR sub_user_id = auth.uid());
