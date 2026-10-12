-- Role-upgrade audit fixes (2026-10-12) — see docs/security-audits/2026-10-12-role-upgrade-audit.md
--
-- H1  A Lifetime Agent could be re-purchased into a time-limited agent (and charged for it).
-- H2  No row lock / idempotency: concurrent or retried requests double-charged for one extension.
-- H3  Wallet deduction and role grant were separate statements: a failed grant kept the money.
-- M4  auto_upgrade_* were writable by the user's own session (RLS self-update), so the toggle
--     route's validation was advisory only.
--
-- process_wallet_upgrade() does the whole purchase in ONE transaction, locking the users row
-- FOR UPDATE *before* the idempotency / eligibility checks (see CLAUDE.md wallet rule):
--   lock user -> idempotency -> status -> eligibility -> (due?) -> balance -> deduct -> ledger -> grant.
-- Any exception rolls everything back, so a charge can never be kept without the role grant.
-- Every non-"ok" status is returned WITHOUT having modified anything.

-- ── Idempotency: one ledger row per upgrade reference ────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_upgrade_reference_unique
    ON public.wallet_transactions (reference)
    WHERE source = 'purchase' AND reference LIKE 'upgrade\_%';

-- ── Atomic purchase ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_wallet_upgrade(
    p_user_id       uuid,
    p_upgrade_type  text,
    p_plan          text,
    p_price         numeric,
    p_plan_label    text,
    p_reference     text,
    p_only_if_due   boolean DEFAULT false,
    p_is_auto       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_now          timestamptz := now();
    v_user         record;
    v_wallet_id    uuid;
    v_balance      numeric;
    v_new_balance  numeric;
    v_days         integer;
    v_months       integer;
    v_base         timestamptz;
    v_new_expiry   timestamptz;
    v_was_ext      boolean;
    v_due          boolean;
    v_existing     record;
BEGIN
    -- 0. Request sanity (never trust the caller, even the service role's code paths)
    IF p_user_id IS NULL
       OR p_price IS NULL OR p_price <= 0 OR p_price > 100000
       OR p_reference IS NULL OR p_reference !~ '^upgrade_(agent|dealer)_[A-Za-z0-9:_-]{8,120}$'
       OR split_part(p_reference, '_', 2) IS DISTINCT FROM p_upgrade_type
       OR NOT (
            (p_upgrade_type = 'agent'  AND p_plan IN ('3d', '14d', '30d', 'permanent'))
         OR (p_upgrade_type = 'dealer' AND p_plan IN ('1m', '3m', '6m'))
       )
    THEN
        RETURN jsonb_build_object('status', 'invalid_request');
    END IF;

    -- 1. Lock the user row FIRST — serialises every concurrent upgrade for this user
    SELECT id, role, status, agent_expires_at, dealer_expires_at
      INTO v_user
      FROM public.users
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'user_not_found');
    END IF;

    -- 2. Idempotency (after the lock): a replay of the same reference never charges again
    SELECT user_id INTO v_existing
      FROM public.wallet_transactions
     WHERE reference = p_reference AND source = 'purchase';

    IF FOUND THEN
        IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
            RETURN jsonb_build_object('status', 'invalid_request');
        END IF;
        RETURN jsonb_build_object(
            'status', 'already_processed',
            'new_expiry', CASE WHEN p_upgrade_type = 'dealer' THEN v_user.dealer_expires_at ELSE v_user.agent_expires_at END
        );
    END IF;

    -- 3. Account must be active
    IF v_user.status IS DISTINCT FROM 'active' THEN
        RETURN jsonb_build_object('status', 'account_inactive');
    END IF;

    -- 4. Eligibility (decided on the locked, current row — not a stale read)
    IF p_upgrade_type = 'dealer' THEN
        IF NOT ((v_user.role = 'agent' AND v_user.agent_expires_at IS NULL) OR v_user.role = 'dealer') THEN
            RETURN jsonb_build_object('status', 'not_eligible');
        END IF;
    ELSE
        -- A Lifetime Agent must never be re-bought into a timed pass (would erase lifetime status)
        IF v_user.role = 'agent' AND v_user.agent_expires_at IS NULL THEN
            RETURN jsonb_build_object('status', 'already_permanent');
        END IF;
        IF v_user.role NOT IN ('customer', 'agent') THEN
            RETURN jsonb_build_object('status', 'not_eligible');
        END IF;
    END IF;

    -- 5. Auto-renewal only: re-check "due" on the locked row so a manual renewal that raced the
    --    cron is not charged a second time.
    IF p_only_if_due THEN
        v_due := CASE
            WHEN v_user.role = 'dealer' THEN
                v_user.dealer_expires_at IS NOT NULL AND v_user.dealer_expires_at <= v_now + interval '24 hours'
            WHEN v_user.role = 'agent' AND v_user.agent_expires_at IS NULL THEN
                p_upgrade_type = 'dealer'
            WHEN v_user.role = 'agent' THEN
                v_user.agent_expires_at <= v_now + interval '24 hours'
            ELSE true
        END;
        IF NOT v_due THEN
            RETURN jsonb_build_object('status', 'not_due');
        END IF;
    END IF;

    -- 6. Wallet: lock, then check balance
    SELECT id, balance INTO v_wallet_id, v_balance
      FROM public.wallets
     WHERE user_id = p_user_id
       FOR UPDATE;

    IF v_wallet_id IS NULL THEN
        RETURN jsonb_build_object('status', 'wallet_not_found');
    END IF;

    IF v_balance < p_price THEN
        RETURN jsonb_build_object(
            'status', 'insufficient_balance',
            'current_balance', v_balance,
            'required_amount', p_price
        );
    END IF;

    -- 7. Deduct
    UPDATE public.wallets
       SET balance     = balance - p_price,
           total_spent = COALESCE(total_spent, 0) + p_price,
           updated_at  = v_now
     WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    -- 8. Ledger (unique reference index makes this the idempotency anchor too)
    INSERT INTO public.wallet_transactions
        (wallet_id, user_id, type, amount, description, reference, source, status, metadata)
    VALUES
        (v_wallet_id, p_user_id, 'debit', p_price,
         CASE WHEN p_is_auto THEN 'Auto-upgrade: ' ELSE 'Upgrade purchase: ' END || left(coalesce(p_plan_label, p_plan), 80),
         p_reference, 'purchase', 'completed',
         jsonb_build_object('upgrade_type', p_upgrade_type, 'plan', p_plan, 'auto', p_is_auto));

    -- 9. Grant the role / extend the expiry
    IF p_upgrade_type = 'dealer' THEN
        v_months := CASE p_plan WHEN '1m' THEN 1 WHEN '3m' THEN 3 ELSE 6 END;
        v_was_ext := v_user.role = 'dealer';
        v_base := CASE WHEN v_user.dealer_expires_at IS NOT NULL AND v_user.dealer_expires_at > v_now
                       THEN v_user.dealer_expires_at ELSE v_now END;
        -- interval arithmetic clamps month-ends (Jan 31 + 1 month = Feb 28), unlike JS setMonth
        v_new_expiry := v_base + make_interval(months => v_months);

        UPDATE public.users
           SET role = 'dealer', dealer_expires_at = v_new_expiry, updated_at = v_now
         WHERE id = p_user_id;
    ELSE
        v_days := CASE p_plan WHEN '3d' THEN 3 WHEN '14d' THEN 14 WHEN '30d' THEN 30 ELSE NULL END;
        v_was_ext := v_user.role = 'agent' AND v_user.agent_expires_at IS NOT NULL AND v_user.agent_expires_at > v_now;
        IF v_days IS NULL THEN
            v_new_expiry := NULL;   -- permanent
        ELSE
            v_base := CASE WHEN v_user.agent_expires_at IS NOT NULL AND v_user.agent_expires_at > v_now
                           THEN v_user.agent_expires_at ELSE v_now END;
            v_new_expiry := v_base + make_interval(days => v_days);
        END IF;

        UPDATE public.users
           SET role = 'agent', agent_expires_at = v_new_expiry, updated_at = v_now
         WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'status', 'ok',
        'new_expiry', v_new_expiry,
        'new_balance', v_new_balance,
        'was_extension', v_was_ext,
        'previous_role', v_user.role
    );
END;
$function$;

-- Server-only: the route/cron call this with the service-role key. Never client-callable.
REVOKE ALL ON FUNCTION public.process_wallet_upgrade(uuid, text, text, numeric, text, text, boolean, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_wallet_upgrade(uuid, text, text, numeric, text, text, boolean, boolean)
    TO service_role;

-- ── M4: auto_upgrade_* may only change through the server (service role has auth.uid() NULL) ──
CREATE OR REPLACE FUNCTION public.guard_users_privilege_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if auth.uid() is not null then
    if new.role is distinct from old.role then
      raise exception 'SECURITY: changing account role is not permitted for this session';
    end if;
    if new.agent_expires_at is distinct from old.agent_expires_at
       or new.dealer_expires_at is distinct from old.dealer_expires_at then
      raise exception 'SECURITY: changing reseller expiry is not permitted for this session';
    end if;
    if new.auto_upgrade_enabled is distinct from old.auto_upgrade_enabled
       or new.auto_upgrade_plan is distinct from old.auto_upgrade_plan then
      raise exception 'SECURITY: auto-upgrade settings can only be changed through the upgrade service';
    end if;
    if new.status is distinct from old.status then
      raise exception 'SECURITY: changing account status is not permitted for this session';
    end if;
    if new.pin_hash is distinct from old.pin_hash
       or new.pin_salt is distinct from old.pin_salt
       or new.pin_attempts is distinct from old.pin_attempts
       or new.pin_locked_until is distinct from old.pin_locked_until then
      raise exception 'SECURITY: app-lock PIN can only be changed through the PIN service';
    end if;
    if new.email is distinct from old.email then
      raise exception 'SECURITY: email can only be changed through account support';
    end if;
    if (new.phone_number is distinct from old.phone_number
        or new.phone_verified is distinct from old.phone_verified)
       and old.phone_verified is true then
      raise exception 'SECURITY: a verified phone number can only be changed through the recovery flow';
    end if;
  end if;
  return new;
end;
$function$;
