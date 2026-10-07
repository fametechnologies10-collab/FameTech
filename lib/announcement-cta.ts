export type CtaKind = 'whatsapp' | 'telegram' | 'call' | 'email' | 'link'
export type AnnouncementCta = { label: string; url: string }

const SAFE_SCHEMES = ['https:', 'tel:', 'mailto:'] as const

/** Returns the trimmed URL only when its scheme is safe; otherwise null. */
export function sanitizeCtaUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = String(raw).trim()
  if (!v) return null
  // tel:/mailto: are opaque — check by prefix; https via URL parse.
  const lower = v.toLowerCase()
  if (lower.startsWith('tel:')) return /^tel:[+0-9().\-\s]+$/i.test(v) ? v : null
  if (lower.startsWith('mailto:')) return /^mailto:[^\s<>]+@[^\s<>]+$/i.test(v) ? v : null
  try {
    const u = new URL(v)
    if (!SAFE_SCHEMES.includes(u.protocol as typeof SAFE_SCHEMES[number])) return null
    if (u.protocol !== 'https:') return null // only https among URL-shaped inputs
    return u.toString().replace(/\/$/, v.endsWith('/') ? '/' : '')
  } catch {
    return null
  }
}

export function getCtaMeta(url: string): { kind: CtaKind; domain: string } {
  const lower = url.toLowerCase()
  if (lower.startsWith('tel:')) return { kind: 'call', domain: 'Phone' }
  if (lower.startsWith('mailto:')) return { kind: 'email', domain: 'Email' }
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { host = '' }
  if (/(^|\.)wa\.me$|whatsapp\.com$/.test(host)) return { kind: 'whatsapp', domain: host }
  if (/(^|\.)t\.me$|telegram\.me$|telegram\.org$/.test(host)) return { kind: 'telegram', domain: host }
  return { kind: 'link', domain: host || 'link' }
}

type RawCtaRow = {
  cta_primary_label?: string | null
  cta_primary_url?: string | null
  cta_secondary_label?: string | null
  cta_secondary_url?: string | null
}

function one(label?: string | null, url?: string | null): AnnouncementCta | null {
  const l = (label ?? '').trim()
  const u = sanitizeCtaUrl(url)
  return l && u ? { label: l, url: u } : null
}

export function resolveCtas(row: RawCtaRow): {
  primary: AnnouncementCta | null
  secondary: AnnouncementCta | null
} {
  return {
    primary: one(row.cta_primary_label, row.cta_primary_url),
    secondary: one(row.cta_secondary_label, row.cta_secondary_url),
  }
}

/**
 * Distinct, reusable CTA buttons harvested from existing announcement rows
 * (primary + secondary) so an admin can re-pick a previously-used button instead
 * of re-typing it. Deduped by label+url; input order is preserved, so passing
 * newest-first rows yields most-recent-first buttons.
 */
export function collectSavedButtons(rows: RawCtaRow[]): AnnouncementCta[] {
  const seen = new Set<string>()
  const out: AnnouncementCta[] = []
  for (const row of rows) {
    const { primary, secondary } = resolveCtas(row)
    for (const b of [primary, secondary]) {
      if (!b) continue
      const key = `${b.label.toLowerCase()}||${b.url}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(b)
    }
  }
  return out
}
