import { NextResponse } from 'next/server'
import { createServerAnonClient } from '@/lib/supabase'
import { FALLBACK_TERMS_VERSION, FALLBACK_EFFECTIVE_DATE } from '@/lib/terms'

// Public endpoint — read by the /terms page, the dashboard gate, and the
// storefront guest gate. Cached 60s; an admin publish propagates within a minute.
export const revalidate = 60

export async function GET() {
  try {
    const db = createServerAnonClient() as any
    const [{ data: cur }, { data: settings }] = await Promise.all([
      db.from('terms_versions')
        .select('version, effective_date, sections, changelog')
        .eq('is_current', true)
        .maybeSingle(),
      db.from('admin_settings')
        .select('key, value')
        .in('key', ['terms_min_acceptable_version']),
    ])

    const min =
      (settings?.find((s: any) => s.key === 'terms_min_acceptable_version')?.value as string) ||
      cur?.version ||
      FALLBACK_TERMS_VERSION

    return NextResponse.json({
      success: true,
      data: {
        version: cur?.version ?? FALLBACK_TERMS_VERSION,
        effectiveDate: cur?.effective_date ?? FALLBACK_EFFECTIVE_DATE,
        minAcceptableVersion: min,
        changelog: (cur?.changelog ?? []).slice(0, 5),
        sections: cur?.sections ?? [],
      },
    })
  } catch (err) {
    console.error('[terms/current] error:', err)
    return NextResponse.json({ success: false, error: 'Failed to load terms' }, { status: 500 })
  }
}
