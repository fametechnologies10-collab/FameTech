import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'

// Admin Terms Manager API. Admin-only (sub-admins rejected). Lets an admin edit
// and publish the agreement WITHOUT a redeploy: writes a terms_versions row, flips
// is_current, and refreshes the cached admin_settings version pointers.

export async function GET(request: NextRequest) {
  const auth = await validateAdminAccess(false, request)
  if (auth.error) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })
  const db = createServerClient() as any
  const { data, error } = await db
    .from('terms_versions')
    .select('id, version, effective_date, sections, changelog, requires_reacceptance, is_current, published_at, created_at')
    .order('created_at', { ascending: false })
  if (error) {
    console.error('[admin/terms] GET error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load versions' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: data ?? [] })
}

export async function POST(request: NextRequest) {
  const auth = await validateAdminAccess(false, request)
  if (auth.error) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

  const b = await request.json().catch(() => ({} as any))
  const version = String(b.version || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(version)) {
    return NextResponse.json({ success: false, error: 'version must be YYYY-MM-DD (optionally .N)' }, { status: 400 })
  }
  if (!Array.isArray(b.sections) || b.sections.length === 0) {
    return NextResponse.json({ success: false, error: 'sections are required' }, { status: 400 })
  }
  if (!b.effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.effective_date))) {
    return NextResponse.json({ success: false, error: 'effective_date must be YYYY-MM-DD' }, { status: 400 })
  }

  // Sanitise sections to the known shape (never trust the client blindly).
  const sections = (b.sections as any[]).map((s) => ({
    id: String(s.id || '').slice(0, 60),
    title: String(s.title || '').slice(0, 200),
    body: String(s.body || '').slice(0, 8000),
    ...(s.badge ? { badge: String(s.badge).slice(0, 40) } : {}),
    ...(s.scope === 'dashboard' ? { scope: 'dashboard' as const } : {}),
    ...(typeof s.storefront === 'string' && s.storefront.trim() ? { storefront: String(s.storefront).slice(0, 8000) } : {}),
  })).filter((s) => s.id && s.title && s.body)
  if (sections.length === 0) {
    return NextResponse.json({ success: false, error: 'sections must each have id, title and body' }, { status: 400 })
  }

  const requires = b.requires_reacceptance !== false
  // Sanitise changelog to a known shape (mirrors the sections sanitisation).
  const changelog = Array.isArray(b.changelog)
    ? (b.changelog as any[]).slice(0, 5).map((c) => ({
        version: String(c?.version || '').slice(0, 20),
        date: String(c?.date || '').slice(0, 40),
        summary: Array.isArray(c?.summary)
          ? (c.summary as any[]).slice(0, 12).map((s) => String(s).slice(0, 200))
          : [],
      }))
    : []
  const effectiveLabel = String(b.effective_date_label || b.effective_date).slice(0, 60)

  // Atomic publish (deactivate current + upsert new as current in one transaction).
  const db = createServerClient() as any
  const { error } = await db.rpc('publish_terms_version', {
    p_version: version,
    p_effective_date: b.effective_date,
    p_sections: sections,
    p_changelog: changelog,
    p_requires: requires,
    p_created_by: auth.user?.id ?? null,
  })
  if (error) {
    console.error('[admin/terms] publish error:', error)
    return NextResponse.json({ success: false, error: 'Failed to publish' }, { status: 500 })
  }

  // Refresh cached pointer keys. Bump min-acceptable only for material changes.
  const pointers: Record<string, string> = {
    terms_current_version: version,
    terms_effective_date: effectiveLabel,
  }
  if (requires) pointers.terms_min_acceptable_version = version
  for (const [key, value] of Object.entries(pointers)) {
    await db.from('admin_settings').upsert({ key, value }, { onConflict: 'key' })
  }

  return NextResponse.json({ success: true, data: { version, requires_reacceptance: requires } })
}
