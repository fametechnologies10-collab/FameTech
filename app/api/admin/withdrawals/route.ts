import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
    // ── Auth gate: admin only ───────────────────────────────────────────────
    const supa = await createRouteClient()
    const { data: { user } } = await supa.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { data: dbUser } = await supa
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()

    if (!dbUser || dbUser.role !== 'admin') {
        return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }

    // ── Query params ────────────────────────────────────────────────────────
    const url = new URL(req.url)
    const view = url.searchParams.get('view') || 'all'   // 'queue' | 'history' | 'all'
    const status = url.searchParams.get('status') || 'all'
    const provider = url.searchParams.get('provider') || 'all'
    const shopOwnerId = url.searchParams.get('shopOwnerId') || 'all'
    const search = (url.searchParams.get('search') || '').trim().slice(0, 100)
    // M5: allowlist only — strip anything that isn't a plain name/number char so
    // the value can't carry PostgREST .or() filter syntax (*, !, ~, |, &, parens,
    // commas, quotes, backticks, % _ wildcards, control chars are all removed).
    const safeSearch = search.replace(/[^A-Za-z0-9 .@+-]/g, '').trim()
    const rawPage = parseInt(url.searchParams.get('page') || '1', 10)
    const rawPageSize = parseInt(url.searchParams.get('pageSize') || '25', 10)
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage)
    const pageSize = Math.min(100, Math.max(1, isNaN(rawPageSize) ? 25 : rawPageSize))
    const from = (page - 1) * pageSize

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (shopOwnerId !== 'all' && !UUID_RE.test(shopOwnerId)) {
        return NextResponse.json({ success: false, error: 'Invalid shopOwnerId' }, { status: 400 })
    }

    const db = createServerClient() as ReturnType<typeof createServerClient>

    // ── Query 1: paginated shop_wallet_transactions ─────────────────────────
    // Uses the proven single-level embed shop_wallets!inner(owner_id) to
    // retrieve each row's owning user. Deep nested embeds are avoided because
    // FK alias resolution is unverifiable at build time.
    let q = (db as any)
        .from('shop_wallet_transactions')
        .select(`*, wallet:shop_wallets!inner(owner_id)`, { count: 'exact' })
        .eq('type', 'withdrawal')
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1)

    // view-based status group filter (takes precedence over single-status param)
    if (view === 'queue') {
        q = q.in('status', ['pending', 'moolre_pending', 'paystack_pending', 'failed'])
    } else if (view === 'history') {
        q = q.in('status', ['completed', 'reversed'])
    } else if (status !== 'all') {
        q = q.eq('status', status)
    }
    if (provider !== 'all') q = q.eq('payout_provider', provider)
    // Filter by owner via the single-level embed (matches existing admin page pattern)
    if (shopOwnerId !== 'all') q = q.eq('wallet.owner_id', shopOwnerId)
    if (safeSearch) {
        q = q.or(
            `account_name.ilike.%${safeSearch}%,momo_number.ilike.%${safeSearch}%,account_number.ilike.%${safeSearch}%`
        )
    }

    const { data: txRows, error: txError, count } = await q
    if (txError) {
        return NextResponse.json({ success: false, error: txError.message }, { status: 500 })
    }

    // ── Query 2: enrich with shop profile + owner details ──────────────────
    // Collect distinct owner_ids from this page of results, then fetch profiles
    // in a single IN query. Uses the proven embed from fetchShops in
    // app/admin/shops/page.tsx and app/admin/shops/withdrawals/page.tsx.
    const ownerIds: string[] = Array.from(
        new Set<string>(
            (txRows || [])
                .map((w: any) => w.wallet?.owner_id as string | undefined)
                .filter((id: string | undefined): id is string => typeof id === 'string')
        )
    )

    const profileMap = new Map<string, {
        shop_name: string
        owner_phone: string
        owner_id: string
        owner: { first_name: string; last_name: string; email: string } | null
    }>()

    if (ownerIds.length > 0) {
        const { data: profiles, error: profileError } = await (db as any)
            .from('shop_profiles')
            .select(
                'owner_id, shop_name, owner_phone, owner:users!shop_profiles_owner_id_fkey(first_name, last_name, email)'
            )
            .in('owner_id', ownerIds)

        if (profileError) {
            return NextResponse.json({ success: false, error: profileError.message }, { status: 500 })
        }

        for (const p of profiles || []) {
            profileMap.set(p.owner_id, p)
        }
    }

    // ── Merge + derive name_unverified ─────────────────────────────────────
    const rows = (txRows || []).map((w: any) => {
        const ownerId: string | undefined = w.wallet?.owner_id
        const prof = ownerId ? profileMap.get(ownerId) : undefined
        const ownerData = prof?.owner ?? null

        const ownerName = ownerData
            ? `${ownerData.first_name ?? ''} ${ownerData.last_name ?? ''}`.trim()
            : 'Unknown'

        return {
            ...w,
            // C1: prefer the authoritative name_verified column; fall back to the
            // legacy [UNVERIFIED-NAME] description tag for rows written before the
            // column existed (name_verified IS NULL).
            name_unverified:
                w.name_verified === false ||
                (w.name_verified == null &&
                    typeof w.description === 'string' &&
                    w.description.includes('[UNVERIFIED-NAME]')),
            shop: {
                shop_name: prof?.shop_name ?? 'Unknown Shop',
                owner_id: ownerId ?? null,
                owner_name: ownerName || 'Unknown',
                owner_email: ownerData?.email ?? '',
                owner_phone: prof?.owner_phone ?? '',
            },
        }
    })

    return NextResponse.json({ success: true, data: { rows, total: count ?? rows.length } })
}
