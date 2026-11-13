// Static guard: every supplier-confirmed completion site must stamp delivered_at via
// deliveredAtPatch(); non-supplier completion paths (auto-complete cron, admin manual,
// customer self-complete, airtime/utilities) must never touch it.
// Reads source text only (no app imports). Run: npx tsx scripts/test-delivery-stamp-sites.ts
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

// file -> minimum number of `deliveredAtPatch(` occurrences
const MUST_STAMP: Record<string, number> = {
    'app/api/webhooks/xpress/route.ts': 1,
    'app/api/webhooks/spfastit/route.ts': 2, // by-reference + by-id fallback
    'app/api/webhooks/ghdata/route.ts': 1,
    'app/api/webhooks/dakazina/route.ts': 1,
    'app/api/webhooks/hendylinks/route.ts': 1,
    'lib/agentportal-apply-outcome.ts': 2, // main update + failed->completed rescue
    'lib/bundleportal-apply-outcome.ts': 1,
    'lib/hendylinks-service.ts': 1,
    'app/api/cron/sync-xpress-status/route.ts': 1,
    'app/api/cron/sync-spfastit-status/route.ts': 1,
    'app/api/cron/sync-ghdata-status/route.ts': 1,
    'app/api/cron/sync-codecraft-status/route.ts': 1,
    'app/api/cron/sync-atishare-console-status/route.ts': 1,
    'app/api/admin/fulfillment/sync-xpress/route.ts': 1,
    'app/api/admin/fulfillment/sync-spfastit/route.ts': 1,
    'app/api/admin/fulfillment/sync-ghdata/route.ts': 1,
    'app/api/admin/fulfillment/sync-atishare-console/route.ts': 1,
    'app/api/admin/orders/sync-selection/route.ts': 1,
}

const MUST_NOT_STAMP = [
    'app/api/cron/auto-complete-data/route.ts',
    'lib/kingflexy-finalize.ts',
    'app/api/orders/confirm-received/route.ts', // customer/shop self-complete (thin route wrapper)
    'lib/order-complete-service.ts', // confirmOrderReceived -> claim_self_order_complete RPC (the real self-complete path)
    'app/api/admin/fulfillment/route.ts', // admin manual completion
]

const failures: string[] = []

for (const [file, min] of Object.entries(MUST_STAMP)) {
    let src: string
    try { src = read(file) } catch { failures.push(`${file}: file not found`); continue }
    const n = src.split('deliveredAtPatch(').length - 1
    if (n < min) failures.push(`${file}: expected >= ${min} deliveredAtPatch( call(s), found ${n}`)
}

for (const file of MUST_NOT_STAMP) {
    let src: string
    try { src = read(file) } catch { failures.push(`${file}: file not found`); continue }
    if (src.includes('delivered_at') || src.includes('deliveredAtPatch')) {
        failures.push(`${file}: must NOT reference delivered_at / deliveredAtPatch`)
    }
}

// Dakazina: runUpdate() updates BOTH orders and shop_orders; shop_orders has no delivered_at
// column, so the patch must be applied only when table === 'orders'.
try {
    const dk = read('app/api/webhooks/dakazina/route.ts')
    const start = dk.indexOf('async function runUpdate(')
    const end = start >= 0 ? dk.indexOf('// ── orders table', start) : -1
    const body = start >= 0 && end > start ? dk.slice(start, end) : ''
    const conditional = /table\s*===\s*'orders'\s*\?\s*deliveredAtPatch\(/.test(body)
    const bare = /\.update\(\{[^}]*\.\.\.deliveredAtPatch\(/.test(body)
    if (!body) failures.push('dakazina: could not locate runUpdate()')
    else if (!conditional) failures.push("dakazina: runUpdate must apply `table === 'orders' ? deliveredAtPatch(...) : {}`")
    else if (bare) failures.push('dakazina: deliveredAtPatch applied unconditionally inside .update({...})')
} catch { failures.push('dakazina: file not found') }

if (failures.length) {
    console.error('delivery-stamp-sites: FAILED\n' + failures.map(f => '  - ' + f).join('\n'))
    process.exit(1)
}
console.log('delivery-stamp-sites: all checks passed')
