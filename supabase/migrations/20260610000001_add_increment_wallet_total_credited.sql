-- Atomic increment for wallet total_credited field.
-- Called after a successful payment credit to keep the display counter accurate.
CREATE OR REPLACE FUNCTION increment_wallet_total_credited(p_user_id UUID, p_amount NUMERIC)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  UPDATE wallets
  SET
    total_credited = COALESCE(total_credited, 0) + p_amount,
    updated_at = NOW()
  WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION public.increment_wallet_total_credited(UUID, NUMERIC) TO service_role;
