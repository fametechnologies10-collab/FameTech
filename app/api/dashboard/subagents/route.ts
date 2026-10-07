// app/api/dashboard/subagents/route.ts
// =============================================================================
// Plan 3, Task 4 — recruiter creates/lists sub-agents from the main dashboard
// (docs/superpowers/specs/2026-09-14-subagent-auth-design.md, C1/C2).
//
// POST creates a sub-agent by name/email/phone (no invite link). The
// plaintext access key is delivered directly to the new sub-agent via
// SMS + email (lib/sub-agent-create.ts -> deliverSubAgentCredentials) — it is
// NEVER returned to the recruiter's browser. GET lists the caller's own
// downline.
//
// All business rules (recruit-cannot-recruit, recruit cap, email/phone
// uniqueness, account creation order) live in lib/sub-agent-create.ts so they
// can be unit-tested with a fake SupabaseClient — see
// scripts/test-subagent-create.ts. This route only authenticates the caller
// and translates the result into the HTTP response.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { createSubAgent, listSubAgents, getRecruitCapUsage } from '@/lib/sub-agent-create'
import { sendSMS } from '@/lib/sms-service'
import { sendEmail } from '@/lib/email-service'

export async function POST(request: NextRequest) {
    try {
        // ── 0. Origin check — this route mints real credentials (an access
        //      key), matching the defense-in-depth already applied to
        //      /api/auth/login. Not currently exploitable (auth cookie is
        //      SameSite=Lax), but cheap and consistent with established
        //      practice for sensitive POST routes. ──────────────────────────
        if (!hasTrustedRequestOrigin(request)) {
            return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 })
        }

        // ── 1. Authenticate the recruiter ───────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // ── 2. Parse body ────────────────────────────────────────────────────
        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
        }

        const { name, email, phone } = (body ?? {}) as Record<string, unknown>
        if (typeof name !== 'string' || typeof email !== 'string' || typeof phone !== 'string') {
            return NextResponse.json(
                { success: false, error: 'name, email and phone are required' },
                { status: 400 },
            )
        }

        // ── 3. Business logic (service-role — sub_agents has no client write
        //      policies by design; see 20260701_sub_agents.sql) ──────────────
        const admin = createServerClient()
        const result = await createSubAgent(admin, user.id, { name, email, phone }, {
            sendSms: sendSMS,
            sendEmail,
        })

        if (!result.success) {
            return NextResponse.json({ success: false, error: result.error }, { status: result.status })
        }

        // The plaintext access key is never returned here — it is delivered
        // directly to the new sub-agent's own phone/email inside
        // createSubAgent. deliveryStatus lets the recruiter's UI show a
        // "credentials sent" confirmation instead of a key-reveal dialog.
        return NextResponse.json({
            success: true,
            subAgent: result.subAgent,
            deliveryStatus: result.deliveryStatus,
        })
    } catch (error) {
        console.error('[api/dashboard/subagents] POST failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

export async function GET(_request: NextRequest) {
    try {
        // ── 1. Authenticate the recruiter ───────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // ── 2. List the caller's own downline ───────────────────────────────
        const admin = createServerClient()
        const result = await listSubAgents(admin, user.id)

        if (!result.success) {
            return NextResponse.json({ success: false, error: result.error }, { status: result.status })
        }

        // Informational only (not an enforcement gate — the DB trigger is the
        // real, atomic cap check) — a transient count-read error here just
        // logs and still shows a best-effort cap/remaining, unlike
        // createSubAgent's pre-check, which hard-fails on the same error.
        const { countError, ...capUsage } = await getRecruitCapUsage(admin, user.id)
        if (countError) {
            console.error('[api/dashboard/subagents] GET recruit-cap count lookup failed', countError)
        }

        return NextResponse.json({ success: true, subAgents: result.subAgents, ...capUsage })
    } catch (error) {
        console.error('[api/dashboard/subagents] GET failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
