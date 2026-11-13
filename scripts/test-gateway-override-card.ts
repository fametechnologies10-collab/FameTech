import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

let failed = 0
function check(name: string, ok: boolean) {
    if (ok) console.log('PASS', name)
    else { console.error('FAIL', name); failed++ }
}

const root = process.cwd()
const compPath = join(root, 'components/admin/gateway-status/GatewayOverrideCard.tsx')
const pagePath = join(root, 'app/admin/fulfillment/page.tsx')

check('component file exists', existsSync(compPath))
if (existsSync(compPath)) {
    const src = readFileSync(compPath, 'utf8')
    check("imports from '@/lib/gateway-override-shared'", src.includes("from '@/lib/gateway-override-shared'"))
    for (const bad of ['gateway-overrides', 'supabase-admin', 'supabase-server', 'next/headers', '@/lib/supabase']) {
        const importsBad = src.split('\n').some(l => /^\s*import\b/.test(l) && l.includes(bad) && !l.includes('gateway-override-shared'))
        check(`no server import: ${bad}`, !importsBad)
    }
    check("imports toast from '@/lib/toast'", src.includes("import { toast } from '@/lib/toast'"))
    check('never imports sonner', !src.includes('sonner'))
    check('has role="switch"', src.includes('role="switch"'))
    check('has aria-checked', src.includes('aria-checked'))
    check('has maxLength={200}', src.includes('maxLength={200}'))
    check('fetches override path', src.includes('/api/admin/gateway-status/override'))
    check('uses GET', /method: 'GET'/.test(src))
    check('uses POST', /method:\s*'POST'/.test(src))
    check('no console.log', !src.includes('console.log'))
    check('no dangerouslySetInnerHTML', !src.includes('dangerouslySetInnerHTML'))
    check('no hard-coded dark colours', !/bg-black|bg-gray-9|bg-slate-9/.test(src))
}
const page = readFileSync(pagePath, 'utf8')
check('page imports card once', (page.match(/import \{ GatewayOverrideCard \}/g) || []).length === 1)
check('page mounts card once', (page.match(/<GatewayOverrideCard \/>/g) || []).length === 1)

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1) }
console.log('All checks passed')
