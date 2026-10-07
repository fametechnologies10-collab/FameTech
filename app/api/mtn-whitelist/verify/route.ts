import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { getClientIp } from '@/lib/api-auth'
import { checkMtnWhitelistLimit } from '@/lib/mtn-whitelist-ratelimit'
import { normalizeMtnBatch, MAX_MSISDNS_PER_REQUEST } from '@/lib/agentportal-whitelist'
import { verifyMtnWhitelistMerged } from '@/lib/mtn-whitelist-merge'
import { isWhitelistServer, verifyMtnWhitelistServer } from '@/lib/mtn-whitelist-server-check'

// POST /api/mtn-whitelist/verify
//
// Checks MTN numbers against the whitelist. Body `server` (1 | 2) checks that one server only
// (the checker UI's tabs); omitting it returns the merged result the purchase gate uses.
// Every number a server reports `allowed: false` is auto-submitted to MTN for enabling, so this
// route has a real outward side effect even though it moves no money — the caps and rate
// limits below are what bound it.
//
// Deliberately reachable BOTH signed-in (dashboard, bulk up to 1000) and as a guest
// (storefront, single number). Guests get a much tighter allowance, since they are only ever
// checking the one number they are about to buy for.
//
// Server 2 (Bundle Portal) has no bulk verify_number endpoint — a large `server: 2` batch is
// fanned out one HTTP call per number in sequential chunks (lib/bundleportal-whitelist.ts) and
// can run close to this project's default 60s function ceiling (vercel.json). Overridden here
// as a safety margin so a slow large batch finishes instead of being killed mid-request.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Guests may only check the number they are buying for — never a batch. */
const GUEST_MAX_MSISDNS = 3

/**
 * Hard ceiling on how many raw entries we will even parse, independent of how many survive
 * validation. Without this, a 100k-element array of junk would be fully walked just to be
 * thrown away. Slightly above the real cap so an over-cap request gets a clear error rather
 * than looking malformed.
 */
const MAX_RAW_ENTRIES = MAX_MSISDNS_PER_REQUEST + 50

function bad(message: string, status: number) {
    return NextResponse.json({ success: false, error: message }, { status })
}

export async function POST(request: NextRequest) {
    // ── Auth tier ────────────────────────────────────────────────────────────────
    // No session is not an error here — it just drops the caller to the guest tier.
    let userId: string | null = null
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        userId = user?.id ?? null
    } catch {
        userId = null
    }

    const authenticated = userId !== null
    const ip = getClientIp(request)

    // A guest we cannot identify cannot be rate limited, and this route has an outward
    // side effect on MTN's queue — refuse rather than hand out an unlimited allowance.
    if (!authenticated && !ip) {
        return bad('Could not verify your request. Please try again.', 400)
    }

    // ── Rate limit (before any upstream call) ────────────────────────────────────
    const allowed = await checkMtnWhitelistLimit(userId ?? ip!, authenticated)
    if (!allowed) {
        return bad('Too many whitelist checks. Please wait a few minutes and try again.', 429)
    }

    // ── Body ─────────────────────────────────────────────────────────────────────
    let body: unknown
    try {
        body = await request.json()
    } catch {
        return bad('Invalid request body', 400)
    }

    const rawMsisdns = (body as { msisdns?: unknown })?.msisdns
    if (!Array.isArray(rawMsisdns)) {
        return bad('msisdns must be an array of phone numbers', 400)
    }

    const rawServer = (body as { server?: unknown })?.server
    if (rawServer !== undefined && !isWhitelistServer(rawServer)) {
        return bad('server must be 1 or 2', 400)
    }
    if (rawMsisdns.length === 0) {
        return bad('Enter at least one number to check', 400)
    }
    if (rawMsisdns.length > MAX_RAW_ENTRIES) {
        return bad(`You can check at most ${MAX_MSISDNS_PER_REQUEST} numbers at a time`, 400)
    }

    const cap = authenticated ? MAX_MSISDNS_PER_REQUEST : GUEST_MAX_MSISDNS
    if (rawMsisdns.length > cap) {
        return bad(
            authenticated
                ? `You can check at most ${MAX_MSISDNS_PER_REQUEST} numbers at a time`
                : `Sign in to check more than ${GUEST_MAX_MSISDNS} numbers at once`,
            400
        )
    }

    // ── Validate locally BEFORE forwarding ───────────────────────────────────────
    // Nothing that fails here is ever sent upstream: a non-MTN number would be submitted to
    // MTN as a whitelist request for a number MTN cannot whitelist.
    const { valid, invalid } = normalizeMtnBatch(rawMsisdns)

    if (valid.length === 0) {
        return NextResponse.json({
            success: true,
            data: { results: [], invalid, allowed_count: 0, total: 0, checked: 0 },
        })
    }

    const verification = rawServer === undefined
        ? await verifyMtnWhitelistMerged(valid)
        : await verifyMtnWhitelistServer(rawServer, valid)

    if (verification.error) {
        // Upstream failure — surface it rather than reporting a partial/empty check as a
        // success, which would read as "none of your numbers are whitelisted".
        // Generic on purpose: the raw upstream error can name a supplier, and supplier names
        // must never reach end users.
        return bad(
            rawServer === undefined
                ? 'Could not check that number right now. Please try again shortly.'
                : `Server ${rawServer} could not check that number right now. Please try again shortly.`,
            502
        )
    }

    return NextResponse.json({
        success: true,
        data: {
            results: verification.results,
            invalid,
            allowed_count: verification.allowed_count,
            total: verification.total,
            checked: valid.length,
        },
    })
}
