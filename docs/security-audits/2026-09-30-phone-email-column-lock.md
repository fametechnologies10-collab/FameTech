# 2026-09-30 — Phone/Email Column Lock (Phone OTP Verification Gate)

## Context
Built while shipping the mandatory phone-verification gate. Investigated whether
`public.users.role` could be rewritten by an authenticated client (it was the stated
concern going in) and whether `email` was already protected the way it was assumed to be.

## Findings
- **`role` was already fully protected.** `guard_users_privilege_change()` (trigger
  `trg_guard_users_privilege`, `BEFORE UPDATE ON public.users`) blocks any change to
  `role`, `agent_expires_at`, `dealer_expires_at`, `status`, and the PIN columns whenever
  `auth.uid() IS NOT NULL`. Confirmed live against the trigger definition and traced every
  current role-writing code path (`lib/payments.ts`, `lib/dealer-payments.ts`,
  `lib/sub-agent-create.ts`, `app/api/admin/assign-agent`, `assign-dealer`, both
  downgrade crons) — all use `createServerClient()`/`createAdminClient()` service-role
  with no user JWT attached, so none are affected by this or any future tightening of
  this trigger.
- **`email` had zero protection** — any authenticated user could rewrite their own
  `public.users.email` directly via PostgREST. Fixed in
  `supabase/migrations/20260930_phone_email_lock_and_recovery.sql` by extending the same
  trigger function.
- **Pre-existing data drift**: 2 accounts (out of 1,063) had `public.users.email` out of
  sync with the real `auth.users.email` — evidence that nothing has ever kept these in
  sync when a user changes their real login email via Supabase Auth. Backfilled as part
  of the same migration (verified 0 mismatches remain post-backfill). **Follow-up not yet
  built:** no route currently syncs `public.users.email` after a genuine Auth email
  change; needed before this can recur.
- **`phone_number`/`phone_verified`** locked the same way, conditioned on
  `OLD.phone_verified IS TRUE` so the existing `complete-profile` first-time-verification
  flow (browser/RLS client) keeps working unmodified.
- **Recovery lockout RPC (`record_phone_recovery_attempt`) verified live**: ran the
  escalating-lockout sequence directly against a real user row (3 wrong attempts →
  `locked_until` set to exactly +1 minute; a 4th attempt, including a *correct* guess,
  still returned `outcome: locked` — confirming the lock is checked before the
  correct/wrong branch, so a lock can't be bypassed by eventually guessing right). Test
  row deleted after verification.

## Critical finding from the `payments-security-reviewer` pass (fixed same branch)
- **`PUT /api/users/update-profile` completely bypassed this feature.** It accepted
  `phone_number` as an editable field and wrote it via `createServerClient()`
  (service-role, `lib/supabase.ts`) — a connection with no user JWT, so the new
  `auth.uid() IS NOT NULL` guard on `guard_users_privilege_change()` never fired there.
  Any authenticated user could silently overwrite their own `phone_number` with zero OTP
  proof, and `phone_verified` was left `true` (stale), so the dashboard gate would never
  re-trigger for the new, unverified number. This defeated the entire feature for any
  account, not a theoretical edge case.
- **Fix**: removed `phone_number` from that route's accepted schema entirely (only
  `first_name`/`last_name` remain editable there). The profile page (`app/dashboard/
  profile/page.tsx`) now shows the phone number read-only with a link into the
  phone-verify-gate recovery flow (`/auth/verify-phone-required?mode=change`), and that
  page now supports a voluntary "already verified, want to change number" entry point
  (previously it only handled the mandatory unverified-user path).
- Also fixed three lower-severity findings from the same review: the OTP freshness
  window in `confirm`/`recover/complete` was measured from OTP *send* time rather than
  verify time (widened 10m → 30m to leave real headroom after slow SMS delivery); the
  hard-lock error copy implied only an admin could clear it, when the 1-hour window reset
  already does so automatically (copy corrected); `maskPhoneHint`'s fallback for a
  non-10-digit `phone_number` leaked the true stored length via bullet count (now a fixed
  10-bullet mask regardless of input length).
- **Accepted, not fixed**: the recovery token reuses `SUPABASE_SERVICE_ROLE_KEY` as its
  HMAC signing secret. The reviewer found no exploitable forgery/replay path (5-minute
  TTL, bound to the authenticated caller's own `user.id`, timing-safe comparison) and
  explicitly flagged this as non-blocking — noted here so a future secret rotation or any
  code path that logs this key is aware of the extra consumer.

## Found in live preview testing: real phone number reached the browser (fixed same branch)
- **Symptom**: the "Verify Your Number" screen displayed the full on-file number in
  plaintext ("Enter the 6-digit code sent to 0507193592"), and moments later the
  "Can't access this number?" recovery step's masked hint ("05••••••92") was trivially
  satisfiable by reading the number already shown on the previous screen — defeating the
  point of masking it against a hijacked/shared authenticated session.
- **Root cause**: structural, not just a display bug. The gate page fetched
  `phone_number` directly from `public.users` via the browser client on load and held it
  in React state to pass to `/api/auth/verify-phone`'s `send`/`verify` actions, which take
  a client-supplied `phone`. The real number reached client JS state and network traffic
  regardless of what text was rendered.
- **Fix**: extracted OTP send/verify logic into `lib/phone-otp-service.ts` (`sendPhoneOtp`,
  `verifyPhoneOtp`); `/api/auth/verify-phone` now delegates to it with unchanged external
  behavior for `complete-profile`. Two new routes,
  `/api/auth/phone-verify-gate/{send-current,verify-current}`, resolve the caller's own
  `phone_number` **server-side only** and never return it to the browser — superseding the
  old `/phone-verify-gate/confirm` route. The gate page now only ever holds the masked
  hint (from the existing `/hint` endpoint, extended to also report `phoneVerified` so the
  page no longer needs a direct table read at all). The recovery flow's brand-new-number
  step is unaffected — that number is user-typed input, not a stored secret.

## Verification
- `select count(*) from public.users u join auth.users au on au.id = u.id where u.email
  is distinct from au.email;` → `0` (was `2` pre-migration).
- `select tgname from pg_trigger where tgrelid = 'public.users'::regclass and tgname =
  'trg_guard_users_privilege';` → 1 row (function replaced in place, trigger name
  unchanged).
- Direct RPC exercise of `record_phone_recovery_attempt` against a live row, see Findings
  above.
