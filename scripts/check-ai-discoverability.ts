// Run: npx tsx scripts/check-ai-discoverability.ts
import { readFileSync } from 'node:fs'
import { DEVELOPER_PRODUCTS, SITE, llmsTxt } from '../lib/developer-products'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` â€” ${detail}`}`)
}

const norm = (s: string) => s.replace(/\r\n/g, '\n')
const spec = norm(readFileSync('postman/specs/openapi.yaml', 'utf8'))
const publicSpec = norm(readFileSync('public/openapi.yaml', 'utf8'))

check('public/openapi.yaml matches postman/specs/openapi.yaml', spec === publicSpec, 're-copy the spec into public/')

const specPaths = new Set(
    [...spec.matchAll(/^  (\/[^\s:]*):\s*$/gm)].map(m => m[1]),
)
for (const p of DEVELOPER_PRODUCTS) {
    for (const e of p.endpoints) {
        check(`${p.slug}: ${e.method} ${e.path} exists in spec`, specPaths.has(e.path), 'path missing from openapi.yaml')
    }
}

const slugs = DEVELOPER_PRODUCTS.map(p => p.slug)
check('slugs are unique', new Set(slugs).size === slugs.length)

const txt = llmsTxt()
for (const p of DEVELOPER_PRODUCTS) {
    check(`llms.txt links ${p.slug}`, txt.includes(`${SITE}/developers/${p.slug}`))
}
check('llms.txt links the OpenAPI spec', txt.includes(`${SITE}/openapi.yaml`))

const banned = /datakazina|hubtel|spfastit|bundleportal|agentportal|ghdata|supabase|paystack/i
check('no supplier or infra names in public copy', !banned.test(txt + JSON.stringify(DEVELOPER_PRODUCTS)))
check('public spec has no supplier or infra names', !banned.test(publicSpec))

if (failed) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
}
console.log('\nAll checks passed')
