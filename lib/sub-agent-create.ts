// lib/sub-agent-create.ts
// =============================================================================
// Recruiter-side sub-agent creation and downline listing (Plan 3, Task 4 —
// docs/superpowers/specs/2026-09-14-subagent-auth-design.md, C1/C2).
//
// Pulled out of app/api/dashboard/subagents/route.ts into a plain function so
// the business RULES (auth-independent) can be unit-tested with a fake
// SupabaseClient, matching this codebase's established test convention (see
// scripts/test-sub-agent-account.ts, scripts/test-sub-agent-key.ts) — the
// route itself only handles session auth + HTTP plumbing and is not,
// separately, unit-testable the same way.
//
// All rules fail closed and run BEFORE any account is created:
//   1. Caller auth — enforced by the route, not here (this function assumes
//      recruiterId is already a verified, authenticated user id).
//   2. Caller must be a LIVE eligible recruiter — role literally 'agent' or
//      'dealer' AND canOwnSubNetwork(caller) (spec 2026-09-06 §3.2: "role IN
//      ('agent','dealer')"; canOwnSubNetwork, lib/pricing/cost-basis.ts, is
//      the same function resolveSubAgentContext already uses to gate a
//      RECRUITER's eligibility — a lifetime agent or an active dealer only).
//      Deliberately excludes customer/admin/sub-admin — the spec never lists
//      admin as an eligible recruiter, and this is checked FIRST, before Rule
//      3, because "not an eligible recruiter at all" is more fundamental than
//      "already a sub" (final-review C1 fix, 2026-09-14).
//   3. Caller must not already be a sub-agent themselves (spec C1) — a sub
//      can never recruit. (In practice Rule 2 already excludes every sub —
//      a sub's role is 'subagent', never 'agent'/'dealer' — so this is now a
//      defense-in-depth check, not the primary gate.)
//   4. Caller must be under their recruit cap
//      (shop_global_settings.sub_agent_max_recruits, default 5).
//   5. No existing `users` row may already have this email OR this phone —
//      a SINGLE generic message either way (enumeration discipline matching
//      app/api/auth/login/route.ts: the login route resolves a submitted
//      phone number to an email via a `phone_number` lookup that assumes
//      uniqueness, so a duplicate phone silently breaks phone-based login for
//      BOTH accounts it belongs to).
//   6. Only then: generate the access key, create the Supabase Auth + users
//      row, insert the sub_agents edge (status: 'active' — no approval step,
//      since direct recruiter creation IS the approval), set role='subagent'.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { generateAccessKey } from '@/lib/sub-agent-key'
import { shortTextSchema, accountEmailSchema } from '@/lib/validation'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { canOwnSubNetwork } from '@/lib/pricing/cost-basis'
import { deliverSubAgentCredentials, type CredentialsDeliveryDeps } from '@/lib/sub-agent-credentials-delivery'

const DEFAULT_MAX_RECRUITS = 5

// One generic message for every creation failure caused by caller input that
// could otherwise leak which specific identifier collided (SEC-025-style
// enumeration discipline — see app/api/auth/check-availability/route.ts and
// app/api/auth/login/route.ts's INVALID_CREDENTIALS_MESSAGE for the same
// pattern elsewhere in this codebase).
const GENERIC_CREATE_FAILURE = 'Could not create sub-agent account'

export interface CreateSubAgentInput {
    name: string
    email: string
    phone: string
}

export interface CreateSubAgentResult {
    success: boolean
    status: number
    error?: string
    subAgent?: { id: string; name: string; email: string }
    deliveryStatus?: { smsDelivered: boolean; emailDelivered: boolean }
}

const nameSchemaNonEmpty = shortTextSchema.refine(
    (val) => val.trim().length > 0,
    'Name is required',
)

/**
 * Shared recruit-cap-usage lookup — used both by `createSubAgent`'s Rule 4
 * pre-check and by the GET /api/dashboard/subagents route (to show the
 * recruiter their cap/used/remaining on the recruit page), so the two call
 * sites read `shop_global_settings`/`sub_agents` through one implementation
 * instead of duplicating the query.
 */
export async function getRecruitCapUsage(
    db: SupabaseClient,
    recruiterId: string,
): Promise<{ cap: number; used: number; remaining: number; countError?: unknown }> {
    const [settingResult, countResult] = await Promise.all([
        (db.from('shop_global_settings') as any).select('value').eq('key', 'sub_agent_max_recruits').maybeSingle(),
        (db.from('sub_agents') as any).select('id', { count: 'exact', head: true }).eq('upline_user_id', recruiterId),
    ])

    if (settingResult.error) {
        // Best-effort only: a missing/malformed cap setting just falls back to
        // DEFAULT_MAX_RECRUITS below — never fatal for either call site.
        console.error('[getRecruitCapUsage] max-recruits setting lookup failed', settingResult.error)
    }

    // shop_global_settings.value is JSONB — mirrors the parseFloat(row.value)
    // convention already used to read it in app/api/shop/withdraw/route.ts,
    // which works whether the driver hands back a JS number or a string.
    const rawCap = settingResult.data?.value
    const parsedCap = rawCap !== undefined && rawCap !== null ? parseFloat(rawCap as any) : NaN
    const cap = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : DEFAULT_MAX_RECRUITS
    const used = countResult.count ?? 0

    return {
        cap,
        used,
        remaining: Math.max(0, cap - used),
        // Surfaced (not swallowed) — unlike the setting lookup above, the
        // `sub_agents` count IS the cap check's own input, so a failed count
        // read isn't safe to silently fall back from the way a missing
        // setting is. Left for each call site to decide how fatal this is:
        // createSubAgent's pre-check treats it as fatal (hard-fails with the
        // same 500 the pre-Task-4 inline code used to return here — see
        // caller); the GET route's read-only cap/remaining display treats it
        // as non-fatal, since it's informational, not an enforcement gate.
        ...(countResult.error ? { countError: countResult.error } : {}),
    }
}

/**
 * Compensating action for a creation that failed AFTER `auth.admin.createUser`
 * already succeeded (the `sub_agents` insert or the `role='subagent'` update).
 * Without this, a plain DB hiccup on either of those two steps would leave a
 * real, fully login-capable orphaned account behind — and Rule 4's uniqueness
 * check would then treat that email/phone as permanently taken, blocking
 * every future retry of creating the same sub-agent.
 *
 * Best-effort only: a failure to delete must never mask the ORIGINAL error
 * that triggered this cleanup — same idiom as the promote-then-clear ordering
 * in lib/sub-agent-key.ts's tryPromotePendingKey (its own best-effort cleanup
 * comment is the precedent this mirrors). Logged, never thrown, never
 * returned to the caller.
 */
async function compensateFailedCreation(db: SupabaseClient, userId: string): Promise<void> {
    const { error } = await db.auth.admin.deleteUser(userId)
    if (error) {
        console.error('[createSubAgent] compensating deleteUser failed — orphaned account left behind', userId, error)
    }
}

/**
 * Creates a sub-agent recruited directly by `recruiterId`. `db` must be a
 * service-role (admin) client — this function reads/writes `users` and
 * `sub_agents` directly and calls the Supabase Admin API, all of which
 * require bypassing RLS by design (there are deliberately no client write
 * policies on sub_agents; see 20260701_sub_agents.sql).
 */
export async function createSubAgent(
    db: SupabaseClient,
    recruiterId: string,
    input: CreateSubAgentInput,
    // Required, not defaulted here — lib/email-service.ts throws AT IMPORT
    // TIME when RESEND_API_KEY is unset (`new Resend(undefined)`), so this
    // file must never import it (or lib/sms-service.ts) at module scope; that
    // would make it impossible to unit-test with a fake db (this file's whole
    // reason for existing — see the top-of-file comment). The route
    // (app/api/dashboard/subagents/route.ts) supplies the real
    // sendSMS/sendEmail, exactly like lib/sub-agent-regenerate.ts's deps.
    deps: CredentialsDeliveryDeps,
): Promise<CreateSubAgentResult> {
    // Rule 2 (spec 2026-09-06 §3.2, final-review C1): the caller must be a LIVE
    // eligible recruiter. Checked BEFORE Rule 3 — "not an eligible recruiter at
    // all" is a more fundamental rejection than "already a sub". Any of the
    // platform's customer/admin/sub-admin accounts must be rejected here, not
    // just subs — the route previously had no role gate at all, letting any
    // authenticated user mint real Supabase Auth accounts via this endpoint.
    const { data: recruiterUser, error: recruiterLookupError } = await (db.from('users') as any)
        .select('id, role, agent_expires_at, dealer_expires_at')
        .eq('id', recruiterId)
        .maybeSingle()

    if (recruiterLookupError) {
        console.error('[createSubAgent] recruiter eligibility lookup failed', recruiterLookupError)
        return { success: false, status: 500, error: GENERIC_CREATE_FAILURE }
    }

    const recruiterRole = recruiterUser?.role
    const isEligibleRole = recruiterRole === 'agent' || recruiterRole === 'dealer'
    if (!recruiterUser || !isEligibleRole || !canOwnSubNetwork(recruiterUser)) {
        return { success: false, status: 403, error: 'Only agents and dealers may recruit sub-agents' }
    }

    // Rule 3 (spec C1): a sub can never recruit. Rule 2 already excludes every
    // sub in practice (a sub's role is 'subagent'), but this stays as an
    // explicit, independent defense-in-depth check.
    const context = await resolveSubAgentContext(db, recruiterId)
    if (context.isSub) {
        return { success: false, status: 403, error: 'Sub-agent accounts cannot recruit others' }
    }

    // Validate shape before anything else touches the database.
    const nameResult = nameSchemaNonEmpty.safeParse(input.name)
    if (!nameResult.success) {
        return { success: false, status: 400, error: nameResult.error.errors[0]?.message ?? 'Invalid name' }
    }

    const emailResult = accountEmailSchema.safeParse(input.email)
    if (!emailResult.success) {
        return { success: false, status: 400, error: emailResult.error.errors[0]?.message ?? 'Invalid email' }
    }

    const phoneValidation = validateGhanaianPhone(input.phone)
    if (!phoneValidation.isValid) {
        return { success: false, status: 400, error: phoneValidation.error ?? 'Invalid phone number' }
    }

    const name = nameResult.data.trim()
    const email = emailResult.data
    const phone = phoneValidation.normalizedNumber

    // Rule 4: recruit cap.
    const { cap, used, countError } = await getRecruitCapUsage(db, recruiterId)
    if (countError) {
        console.error('[createSubAgent] recruit count lookup failed', countError)
        return { success: false, status: 500, error: GENERIC_CREATE_FAILURE }
    }
    if (used >= cap) {
        return { success: false, status: 403, error: 'You have reached your recruit limit' }
    }

    // Rule 5: uniqueness (email OR phone). Deliberate, scoped exception to the
    // enumeration-avoidance policy used elsewhere (app/api/auth/signup,
    // app/api/auth/login keep their existing generic-message behavior, untouched):
    // this is a recruiter-creates-a-known-person flow, so the recruiter already
    // personally knows who they're recruiting — naming which field collided
    // leaks nothing exploitable here, and a distinct message lets them fix the
    // right field immediately.
    // Two parallel .eq() queries, never a .or() built from user input — same
    // filter-injection-avoidance pattern as app/api/auth/signup/route.ts.
    const [emailLookup, phoneLookup] = await Promise.all([
        (db.from('users') as any).select('id').eq('email', email).maybeSingle(),
        (db.from('users') as any).select('id').eq('phone_number', phone).maybeSingle(),
    ])

    if (emailLookup.error || phoneLookup.error) {
        console.error('[createSubAgent] uniqueness lookup failed', emailLookup.error, phoneLookup.error)
        return { success: false, status: 500, error: GENERIC_CREATE_FAILURE }
    }

    if (emailLookup.data) {
        return { success: false, status: 400, error: 'An account with this email already exists.' }
    }
    if (phoneLookup.data) {
        return { success: false, status: 400, error: 'An account with this phone number already exists.' }
    }

    // Rule 6: create the account. The access key IS the sub-agent's Supabase
    // Auth password (spec C3) — there is no separate credential store, so
    // there is nothing to hash-and-persist here beyond what Supabase Auth
    // already does internally. hashAccessKey (lib/sub-agent-key.ts) is used
    // only by the regenerate/promote flow (Task 5/6), which stores a
    // *pending* key hash for a grace window; it is exercised in this file's
    // test via a round-trip check, not called from this function.
    const accessKey = generateAccessKey()

    const { data: created, error: createError } = await db.auth.admin.createUser({
        email,
        password: accessKey,
        email_confirm: true,
        user_metadata: {
            first_name: name,
            phone_number: phone,
        },
    })

    if (createError || !created?.user) {
        console.error('[createSubAgent] account creation failed', createError)

        // Root cause, 2026-09-29: Rule 5 above only checks public.users, so it
        // cannot see an email that exists in auth.users with no matching
        // public.users row (an orphaned Auth account left over from some
        // earlier, unrelated failure elsewhere). The real Supabase Auth call
        // is the only place that can catch this — surface it as the SAME
        // specific, actionable message Rule 5 already gives for an ordinary
        // duplicate, instead of the generic failure that told the recruiter
        // nothing they could act on.
        if ((createError as { code?: string } | null)?.code === 'email_exists') {
            return { success: false, status: 400, error: 'An account with this email already exists.' }
        }
        return { success: false, status: 500, error: GENERIC_CREATE_FAILURE }
    }

    const newUserId = created.user.id

    const { error: subAgentInsertError } = await (db.from('sub_agents') as any)
        .insert({ user_id: newUserId, upline_user_id: recruiterId, status: 'active', must_change_password: true })

    if (subAgentInsertError) {
        console.error('[createSubAgent] sub_agents insert failed', subAgentInsertError)
        await compensateFailedCreation(db, newUserId)

        // final-review I3: the Rule 4 count-check above is a fast, friendly
        // pre-check but is NOT atomic with this insert — two near-simultaneous
        // requests can both pass it. The real, race-proof enforcement is the
        // BEFORE INSERT trigger added in
        // supabase/migrations/20260914c_subagent_recruit_cap_race.sql, which
        // takes a pg_advisory_xact_lock keyed on the recruiter before
        // counting. This is the rare path where the pre-check passed but the
        // trigger still rejected — map its error literal back to the same
        // friendly message the pre-check already returns, rather than the
        // generic failure.
        if (typeof subAgentInsertError.message === 'string' && subAgentInsertError.message.includes('SUB_AGENT_RECRUIT_CAP_EXCEEDED')) {
            return { success: false, status: 403, error: 'You have reached your recruit limit' }
        }
        return { success: false, status: 500, error: GENERIC_CREATE_FAILURE }
    }

    // role='subagent' is set via UPDATE after the users row already exists
    // (created moments ago by the handle_new_user trigger) — this UPDATE only
    // touches `role`, never `email`/`phone_number`, so the contact-lock
    // trigger (20260914_subagent_auth.sql) — which only fires on a
    // email/phone_number change — never engages here.
    const { error: roleUpdateError } = await (db.from('users') as any)
        .update({ role: 'subagent' })
        .eq('id', newUserId)

    if (roleUpdateError) {
        console.error('[createSubAgent] role update failed', roleUpdateError)
        await compensateFailedCreation(db, newUserId)
        return { success: false, status: 500, error: GENERIC_CREATE_FAILURE }
    }

    // The plaintext key goes to the SUB-AGENT directly (SMS + email, on the
    // contact info this call itself just validated) — never back to the
    // recruiter's browser. See lib/sub-agent-credentials-delivery.ts, the
    // single shared path this also feeds the regenerate flow through.
    const delivery = await deliverSubAgentCredentials(
        'onboarding',
        { phone, email, firstName: name.split(' ')[0] || null },
        accessKey,
        deps,
    )

    return {
        success: true,
        status: 200,
        subAgent: { id: newUserId, name, email },
        deliveryStatus: delivery,
    }
}

export interface SubAgentListItem {
    id: string
    name: string
    email: string
    phone: string
    status: string
    created_at: string
}

export interface ListSubAgentsResult {
    success: boolean
    status: number
    error?: string
    subAgents?: SubAgentListItem[]
}

/**
 * Lists the sub-agents `recruiterId` has directly recruited. Two plain
 * queries (sub_agents, then users by id) rather than a PostgREST embedded
 * join — this avoids depending on this codebase's not-yet-regenerated FK
 * constraint name for sub_agents.user_id (schema unapplied — see task
 * brief), and is trivial to unit test with a fake db.
 */
export async function listSubAgents(
    db: SupabaseClient,
    recruiterId: string,
): Promise<ListSubAgentsResult> {
    const { data: subRows, error: subError } = await (db.from('sub_agents') as any)
        .select('user_id, status, created_at')
        .eq('upline_user_id', recruiterId)
        .order('created_at', { ascending: false })

    if (subError) {
        console.error('[listSubAgents] sub_agents lookup failed', subError)
        return { success: false, status: 500, error: 'Could not load sub-agents' }
    }

    const rows = subRows ?? []
    const userIds = rows.map((r: any) => r.user_id)

    let usersById: Record<string, any> = {}
    if (userIds.length > 0) {
        const { data: userRows, error: usersError } = await (db.from('users') as any)
            .select('id, first_name, last_name, email, phone_number')
            .in('id', userIds)

        if (usersError) {
            console.error('[listSubAgents] users lookup failed', usersError)
            return { success: false, status: 500, error: 'Could not load sub-agents' }
        }

        usersById = Object.fromEntries((userRows ?? []).map((u: any) => [u.id, u]))
    }

    const subAgents: SubAgentListItem[] = rows.map((r: any) => {
        const u = usersById[r.user_id]
        return {
            id: r.user_id,
            name: [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim(),
            email: u?.email ?? '',
            phone: u?.phone_number ?? '',
            status: r.status,
            created_at: r.created_at,
        }
    })

    return { success: true, status: 200, subAgents }
}
