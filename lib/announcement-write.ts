import { sanitizeCtaUrl } from '@/lib/announcement-cta'
import { overlappingScopes } from '@/lib/announcement-visibility'

const VALID_VISIBLE_ON = ['main_site', 'storefronts', 'both']
const VALID_MODE = ['draft', 'publish', 'schedule']

export function buildAnnouncementColumns(body: any): {
  columns: Record<string, any> | null; pushPrimaryUrl: string | null; error?: string
} {
  const title = String(body?.title ?? '').trim()
  const message = String(body?.message ?? '').trim()
  const visibleOn = body?.visibleOn ?? 'main_site'
  const mode = body?.mode ?? 'publish'
  if (!title || !message) return { columns: null, pushPrimaryUrl: null, error: 'Missing title or message' }
  // Hard server-side caps (UI caps are 80/1000) — stop a raw API call from amplifying
  // unbounded text into every subscriber's notification row + push payload.
  if (title.length > 100) return { columns: null, pushPrimaryUrl: null, error: 'Title is too long (max 100 characters)' }
  if (message.length > 2000) return { columns: null, pushPrimaryUrl: null, error: 'Message is too long (max 2000 characters)' }
  if (!VALID_VISIBLE_ON.includes(visibleOn)) return { columns: null, pushPrimaryUrl: null, error: 'Invalid visibleOn' }
  if (!VALID_MODE.includes(mode)) return { columns: null, pushPrimaryUrl: null, error: 'Invalid mode' }

  function cta(label: any, url: any): { label: string | null; url: string | null } | string {
    const l = String(label ?? '').trim()
    if (!l) return { label: null, url: null }
    const u = sanitizeCtaUrl(url)
    if (!u) return `Button "${l}" has an invalid link (must be https, tel, or mailto)`
    return { label: l, url: u }
  }
  const p = cta(body?.ctaPrimaryLabel, body?.ctaPrimaryUrl)
  if (typeof p === 'string') return { columns: null, pushPrimaryUrl: null, error: p }
  const s = cta(body?.ctaSecondaryLabel, body?.ctaSecondaryUrl)
  if (typeof s === 'string') return { columns: null, pushPrimaryUrl: null, error: s }

  let is_active = false, status = 'draft', scheduled_at: string | null = null
  if (mode === 'publish') { is_active = true; status = 'published' }
  else if (mode === 'schedule') {
    status = 'scheduled'
    const ts = new Date(body?.scheduledAt)
    if (isNaN(ts.getTime()) || ts.getTime() < Date.now()) {
      return { columns: null, pushPrimaryUrl: null, error: 'scheduledAt must be a future date' }
    }
    scheduled_at = ts.toISOString()
  }

  return {
    columns: {
      title, message, visible_on: visibleOn, is_active, status, scheduled_at,
      cta_primary_label: p.label, cta_primary_url: p.url,
      cta_secondary_label: s.label, cta_secondary_url: s.url,
    },
    pushPrimaryUrl: p.url,
  }
}

/**
 * Best-effort: deactivate every active shop-level announcement so a published
 * system announcement targeting storefronts takes precedence. Never throws —
 * a failure here must not block the announcement write.
 */
export async function deactivateShopAnnouncements(supabase: any): Promise<void> {
  const { error } = await supabase
    .from('shop_announcements')
    .update({ is_active: false })
    .eq('is_active', true)
  if (error) console.error('[announce] shop deactivate error:', error)
}

/**
 * Enforce "one active announcement per surface": when `keepId` becomes active with
 * `scope`, deactivate every OTHER active system announcement whose popup surface
 * overlaps it. A main_site notice and a storefronts notice can coexist; a 'both'
 * replaces everything. Best-effort + logged — never blocks the write.
 */
export async function deactivateOverlappingActive(
  supabase: any, scope: string, keepId: string
): Promise<void> {
  const { error } = await supabase
    .from('system_announcements')
    .update({ is_active: false })
    .eq('is_active', true)
    .neq('id', keepId)
    .in('visible_on', overlappingScopes(scope))
  if (error) console.error('[announce] deactivate overlapping active error:', error)
}
