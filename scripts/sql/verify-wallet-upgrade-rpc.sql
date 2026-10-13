-- Re-runnable behavioural check for public.process_wallet_upgrade (role-upgrade audit, 2026-10-12).
-- Run in the Supabase SQL editor / execute_sql. It builds a throw-away auth user, exercises every
-- outcome, then ALWAYS ends with RAISE EXCEPTION so the whole transaction rolls back — nothing persists.
-- Expected report (the error message IS the report):
--   A status=ok bal=400.01 role=agent days=30 ledger=1 | B status=already_processed bal=400.01 |
--   C status=ok ext=true days=33 bal=390.02 | D status=ok role=agent exp=NULL |
--   E status=already_permanent exp=NULL balSame=t | F status=ok role=dealer | G status=not_eligible |
--   I1 status=not_due | I2 status=ok | H status=insufficient_balance cur=1.00 bal=1.00 |
--   J price0=invalid_request planmix=invalid_request badref=invalid_request negprice=invalid_request |
--   K status=account_inactive | M denied(ok) | N blocked(ok): SECURITY: auto-upgrade settings ...
-- Any "(BAD)" token, or a different status, means a regression.
DO $t$
DECLARE
  u uuid := gen_random_uuid(); r jsonb; out text := ''; bal numeric; exp1 timestamptz; role1 text; n int;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_user_meta_data, created_at, updated_at)
  VALUES (u, 'rpc-test-'||u||'@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{}'::jsonb, now(), now());
  SELECT count(*) INTO n FROM public.users WHERE id=u;
  IF n = 0 THEN RAISE EXCEPTION 'NO_FIXTURE: auth trigger did not create public.users row'; END IF;
  UPDATE public.users SET role='customer', status='active', agent_expires_at=NULL, dealer_expires_at=NULL WHERE id=u;
  UPDATE public.wallets SET balance=500 WHERE user_id=u;

  -- A: customer buys 30d
  r := public.process_wallet_upgrade(u,'agent','30d',99.99,'30 Days Agent Pass','upgrade_agent_aaaaaaaa-test-0001',false,false);
  SELECT balance INTO bal FROM wallets WHERE user_id=u; SELECT role, agent_expires_at INTO role1, exp1 FROM users WHERE id=u;
  out := out || format('A status=%s bal=%s role=%s days=%s ledger=%s | ', r->>'status', bal, role1, round(extract(epoch from exp1-now())/86400), (SELECT count(*) FROM wallet_transactions WHERE reference='upgrade_agent_aaaaaaaa-test-0001'));
  -- B: replay of the same reference must not charge again
  r := public.process_wallet_upgrade(u,'agent','30d',99.99,'30 Days Agent Pass','upgrade_agent_aaaaaaaa-test-0001',false,false);
  SELECT balance INTO bal FROM wallets WHERE user_id=u;
  out := out || format('B status=%s bal=%s | ', r->>'status', bal);
  -- C: extension stacks on the existing expiry
  r := public.process_wallet_upgrade(u,'agent','3d',9.99,'3d','upgrade_agent_aaaaaaaa-test-0002',false,false);
  SELECT balance INTO bal FROM wallets WHERE user_id=u; SELECT agent_expires_at INTO exp1 FROM users WHERE id=u;
  out := out || format('C status=%s ext=%s days=%s bal=%s | ', r->>'status', r->>'was_extension', round(extract(epoch from exp1-now())/86400), bal);
  -- D: permanent
  r := public.process_wallet_upgrade(u,'agent','permanent',149.99,'perm','upgrade_agent_aaaaaaaa-test-0003',false,false);
  SELECT role, agent_expires_at INTO role1, exp1 FROM users WHERE id=u;
  out := out || format('D status=%s role=%s exp=%s | ', r->>'status', role1, coalesce(exp1::text,'NULL'));
  -- E: a Lifetime Agent can NEVER be re-bought into a timed pass (H1)
  SELECT balance INTO bal FROM wallets WHERE user_id=u;
  r := public.process_wallet_upgrade(u,'agent','3d',9.99,'3d','upgrade_agent_aaaaaaaa-test-0004',false,false);
  SELECT role, agent_expires_at INTO role1, exp1 FROM users WHERE id=u;
  out := out || format('E status=%s exp=%s balSame=%s | ', r->>'status', coalesce(exp1::text,'NULL'), bal = (SELECT balance FROM wallets WHERE user_id=u));
  -- F: lifetime agent -> dealer
  r := public.process_wallet_upgrade(u,'dealer','1m',99.99,'d1','upgrade_dealer_aaaaaaaa-test-0005',false,false);
  SELECT role INTO role1 FROM users WHERE id=u;
  out := out || format('F status=%s role=%s | ', r->>'status', role1);
  -- G: a dealer cannot buy an agent pass
  r := public.process_wallet_upgrade(u,'agent','30d',99.99,'30d','upgrade_agent_aaaaaaaa-test-0006',false,false);
  out := out || format('G status=%s | ', r->>'status');
  -- I: auto-renewal re-checks "due" on the locked row
  r := public.process_wallet_upgrade(u,'dealer','1m',99.99,'d1','upgrade_dealer_aaaaaaaa-test-0007',true,true);
  out := out || format('I1 status=%s | ', r->>'status');
  UPDATE users SET dealer_expires_at = now() + interval '2 hours' WHERE id=u;
  r := public.process_wallet_upgrade(u,'dealer','1m',99.99,'d1','upgrade_dealer_aaaaaaaa-test-0008',true,true);
  out := out || format('I2 status=%s | ', r->>'status');
  -- H: insufficient balance changes nothing
  UPDATE wallets SET balance=1 WHERE user_id=u;
  r := public.process_wallet_upgrade(u,'dealer','3m',199.99,'d3','upgrade_dealer_aaaaaaaa-test-0009',false,false);
  SELECT balance INTO bal FROM wallets WHERE user_id=u;
  out := out || format('H status=%s cur=%s bal=%s | ', r->>'status', r->>'current_balance', bal);
  -- J: request sanity
  out := out || format('J price0=%s planmix=%s badref=%s negprice=%s | ',
     (public.process_wallet_upgrade(u,'agent','30d',0,'x','upgrade_agent_aaaaaaaa-test-0010'))->>'status',
     (public.process_wallet_upgrade(u,'agent','1m',10,'x','upgrade_agent_aaaaaaaa-test-0011'))->>'status',
     (public.process_wallet_upgrade(u,'agent','30d',10,'x','bad'))->>'status',
     (public.process_wallet_upgrade(u,'agent','30d',-5,'x','upgrade_agent_aaaaaaaa-test-0012'))->>'status');
  -- K: suspended account
  UPDATE users SET status='suspended', role='customer', agent_expires_at=NULL WHERE id=u;
  UPDATE wallets SET balance=500 WHERE user_id=u;
  r := public.process_wallet_upgrade(u,'agent','30d',99.99,'30d','upgrade_agent_aaaaaaaa-test-0013',false,false);
  out := out || format('K status=%s | ', r->>'status');
  UPDATE users SET status='active' WHERE id=u;
  -- M: not callable by end-user sessions
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.process_wallet_upgrade(u,'agent','30d',99.99,'30d','upgrade_agent_aaaaaaaa-test-0014',false,false);
    out := out || 'M CALLABLE-BY-AUTHENTICATED(BAD) | ';
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE; out := out || 'M denied(ok) | ';
  END;
  -- N: an end-user session cannot flip auto_upgrade_* directly
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role','authenticated')::text, true);
    UPDATE public.users SET auto_upgrade_enabled = true, auto_upgrade_plan='3d' WHERE id=u;
    out := out || 'N auto_upgrade WRITABLE(BAD) | ';
  EXCEPTION WHEN OTHERS THEN
    out := out || 'N blocked(ok): '||left(SQLERRM,60)||' | ';
  END;
  RAISE EXCEPTION 'REPORT (rolled back): %', out;
END $t$;
