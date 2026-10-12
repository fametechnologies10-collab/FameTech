// Pure-logic test: the shared text validators must reject real script-injection payloads
// and accept ordinary shop copy. Run: npx tsx scripts/test-validation-text.ts
import { shortTextSchema, longTextSchema, adminLongTextSchema, urlSchema } from '../lib/validation'

let failed = 0
function check(name: string, ok: boolean) {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: string) => schema.safeParse(v).success

// ── Ordinary shop copy that the old substring regex wrongly rejected ──────────
const prose = [
    'Cheap Data: MTN, Telecel & AT',
    'Cheap Data: MTN, Telecel and AT',
    'Best data deals - data: 1GB/2GB bundles',
    'Product description goes here',
    'Monthly subscription plans',
    'Order transcript available on request',
    'Manuscript printing and data bundles',
    'Download our app',
    'Prescription reminders',
]
for (const p of prose) {
    if (!p.includes('&')) check(`shortTextSchema accepts: ${p}`, accepts(shortTextSchema, p))
    check(`adminLongTextSchema accepts: ${p}`, accepts(adminLongTextSchema, p))
}

// ── Real payloads must still be blocked everywhere ────────────────────────────
const payloads = [
    '<script>alert(1)</script>',
    '< script >alert(1)</ script>',
    '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
    'javascript:alert(1)',
    'JaVaScRiPt : alert(1)',
    'vbscript:msgbox(1)',
    '<img src=x onerror=alert(1)>',
    '<body onload = alert(1)>',
    '<a onclick=steal()>x</a>',
    '<div onmouseover="x()">',
    '<input onfocus=alert(1) autofocus>',
    '<div onmouseenter = x()>',
    '<svg onpointerdown=x()>',
    'eval(atob("..."))',
    'eval  (1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data: text/html,<b>',
    'data:application/javascript,alert(1)',
    'data:image/svg+xml;base64,AAAA',
]
for (const p of payloads) {
    check(`adminLongTextSchema blocks: ${p}`, !accepts(adminLongTextSchema, p))
    check(`longTextSchema blocks: ${p}`, !accepts(longTextSchema, p))
}

// ── User-facing schemas still reject raw HTML metacharacters outright ─────────
check('shortTextSchema rejects <>', !accepts(shortTextSchema, 'a<b'))
check('shortTextSchema rejects &', !accepts(shortTextSchema, 'A & B'))
check('adminLongTextSchema allows & and < (math/comparisons)', accepts(adminLongTextSchema, 'GHS 5 < GHS 10 & free'))

// ── urlSchema: https only, no script vectors ──────────────────────────────────
check('urlSchema accepts https', accepts(urlSchema, 'https://chat.whatsapp.com/abc123'))
check('urlSchema rejects http', !accepts(urlSchema, 'http://example.com'))
check('urlSchema rejects javascript:', !accepts(urlSchema, 'javascript:alert(1)'))
check('urlSchema rejects data:', !accepts(urlSchema, 'data:text/html,<b>'))

if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
}
console.log('\nAll validation-text checks passed')
