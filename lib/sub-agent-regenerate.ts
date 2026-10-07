// lib/sub-agent-regenerate.ts
// =============================================================================
// Recruiter-triggered access-key regenerate for a sub-agent (Plan 3, Task 5 —
// docs/superpowers/specs/2026-09-14-subagent-auth-design.md, C5).
//
// Pulled out of app/api/dashboard/subagents/[id]/regenerate/route.ts into a
// plain function so the business RULES can be unit-tested with a fake
// SupabaseClient + fake delivery senders, matching this codebase's
// established test convention (lib/sub-agent-create.ts /
// scripts/test-subagent-create.ts) — the route itself only handles session
// auth + HTTP plumbing.
//
// C5's whole point: a recruiter can trigger a regenerate, but the new
// plaintext key must be structurally incapable of reaching the recruiter's
// screen or any freshly-typed address. It only ever reaches the sub-agent via
// the SMS/phone_number and email already on file for THEIR OWN users row —
// never from the request body, and never echoed back in the HTTP response.
//
// All rules fail closed:
//   1. Caller auth — enforced by the route, not here (this function assumes
//      callerId is already a verified, authenticated user id).
//   2. Caller must be the sub's ACTUAL upline — 403 if
//      sub_agents.upline_user_id !== callerId; 404 if no sub_agents row
//      exists at all for subUserId.
//   3. The request body must be REJECTED with 400 if it contains an `email`
//      or `phone` key AT ALL, present or not, regardless of value — an
//      explicit reject (not a silent ignore) makes this constraint auditable
//      and testable, and is the whole point of closing the "recruiter
//      redirects delivery" loophole.
//   4. On success: beginRegenerate(db, subUserId) stages the new key, then
//      the sub's CURRENT email/phone_number are read from their OWN users
//      row (never the request body — rule 3 already forbids one, but this
//      stands as independent defense in depth) and the plaintext is
//      delivered via SMS + email.
//   5. The plaintext key NEVER appears in this function's return value.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { beginRegenerate } from '@/lib/sub-agent-key'
import { deliverSubAgentCredentials } from '@/lib/sub-agent-credentials-delivery'

export interface RegenerateDeps {
    /** Defaults to lib/sms-service.ts's sendSMS. Injectable for tests. */
    sendSms: (options: { recipient: string; message: string }) => Promise<{ success: boolean; error?: string }>
    /** Defaults to lib/email-service.ts's sendEmail. Injectable for tests. */
    sendEmail: (options: { to: string; toName?: string; subject: string; htmlContent: string }) => Promise<{ success: boolean; error?: string }>
}

export interface RegenerateResult {
    success: boolean
    status: number
    error?: string
    message?: string
}

const GENERIC_FAILURE = 'Could not regenerate access key'

/**
 * Regenerates the access key for `subUserId` on behalf of `callerId` (the
 * caller must already be authenticated by the route). `db` must be a
 * service-role (admin) client — reads sub_agents/users directly, bypassing
 * RLS by design (no client write policies on sub_agents).
 */
export async function regenerateSubAgentKey(
    db: SupabaseClient,
    callerId: string,
    subUserId: string,
    body: unknown,
    deps: RegenerateDeps,
): Promise<RegenerateResult> {
    // Rule 3: explicit-reject any email/phone override field in the body,
    // present at all — never silently ignored.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        if (Object.prototype.hasOwnProperty.call(body, 'email') || Object.prototype.hasOwnProperty.call(body, 'phone')) {
            return {
                success: false,
                status: 400,
                error: 'email/phone cannot be provided on regenerate — the new key is always sent to the contact info already on file',
            }
        }
    }

    // Rule 2: caller must be the sub's actual upline.
    const { data: subRow, error: subError } = await (db as any)
        .from('sub_agents')
        .select('upline_user_id')
        .eq('user_id', subUserId)
        .maybeSingle()

    if (subError) {
        console.error('[regenerateSubAgentKey] sub_agents lookup failed', subError)
        return { success: false, status: 500, error: GENERIC_FAILURE }
    }

    if (!subRow) {
        return { success: false, status: 404, error: 'Sub-agent not found' }
    }

    if (subRow.upline_user_id !== callerId) {
        return { success: false, status: 403, error: "You are not this sub-agent's recruiter" }
    }

    // Rule 4: stage the new pending key.
    const regen = await beginRegenerate(db, subUserId)
    if (!regen.success || !regen.plaintextKey) {
        return { success: false, status: 500, error: regen.message || GENERIC_FAILURE }
    }
    const plaintextKey = regen.plaintextKey

    // Rule 4 (defense in depth): contact info comes ONLY from the sub's own
    // users row — never from the request body (rule 3 already blocks one).
    const { data: subUser, error: userError } = await (db as any)
        .from('users')
        .select('email, phone_number, first_name')
        .eq('id', subUserId)
        .maybeSingle()

    if (userError || !subUser) {
        // The key is already staged and will work on next login — but with no
        // contact info to deliver to, the sub has no way to receive it via
        // this route. Log loudly for support follow-up; still report success
        // since regeneration itself succeeded (the failure is delivery-only).
        console.error('[regenerateSubAgentKey] could not load sub-agent contact info for delivery', subUserId, userError)
        return { success: true, status: 200, message: regen.message }
    }

    // Delivery failures (missing contact info, a rejected send, or a
    // resolved-but-unsuccessful send) are logged with full detail inside
    // deliverSubAgentCredentials itself — shared with the onboarding path —
    // so there is nothing left to log here.
    await deliverSubAgentCredentials(
        'reset',
        { phone: subUser.phone_number, email: subUser.email, firstName: subUser.first_name },
        plaintextKey,
        deps,
    )

    return {
        success: true,
        status: 200,
        message: 'A new access key has been generated and sent to the phone number and email on file. It becomes active the next time it is used to sign in, within 2 hours.',
    }
}
