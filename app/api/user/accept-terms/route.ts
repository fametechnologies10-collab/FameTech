import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

// Records the caller's acceptance of a terms version. Writes are scoped to the
// authenticated user's own row (RLS self-update on users) plus an append-only
// row in terms_acceptances (IP + user-agent) for a legal audit trail.
export async function POST(request: NextRequest) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 })
    }

    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const rl = consumeRateLimit(`accept-terms:${user.id}`, 10, 60 * 1000)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 })
    }

    const body = await request.json().catch(() => ({}))
    const version = typeof (body as any).version === 'string' ? (body as any).version.slice(0, 20) : ''
    if (!/^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(version)) {
      return NextResponse.json({ success: false, error: 'Invalid version' }, { status: 400 })
    }

    // Confirm the submitted version is actually the current one (prevents recording
    // acceptance of a stale/forged version).
    const { data: cur } = await (supabase as any)
      .from('terms_versions').select('version').eq('is_current', true).maybeSingle()
    if (cur?.version && cur.version !== version) {
      return NextResponse.json({ success: false, error: 'Terms version out of date, please reload' }, { status: 409 })
    }

    const nowIso = new Date().toISOString()
    // Prefer the platform-verified client IP; x-forwarded-for's FIRST hop is client-spoofable,
    // so fall back to its LAST entry (nearest trusted proxy) rather than the first.
    const ip = request.headers.get('x-real-ip')
      || request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
      || null
    const ua = request.headers.get('user-agent')?.slice(0, 400) || null

    // RLS self-update on users (auth.uid() = id) — never touches another account.
    const { data: row, error: upErr } = await (supabase as any)
      .from('users')
      .update({ terms_accepted_version: version, terms_accepted_at: nowIso, updated_at: nowIso })
      .eq('id', user.id)
      .select('id')
      .maybeSingle()
    if (upErr) {
      console.error('[accept-terms] users update:', upErr)
      return NextResponse.json({ success: false, error: 'Failed to record acceptance' }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
    }

    // Append-only audit row (RLS insert policy: auth.uid() = user_id). Non-fatal.
    const { error: logErr } = await (supabase as any)
      .from('terms_acceptances')
      .insert({ user_id: user.id, version, accepted_at: nowIso, ip_address: ip, user_agent: ua })
    if (logErr) console.error('[accept-terms] audit insert (non-fatal):', logErr)

    return NextResponse.json({ success: true, data: { version } })
  } catch (err) {
    console.error('[accept-terms] error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
