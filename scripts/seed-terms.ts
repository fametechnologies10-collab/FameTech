// Idempotent seed of the initial Terms & Conditions version + pointer keys.
// Run once against a database AFTER the 20260702 migration is applied:
//   npx tsx scripts/seed-terms.ts
// Requires the service-role Supabase env vars to be present.
import { createServerClient } from '@/lib/supabase'
import {
  INITIAL_SECTIONS,
  INITIAL_CHANGELOG,
  INITIAL_TERMS_VERSION,
  INITIAL_EFFECTIVE_DATE,
  INITIAL_REQUIRES_REACCEPTANCE,
} from '@/lib/terms-content'

async function main() {
  const db = createServerClient() as any

  // Clear any existing current flag, then upsert this version as current.
  await db.from('terms_versions').update({ is_current: false }).eq('is_current', true)
  const { error } = await db.from('terms_versions').upsert(
    {
      version: INITIAL_TERMS_VERSION,
      effective_date: INITIAL_TERMS_VERSION,
      sections: INITIAL_SECTIONS,
      changelog: INITIAL_CHANGELOG,
      requires_reacceptance: INITIAL_REQUIRES_REACCEPTANCE,
      is_current: true,
      published_at: new Date().toISOString(),
    },
    { onConflict: 'version' }
  )
  if (error) throw error

  // Refresh the cached pointer keys (admin_settings.value is JSONB).
  const pointer: Array<{ key: string; value: string }> = [
    { key: 'terms_current_version', value: INITIAL_TERMS_VERSION },
    { key: 'terms_effective_date', value: INITIAL_EFFECTIVE_DATE },
  ]
  if (INITIAL_REQUIRES_REACCEPTANCE) {
    pointer.push({ key: 'terms_min_acceptable_version', value: INITIAL_TERMS_VERSION })
  }
  for (const p of pointer) {
    await db.from('admin_settings').upsert({ key: p.key, value: p.value }, { onConflict: 'key' })
  }

  console.log('Seeded terms', INITIAL_TERMS_VERSION, `(${INITIAL_SECTIONS.length} sections)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
