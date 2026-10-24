import {
    KfBreaker,
    describeKfFailure,
    kfRequest,
    toLocalPhone,
    type KfSendOutcome,
} from '@/lib/kingflexy-commission-service'
import {
    classifyBundlePurchase,
    mapKfBundleStatus,
    parseCatalog,
    type BundleKind,
} from '@/lib/standard-bundles-logic'

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

type CatalogNetwork = 'MTN' | 'Telecel' | 'AT'
type ParsedCatalog = ReturnType<typeof parseCatalog>

export interface PurchaseArgs {
    kind: BundleKind
    network: string
    phone: string
    reference: string
    value?: string
    amount?: number
    packId?: string
}

// value / pack_id are forwarded exactly as the catalog gave them.
export function buildPurchaseBody(args: PurchaseArgs): Record<string, unknown> {
    const beneficiary_phone = toLocalPhone(args.phone)
    if (args.kind === 'special') {
        return { pack_id: args.packId, beneficiary_phone, reference: args.reference }
    }
    if (args.kind === 'broadband') {
        return {
            network: 'TelecelBroadband',
            beneficiary_phone,
            amount: Number(Number(args.amount).toFixed(2)),
            reference: args.reference,
        }
    }
    return {
        network: args.network,
        beneficiary_phone,
        value: args.value,
        amount: args.amount,
        reference: args.reference,
    }
}

export const CATALOG_TTL_MS = 15 * 60 * 1000

export function isCatalogFresh(fetchedAtIso: string | null | undefined, now: number): boolean {
    if (!fetchedAtIso) return false
    const t = Date.parse(fetchedAtIso)
    if (!Number.isFinite(t)) return false
    const age = now - t
    return age >= 0 && age < CATALOG_TTL_MS
}

// ---------------------------------------------------------------------------
// Catalog (memory + persisted admin_settings copy)
// ---------------------------------------------------------------------------

const KF_BASE_URL = 'https://api.kingflexygh.com/api/v2'
const KF_TIMEOUT_MS = 20_000

interface StoredCatalog {
    etag: string | null
    fetched_at: string
    body: unknown // raw API `data` object
}

// Newer fetched_at wins; `a` (persisted) wins ties and unparseable dates.
export function pickNewerCatalogCopy<T extends { fetched_at: string }>(a: T | null, b: T | null): T | null {
    if (!a) return b
    if (!b) return a
    const ta = Date.parse(a.fetched_at)
    const tb = Date.parse(b.fetched_at)
    return Number.isFinite(tb) && (!Number.isFinite(ta) || tb > ta) ? b : a
}

export interface CatalogResult {
    ok: boolean
    stale: boolean
    data: ParsedCatalog | null
    error?: string
}

const memCache = new Map<CatalogNetwork, { stored: StoredCatalog; parsed: ParsedCatalog }>()
const inflight = new Map<CatalogNetwork, Promise<CatalogResult>>()

function settingsKey(network: CatalogNetwork): string {
    return `std_bundles_catalog_${network.toLowerCase()}`
}

async function adminDb() {
    // Lazy so the pure helpers above stay importable from plain tsx tests.
    const { createServerClient } = await import('@/lib/supabase')
    return createServerClient() as any
}

function isStored(v: any): v is StoredCatalog {
    return !!v && typeof v === 'object' && typeof v.fetched_at === 'string' && v.body !== undefined
}

async function readPersisted(network: CatalogNetwork): Promise<StoredCatalog | null> {
    try {
        const db = await adminDb()
        const { data } = await db.from('admin_settings').select('value').eq('key', settingsKey(network)).maybeSingle()
        return isStored(data?.value) ? data.value : null
    } catch {
        return null
    }
}

async function writePersisted(network: CatalogNetwork, stored: StoredCatalog): Promise<void> {
    try {
        const db = await adminDb()
        await db.from('admin_settings').upsert({ key: settingsKey(network), value: stored }, { onConflict: 'key' })
    } catch {
        // Persistence is best-effort; memory cache still serves.
    }
}

function remember(network: CatalogNetwork, stored: StoredCatalog): ParsedCatalog {
    const parsed = parseCatalog(network, { data: stored.body })
    memCache.set(network, { stored, parsed })
    return parsed
}

async function refreshCatalog(network: CatalogNetwork): Promise<CatalogResult> {
    const base = pickNewerCatalogCopy(await readPersisted(network), memCache.get(network)?.stored ?? null)
    if (base && isCatalogFresh(base.fetched_at, Date.now())) {
        return { ok: true, stale: false, data: remember(network, base) }
    }

    const fallback = (error: string): CatalogResult =>
        base
            ? { ok: true, stale: true, data: remember(network, base), error }
            : { ok: false, stale: false, data: null, error }

    const apiKey = process.env.KINGFLEXY_COMMISSION_API_KEY || undefined
    if (!apiKey) return fallback('KingFlexyGH not configured')

    try {
        const res = await fetch(`${KF_BASE_URL}/bundles/catalog?network=${encodeURIComponent(network)}`, {
            method: 'GET',
            headers: {
                Authorization: apiKey,
                Accept: 'application/json',
                ...(base?.etag ? { 'If-None-Match': base.etag } : {}),
            },
            signal: AbortSignal.timeout(KF_TIMEOUT_MS),
        })

        if (res.status === 304 && base) {
            const renewed: StoredCatalog = { ...base, fetched_at: new Date().toISOString() }
            await writePersisted(network, renewed)
            return { ok: true, stale: false, data: remember(network, renewed) }
        }

        const json = await res.json().catch(() => null)
        if (!res.ok || !json || json.success !== true || !json.data || typeof json.data !== 'object') {
            return fallback(`KingFlexyGH catalog error (HTTP ${res.status})`)
        }

        const fresh: StoredCatalog = {
            etag: res.headers.get('etag'),
            fetched_at: new Date().toISOString(),
            body: json.data,
        }
        await writePersisted(network, fresh)
        return { ok: true, stale: false, data: remember(network, fresh) }
    } catch (err) {
        return fallback(describeKfFailure(err, apiKey))
    }
}

export async function getBundleCatalog(network: CatalogNetwork): Promise<CatalogResult> {
    const mem = memCache.get(network)
    if (mem && isCatalogFresh(mem.stored.fetched_at, Date.now())) {
        return { ok: true, stale: false, data: mem.parsed }
    }
    const existing = inflight.get(network)
    if (existing) return existing
    const p = refreshCatalog(network).finally(() => inflight.delete(network))
    inflight.set(network, p)
    return p
}

// ---------------------------------------------------------------------------
// Purchase + order lookup
// ---------------------------------------------------------------------------

const purchaseBreaker = new KfBreaker()

export async function purchaseBundle(args: PurchaseArgs): Promise<{
    outcome: ReturnType<typeof classifyBundlePurchase>
    kfOrderRef?: string
    status?: ReturnType<typeof mapKfBundleStatus>
    error?: string
    raw?: unknown
}> {
    const apiKey = process.env.KINGFLEXY_COMMISSION_API_KEY || undefined
    if (!apiKey) return { outcome: 'config_error', error: 'KingFlexyGH not configured' }
    if (purchaseBreaker.isOpen()) return { outcome: 'transient', error: 'KingFlexyGH bundles circuit open' }

    try {
        const res = await kfRequest('POST', '/bundles/purchase', apiKey, buildPurchaseBody(args))
        const outcome = classifyBundlePurchase(res.status, res.body)
        const breakerOutcome: KfSendOutcome | null =
            outcome === 'accepted' || outcome === 'duplicate'
                ? 'accepted'
                : outcome === 'transient' || outcome === 'config_error'
                  ? outcome
                  : null
        if (breakerOutcome) purchaseBreaker.record(breakerOutcome)

        if (outcome === 'accepted' || outcome === 'duplicate') {
            const data = res.body?.data
            return {
                outcome,
                kfOrderRef: data?.order_reference != null ? String(data.order_reference) : undefined,
                status: mapKfBundleStatus(data?.status),
                raw: res.body,
            }
        }
        return { outcome, error: `KingFlexyGH bundle purchase ${outcome} (HTTP ${res.status})`, raw: res.body }
    } catch (err) {
        purchaseBreaker.record('transient')
        return { outcome: 'transient', error: describeKfFailure(err, apiKey) }
    }
}

export async function checkBundleOrder(reference: string): Promise<{
    configured: boolean
    httpOk: boolean
    found: boolean
    state: ReturnType<typeof mapKfBundleStatus> | 'unknown'
    commission?: number | null
    reason?: string
    raw?: unknown
}> {
    const apiKey = process.env.KINGFLEXY_COMMISSION_API_KEY || undefined
    if (!apiKey) return { configured: false, httpOk: false, found: false, state: 'unknown' }
    try {
        const res = await kfRequest('GET', `/bundles/orders/${encodeURIComponent(reference)}`, apiKey)
        if (res.status === 404) return { configured: true, httpOk: true, found: false, state: 'unknown', raw: res.body }
        if (!res.ok || res.body?.success !== true || !res.body?.data) {
            return { configured: true, httpOk: false, found: false, state: 'unknown', raw: res.body }
        }
        const data = res.body.data
        const c = data.commission
        return {
            configured: true,
            httpOk: true,
            found: true,
            state: mapKfBundleStatus(data.status),
            commission: c === undefined || c === null || !Number.isFinite(Number(c)) ? null : Number(c),
            reason: typeof data.reason === 'string' ? data.reason : undefined,
            raw: res.body,
        }
    } catch {
        return { configured: true, httpOk: false, found: false, state: 'unknown' }
    }
}
