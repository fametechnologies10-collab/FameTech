// app/api/dashboard/subagents/[id]/regenerate/route.ts
// =============================================================================
// Plan 3, Task 5 — recruiter regenerates a sub-agent's access key
// (docs/superpowers/specs/2026-09-14-subagent-auth-design.md, C5).
//
// POST stages a new key (grace period — see lib/sub-agent-key.ts's
// beginRegenerate) and delivers it to the sub via SMS + email using the
// contact info already on file for their OWN users row. The plaintext key
// NEVER appears in this route's response — that's the entire point of C5,
// closing the "recruiter regenerates then reads the new key off their own
// screen" loophole that would defeat the delivery-channel guarantee.
//
// All business rules (ownership check, body-field reject, delivery) live in
// lib/sub-agent-regenerate.ts so they can be unit-tested with a fake
// SupabaseClient + fake SMS/email senders — see
// scripts/test-subagent-regenerate.ts. This route only authenticates the
// caller, parses the body, and translates the result into the HTTP response.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { regenerateSubAgentKey } from '@/lib/sub-agent-regenerate'
import { sendSMS } from '@/lib/sms-service'
import { sendEmail } from '@/lib/email-service'

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        // ── 0. Origin check — this route mints real credentials (a
        //      regenerated access key), matching the defense-in-depth
        //      already applied to /api/auth/login. Not currently
        //      exploitable (auth cookie is SameSite=Lax), but cheap and
        //      consistent with established practice for sensitive POST
        //      routes. ─────────────────────────────────────────────────────
        if (!hasTrustedRequestOrigin(request)) {
            return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 })
        }

        // ── 1. Authenticate the recruiter ───────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { id: subUserId } = await params
        if (!subUserId) {
            return NextResponse.json({ success: false, error: 'Missing sub-agent id' }, { status: 400 })
        }

        // ── 2. Parse body — an email/phone key present AT ALL is rejected by
        //      lib/sub-agent-regenerate.ts (rule 3), so pass whatever was sent
        //      through unmodified rather than pre-filtering it here. ─────────
        let body: unknown = {}
        const rawText = await request.text()
        if (rawText.trim().length > 0) {
            try {
                body = JSON.parse(rawText)
            } catch {
                return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
            }
        }

        // ── 3. Business logic (service-role — sub_agents has no client write
        //      policies by design; see 20260701_sub_agents.sql) ──────────────
        const admin = createServerClient()
        const result = await regenerateSubAgentKey(admin, user.id, subUserId, body, {
            sendSms: sendSMS,
            sendEmail,
        })

        if (!result.success) {
            return NextResponse.json({ success: false, error: result.error }, { status: result.status })
        }

        // The new plaintext key is NEVER included here — it only ever reached
        // the sub-agent via SMS/email inside regenerateSubAgentKey.
        return NextResponse.json({ success: true, message: result.message })
    } catch (error) {
        console.error('[api/dashboard/subagents/[id]/regenerate] POST failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
