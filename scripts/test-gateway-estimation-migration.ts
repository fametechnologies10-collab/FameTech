import { readFileSync } from 'fs'
import { join } from 'path'

const FILE = join(process.cwd(), 'supabase', 'migrations', '20261114_gateway_estimation.sql')
// Strip -- comments, collapse whitespace, lowercase.
const sql = readFileSync(FILE, 'utf8')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()

function ok(cond: boolean, msg: string) {
    if (!cond) throw new Error(`FAIL: ${msg}`)
}
function has(s: string, needle: string, msg: string) {
    ok(s.includes(needle.toLowerCase()), `${msg} (missing: ${needle})`)
}
function hasRe(s: string, re: RegExp, msg: string) {
    ok(re.test(s), `${msg} (no match: ${re})`)
}

// ---- Overrides table ----
has(sql, 'create table if not exists public.gateway_status_overrides', 'overrides table')
for (const ch of ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'standard_bundles']) {
    has(sql, `'${ch}'`, `channel ${ch}`)
}
hasRe(sql, /channel text primary key check \(channel in \([^)]*\)\)/, 'channel PK with CHECK')
has(sql, 'alter table public.gateway_status_overrides enable row level security', 'RLS enabled')
ok(!/create policy[^;]*gateway_status_overrides/.test(sql), 'no CREATE POLICY on overrides')
hasRe(sql, /revoke all on (table )?public\.gateway_status_overrides from (public, )?anon, authenticated/, 'table REVOKE')
const seeds = sql.match(/insert into public\.gateway_status_overrides/g) ?? []
ok(seeds.length === 1 || seeds.length === 5, 'seed insert present')
const seedStart = sql.indexOf('insert into public.gateway_status_overrides')
const seedText = sql.slice(seedStart, sql.indexOf(';', seedStart))
ok((seedText.match(/\('[^']+'\)/g) ?? []).length === 5, 'exactly 5 seed rows')
has(seedText, 'on conflict do nothing', 'seed ON CONFLICT DO NOTHING')

// ---- Indexes ----
for (const idx of ['idx_orders_gw_completed', 'idx_orders_gw_open', 'idx_sbo_gw_completed', 'idx_sbo_gw_open']) {
    has(sql, `create index if not exists ${idx} on`, `index ${idx}`)
}

// ---- Function header / ACL ----
const fnStart = sql.indexOf('create or replace function public.get_gateway_signals()')
ok(fnStart >= 0, 'get_gateway_signals defined')
const fn = sql.slice(fnStart)
has(fn, 'security invoker', 'SECURITY INVOKER')
ok(!fn.includes('security definer'), 'not SECURITY DEFINER')
has(fn, 'set search_path = public', 'search_path pinned')
has(fn, 'revoke all on function public.get_gateway_signals() from public, anon, authenticated', 'function REVOKE')
has(fn, 'grant execute on function public.get_gateway_signals() to service_role', 'function GRANT service_role')
ok(!/grant execute on function public\.get_gateway_signals\(\) to [^;]*(anon|authenticated|public)/.test(fn), 'no GRANT to anon/authenticated/public')

// ---- Lateral slicing by alias markers ----
const body = fn.slice(0, fn.indexOf('$$', fn.indexOf('$$') + 2))
const iCo = body.indexOf(') co on true')
const iCb = body.indexOf(') cb on true')
const iPo = body.indexOf(') po on true')
const iPb = body.indexOf(') pb on true')
ok(iCo > 0 && iCb > iCo && iPo > iCb && iPb > iPo, 'laterals co, cb, po, pb in order')
const coT = body.slice(body.lastIndexOf('left join lateral', iCo), iCo)
const cbT = body.slice(body.lastIndexOf('left join lateral', iCb), iCb)
const poT = body.slice(body.lastIndexOf('left join lateral', iPo), iPo)
const pbT = body.slice(body.lastIndexOf('left join lateral', iPb), iPb)
const predicate = (t: string) => t.slice(t.indexOf(' where '))

// C laterals
for (const [name, t] of [['co', coT], ['cb', cbT]] as const) {
    has(t, "interval '24 hours'", `${name} 24h window`)
    hasRe(t, /order by [a-z]\.created_at desc/, `${name} ordered by created_at DESC`)
    const ob = t.slice(t.indexOf('order by'))
    ok(!/delivered_at|completed_at/.test(ob), `${name} ORDER BY not on delivered/completed`)
}
for (const m of ["retry_count = 0", "retry_of_order_id is null", "category = 'data'", 'delivered_at is not null']) {
    has(predicate(coT), m, `co predicate`)
}
has(predicate(cbT), 'completed_at is not null', 'cb predicate')

// P orders lateral (anchored on co.created_at, never delivery time)
const poP = predicate(poT)
has(poP, 'created_at > co.created_at', 'po anchored on co.created_at')
has(poP, "status in ('pending', 'processing')", 'po open statuses')
for (const m of ["payment_status = 'paid'", 'retry_count = 0', 'retry_of_order_id is null', "category = 'data'"]) {
    has(poP, m, 'po predicate')
}
ok(!/delivered_at|completed_at/.test(poP), 'po predicate has no delivered_at/completed_at')
ok(!poT.includes('queued'), "po has no 'queued'")
hasRe(poT, /order by [a-z]\.created_at asc/, 'po oldest first')

// P standard-bundles lateral: no payment/retry/category columns
const pbP = predicate(pbT)
has(pbP, "status in ('pending', 'processing')", 'pb open statuses')
has(pbP, 'created_at > cb.created_at', 'pb anchored on cb.created_at')
ok(!/delivered_at|completed_at/.test(pbP), 'pb predicate has no delivered_at/completed_at')
ok(!pbT.includes('queued'), "pb has no 'queued'")

// ---- Old function untouched ----
ok(!/drop\s+function[^;]*get_gateway_delivery_stats/.test(sql), 'never drops get_gateway_delivery_stats')
ok(!/\bdrop\b/.test(sql), 'migration has no DROP statements at all')

console.log('gateway-estimation-migration: all checks passed')
