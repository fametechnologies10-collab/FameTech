// Emits idempotent SQL to seed the initial terms version + pointer keys.
// Pure (no DB/env needed): npx tsx scripts/print-seed-sql.ts
import {
  INITIAL_SECTIONS,
  INITIAL_CHANGELOG,
  INITIAL_TERMS_VERSION,
  INITIAL_EFFECTIVE_DATE,
  INITIAL_REQUIRES_REACCEPTANCE,
} from '@/lib/terms-content'

const sections = JSON.stringify(INITIAL_SECTIONS)
const changelog = JSON.stringify(INITIAL_CHANGELOG)

const sql = `UPDATE public.terms_versions SET is_current = false WHERE is_current = true;
INSERT INTO public.terms_versions (version, effective_date, sections, changelog, requires_reacceptance, is_current, published_at)
VALUES ('${INITIAL_TERMS_VERSION}', '${INITIAL_TERMS_VERSION}', $sections$${sections}$sections$::jsonb, $changelog$${changelog}$changelog$::jsonb, ${INITIAL_REQUIRES_REACCEPTANCE}, true, now())
ON CONFLICT (version) DO UPDATE SET
  effective_date = EXCLUDED.effective_date,
  sections = EXCLUDED.sections,
  changelog = EXCLUDED.changelog,
  requires_reacceptance = EXCLUDED.requires_reacceptance,
  is_current = true,
  published_at = now();
INSERT INTO public.admin_settings (key, value) VALUES
  ('terms_current_version',        to_jsonb('${INITIAL_TERMS_VERSION}'::text)),
  ('terms_min_acceptable_version', to_jsonb('${INITIAL_TERMS_VERSION}'::text)),
  ('terms_effective_date',         to_jsonb('${INITIAL_EFFECTIVE_DATE}'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`

console.log(sql)
