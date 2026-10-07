import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { parseAllowedRoles, VALID_API_ROLES } from '@/lib/role-parser'

// ── Helpers ───────────────────────────────────────────────────────────────

async function getSettingsBlock(supabase: any) {
    const { data: settingsRows } = await (supabase.from('admin_settings') as any)
        .select('key, value')
        .in('key', ['api_feature_enabled', 'api_allowed_roles'])
    const settingsMap: Record<string, any> = {}
    ;((settingsRows as any[]) || []).forEach((s: any) => { settingsMap[s.key] = s.value })
    return {
        feature_enabled: settingsMap['api_feature_enabled'] !== 'false' && settingsMap['api_feature_enabled'] !== false,
        allowed_roles: parseAllowedRoles(settingsMap['api_allowed_roles']),
    }
}

async function getAggregateStats(supabase: any): Promise<{ data: any }> {
    const since24h = new Date(Date.now() - 86400_000).toISOString()

    const [logs24Res, orders24Res, ordersAllRes, topUserRes] = await Promise.all([
        // Logs (24h)
        (supabase.from('api_logs') as any)
            .select('status_code, response_time_ms, api_key_id')
            .gte('created_at', since24h)
            .limit(50000),
        // Orders (24h, source=api)
        (supabase.from('orders') as any)
            .select('price, status')
            .eq('source', 'api')
            .gte('created_at', since24h)
            .limit(50000),
        // Orders (all-time revenue — successful only)
        (supabase.from('orders') as any)
            .select('price')
            .eq('source', 'api')
            .eq('status', 'completed')
            .limit(100000),
        // Top user by requests (24h) — done via the logs we already fetched below
        Promise.resolve(null),
    ])

    const logs = ((logs24Res as any).data || []) as any[]
    let okReq = 0, errReq = 0, totalLatency = 0
    const reqsByKey: Record<string, number> = {}
    for (const l of logs) {
        if (l.status_code < 400) okReq++; else errReq++
        totalLatency += Number(l.response_time_ms) || 0
        if (l.api_key_id) reqsByKey[l.api_key_id] = (reqsByKey[l.api_key_id] || 0) + 1
    }
    const totalReq = logs.length
    const successRate = totalReq > 0 ? Math.round((okReq / totalReq) * 1000) / 10 : 0
    const avgLatency = totalReq > 0 ? Math.round(totalLatency / totalReq) : 0

    const orders24 = ((orders24Res as any).data || []) as any[]
    let revenue24h = 0
    for (const o of orders24) if (o.status === 'completed') revenue24h += Number(o.price) || 0

    const ordersAll = ((ordersAllRes as any).data || []) as any[]
    const revenueAll = ordersAll.reduce((s, o) => s + (Number(o.price) || 0), 0)

    // Top user (24h)
    let topUser: { name: string; email: string; requests: number } | null = null
    const topKeyId = Object.keys(reqsByKey).sort((a, b) => reqsByKey[b] - reqsByKey[a])[0]
    if (topKeyId) {
        const { data: keyRow } = await (supabase.from('api_keys') as any)
            .select('user_id, users!api_keys_user_id_fkey(first_name, last_name, email)')
            .eq('id', topKeyId)
            .maybeSingle()
        const u = (keyRow as any)?.users
        if (u) {
            topUser = {
                name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Unknown',
                email: u.email,
                requests: reqsByKey[topKeyId],
            }
        }
    }

    return {
        data: {
            requests_24h: totalReq,
            requests_ok_24h: okReq,
            requests_err_24h: errReq,
            success_rate_24h: successRate,
            avg_response_ms: avgLatency,
            revenue_24h: Math.round(revenue24h * 100) / 100,
            revenue_all_time: Math.round(revenueAll * 100) / 100,
            orders_24h: orders24.length,
            top_user: topUser,
        },
    }
}

// ============================================================================
// Admin API Key Management
// GET   — List all API keys with user info + optional API logs
// PATCH — Approve (pending → active) or revoke (active → revoked) a key
// ============================================================================

// ── GET: List all API keys ────────────────────────────────────────────────

export async function GET(request: NextRequest) {
    const adminAuth = await validateAdminAccess(false)
    if (adminAuth.error) {
        return NextResponse.json({ error: adminAuth.error }, { status: adminAuth.status })
    }

    try {
        const supabase = createServerClient()
        const { searchParams } = new URL(request.url)
        const tab = searchParams.get('tab')
        const statusFilter = searchParams.get('status') // 'pending' | 'active' | 'revoked' | null
        const roleFilter = searchParams.get('role') || ''
        const searchQuery = (searchParams.get('search') || '').trim()
        const sortBy = searchParams.get('sort') || 'recent' // recent | requests | last_used | oldest
        const page = parseInt(searchParams.get('page') || '1')
        const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
        const offset = (page - 1) * limit

        // ── Tab: per-user activity drill-down ─────────────────────────────
        if (tab === 'user_activity') {
            const userId = searchParams.get('user_id')
            if (!userId) {
                return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
            }
            const apiKeyId = searchParams.get('api_key_id') || ''

            const since24h = new Date(Date.now() - 86400_000).toISOString()

            const [ordersRes, logs24Res, keyRowRes] = await Promise.all([
                (supabase.from('orders') as any)
                    .select('price, status, size, created_at')
                    .eq('user_id', userId)
                    .eq('source', 'api')
                    .limit(10000),
                (supabase.from('api_logs') as any)
                    .select('status_code, response_time_ms', { count: 'exact' })
                    .eq('api_key_id', apiKeyId)
                    .gte('created_at', since24h)
                    .limit(5000),
                // Scoped by the SPECIFIC key's id (not just user_id) — a user can
                // now hold up to two keys (standard + commission), so filtering by
                // user_id alone would return >1 row and .maybeSingle() would error.
                // The caller (UserActivityPanel) always passes the exact key's id
                // it's drilling into.
                (supabase.from('api_keys') as any)
                    .select('id, last_used_at, created_at')
                    .eq('id', apiKeyId)
                    .maybeSingle(),
            ])

            const orders = (ordersRes as any).data || []
            let totalSpent = 0, totalOrders = 0, successOrders = 0, failedOrders = 0, pendingOrders = 0
            for (const o of orders) {
                totalOrders++
                const price = Number(o.price) || 0
                if (o.status === 'completed') { successOrders++; totalSpent += price }
                else if (o.status === 'failed') failedOrders++
                else pendingOrders++
            }

            const logs = (logs24Res as any).data || []
            let okReq = 0, errReq = 0, totalLatency = 0
            for (const l of logs) {
                if (l.status_code < 400) okReq++; else errReq++
                totalLatency += Number(l.response_time_ms) || 0
            }
            const requests24h = (logs24Res as any).count || logs.length

            return NextResponse.json({
                user_id: userId,
                total_spent: Math.round(totalSpent * 100) / 100,
                total_orders: totalOrders,
                success_orders: successOrders,
                failed_orders: failedOrders,
                pending_orders: pendingOrders,
                success_rate: totalOrders > 0 ? Math.round((successOrders / totalOrders) * 1000) / 10 : 0,
                requests_24h: requests24h,
                requests_ok_24h: okReq,
                requests_err_24h: errReq,
                avg_response_ms: logs.length > 0 ? Math.round(totalLatency / logs.length) : 0,
                key_created_at: (keyRowRes as any).data?.created_at || null,
                last_used_at: (keyRowRes as any).data?.last_used_at || null,
            })
        }

        // ── Tab: API Logs ─────────────────────────────────────────────────
        if (tab === 'logs') {
            const endpointFilter = searchParams.get('endpoint') || ''
            const statusCodeFilter = searchParams.get('status_code') || ''

            let logsQuery = (supabase.from('api_logs') as any)
                .select(`
                    id,
                    api_key_id,
                    endpoint,
                    method,
                    status_code,
                    response_time_ms,
                    ip_address,
                    created_at,
                    api_keys!api_logs_api_key_id_fkey (
                        key_prefix,
                        name,
                        user_id,
                        users!api_keys_user_id_fkey (
                            first_name,
                            last_name,
                            email
                        )
                    )
                `, { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1)

            if (endpointFilter) logsQuery = logsQuery.ilike('endpoint', `%${endpointFilter}%`)
            if (statusCodeFilter) logsQuery = logsQuery.eq('status_code', parseInt(statusCodeFilter))

            const { data: logs, error: logsError, count: logsCount } = await logsQuery

            if (logsError) {
                console.error('[Admin API Logs GET] Query error:', logsError.message)
                return NextResponse.json({ error: 'Failed to fetch API logs' }, { status: 500 })
            }

            const formattedLogs = (logs || []).map((log: any) => ({
                id: log.id,
                api_key_id: log.api_key_id,
                key_prefix: log.api_keys?.key_prefix || null,
                key_name: log.api_keys?.name || null,
                user: log.api_keys?.users ? {
                    name: `${log.api_keys.users.first_name || ''} ${log.api_keys.users.last_name || ''}`.trim(),
                    email: log.api_keys.users.email,
                } : null,
                endpoint: log.endpoint,
                method: log.method,
                status_code: log.status_code,
                response_time_ms: log.response_time_ms,
                ip_address: log.ip_address,
                created_at: log.created_at,
            }))

            return NextResponse.json({
                logs: formattedLogs,
                pagination: {
                    page,
                    limit,
                    total: logsCount || 0,
                    total_pages: Math.ceil((logsCount || 0) / limit),
                },
            })
        }

        // ── Resolve user_id list when filtering by role or search ─────────
        // We do this up-front because PostgREST cannot filter / search across
        // joined tables in a single query reliably.
        let restrictUserIds: string[] | null = null
        if (roleFilter || searchQuery) {
            let userQ = (supabase.from('users') as any).select('id')
            if (roleFilter) userQ = userQ.eq('role', roleFilter)
            if (searchQuery) {
                const like = `%${searchQuery.replace(/[%_]/g, m => `\\${m}`)}%`
                userQ = userQ.or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone_number.ilike.${like}`)
            }
            const { data: matchedUsers } = await userQ.limit(2000)
            restrictUserIds = ((matchedUsers as any[]) || []).map(u => u.id)

            // Also allow searching by key prefix directly
            if (searchQuery) {
                const { data: prefixMatches } = await (supabase.from('api_keys') as any)
                    .select('user_id')
                    .ilike('key_prefix', `%${searchQuery}%`)
                    .limit(2000)
                const ids = new Set(restrictUserIds)
                for (const m of (prefixMatches as any[]) || []) ids.add(m.user_id)
                restrictUserIds = Array.from(ids)
            }

            // No matches → return empty page early
            if (restrictUserIds.length === 0) {
                const { data: emptyStats } = await getAggregateStats(supabase)
                return NextResponse.json({
                    keys: [],
                    pagination: { page, limit, total: 0, total_pages: 0 },
                    stats: emptyStats,
                    settings: await getSettingsBlock(supabase),
                })
            }
        }

        // ── Fetch API keys with user info ─────────────────────────────────
        let query = (supabase.from('api_keys') as any)
            .select(`
                id,
                user_id,
                key_prefix,
                name,
                status,
                key_type,
                rate_limits,
                last_used_at,
                created_at,
                updated_at,
                webhook_url,
                users!api_keys_user_id_fkey (
                    first_name,
                    last_name,
                    email,
                    phone_number,
                    role
                )
            `, { count: 'exact' })

        // Sorting
        if (sortBy === 'oldest') {
            query = query.order('created_at', { ascending: true })
        } else if (sortBy === 'last_used') {
            query = query.order('last_used_at', { ascending: false, nullsFirst: false })
        } else {
            // 'recent' (default) and 'requests' (sorted client-side after enrichment)
            query = query.order('created_at', { ascending: false })
        }

        query = query.range(offset, offset + limit - 1)

        if (statusFilter && ['pending', 'active', 'revoked'].includes(statusFilter)) {
            query = query.eq('status', statusFilter)
        }
        if (restrictUserIds) {
            query = query.in('user_id', restrictUserIds)
        }

        const { data: keys, error: keysError, count } = await query

        if (keysError) {
            console.error('[Admin API Keys GET] Query error:', keysError.message)
            return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 })
        }

        // ── Fetch API usage stats per key ─────────────────────────────────
        // Get request count for each key in the last 24h
        const oneDayAgo = new Date(Date.now() - 86400000).toISOString()
        const keyIds = (keys || []).map((k: any) => k.id)

        let usageMap: Record<string, number> = {}
        if (keyIds.length > 0) {
            const { data: usageData } = await (supabase.from('api_logs') as any)
                .select('api_key_id', { count: 'exact', head: false })
                .in('api_key_id', keyIds)
                .gte('created_at', oneDayAgo)

            // Count per key
            if (usageData) {
                for (const log of usageData as any[]) {
                    usageMap[log.api_key_id] = (usageMap[log.api_key_id] || 0) + 1
                }
            }
        }

        // ── Format response ───────────────────────────────────────────────
        let formattedKeys = (keys || []).map((key: any) => ({
            id: key.id,
            prefix: key.key_prefix,
            name: key.name,
            status: key.status,
            key_type: key.key_type,
            rate_limits: key.rate_limits,
            last_used_at: key.last_used_at,
            created_at: key.created_at,
            requests_24h: usageMap[key.id] || 0,
            // Boolean only, never the URL — an admin needs to know whether this
            // (now write-locked, see 20260824_lock_api_keys_writes.sql) column
            // is populated for oversight, not the destination itself. Surfacing
            // the raw URL here would just be a second place it could leak from.
            has_webhook: !!key.webhook_url,
            user: key.users ? {
                id: key.user_id,
                name: `${key.users.first_name || ''} ${key.users.last_name || ''}`.trim(),
                email: key.users.email,
                phone: key.users.phone_number,
                role: key.users.role,
            } : null,
        }))

        // Sort by requests_24h (descending) — done after enrichment because
        // it isn't a column on api_keys.
        if (sortBy === 'requests') {
            formattedKeys = formattedKeys.sort((a: any, b: any) => b.requests_24h - a.requests_24h)
        }

        const { data: aggStats } = await getAggregateStats(supabase)
        const settingsBlock = await getSettingsBlock(supabase)

        return NextResponse.json({
            keys: formattedKeys,
            pagination: {
                page,
                limit,
                total: count || 0,
                total_pages: Math.ceil((count || 0) / limit),
            },
            stats: aggStats,
            settings: settingsBlock,
        })

    } catch (error: any) {
        console.error('[Admin API Keys GET] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── PATCH: Approve or revoke an API key ───────────────────────────────────

export async function PATCH(request: NextRequest) {
    const adminAuth = await validateAdminAccess(false)
    if (adminAuth.error) {
        return NextResponse.json({ error: adminAuth.error }, { status: adminAuth.status })
    }

    try {
        const supabase = createServerClient()

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { key_id, action, rate_limits } = body

        // ── Save feature control settings ─────────────────────────────────
        if (body.action === 'save_settings') {
            if (typeof body.feature_enabled !== 'boolean') {
                return NextResponse.json({ error: 'feature_enabled must be a boolean' }, { status: 400 })
            }
            if (!Array.isArray(body.allowed_roles) || body.allowed_roles.length === 0) {
                return NextResponse.json({ error: 'allowed_roles must be a non-empty array' }, { status: 400 })
            }
            // Sanitise: flatten malformed nested arrays, migrate legacy `user` → `customer`,
            // and filter to the canonical role list. See lib/role-parser.ts.
            const sanitised = parseAllowedRoles(body.allowed_roles, [])
            if (sanitised.length === 0) {
                return NextResponse.json({
                    error: `No valid roles supplied. Allowed: ${VALID_API_ROLES.join(', ')}`,
                }, { status: 400 })
            }
            const updates = [
                { key: 'api_feature_enabled', value: String(body.feature_enabled) },
                { key: 'api_allowed_roles',   value: JSON.stringify(sanitised) },
            ]
            const { error: upsertError } = await (supabase.from('admin_settings') as any)
                .upsert(updates, { onConflict: 'key' })
            if (upsertError) {
                console.error('[Admin API Keys PATCH] Settings upsert error:', upsertError.message)
                return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
            }
            return NextResponse.json({ success: true, message: 'API settings saved' })
        }

        if (!key_id || typeof key_id !== 'string') {
            return NextResponse.json({ error: 'key_id is required' }, { status: 400 })
        }

        // ── Handle rate limit update ──────────────────────────────────────
        if (rate_limits !== undefined) {
            if (rate_limits !== null && typeof rate_limits !== 'object') {
                return NextResponse.json({ error: 'rate_limits must be an object or null' }, { status: 400 })
            }

            const { error: rlError } = await (supabase.from('api_keys') as any)
                .update({
                    rate_limits: rate_limits,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', key_id)

            if (rlError) {
                console.error('[Admin API Keys PATCH] Rate limit update error:', rlError.message)
                return NextResponse.json({ error: 'Failed to update rate limits' }, { status: 500 })
            }

            if (!action) {
                return NextResponse.json({ success: true, message: 'Rate limits updated' })
            }
        }

        // ── Handle status change ──────────────────────────────────────────
        if (!action || !['approve', 'revoke'].includes(action)) {
            return NextResponse.json({ error: 'action must be "approve" or "revoke"' }, { status: 400 })
        }

        // Fetch current key state
        const { data: currentKey, error: fetchError } = await (supabase
            .from('api_keys') as any)
            .select('id, status, user_id, key_prefix, name')
            .eq('id', key_id)
            .single()

        if (fetchError || !currentKey) {
            return NextResponse.json({ error: 'API key not found' }, { status: 404 })
        }

        // Validate state transitions
        if (action === 'approve') {
            if (currentKey.status !== 'pending') {
                return NextResponse.json({
                    error: `Cannot approve a key with status "${currentKey.status}". Only pending keys can be approved.`,
                }, { status: 400 })
            }
        }

        if (action === 'revoke') {
            if (currentKey.status === 'revoked') {
                return NextResponse.json({
                    error: 'Key is already revoked',
                }, { status: 400 })
            }
        }

        const newStatus = action === 'approve' ? 'active' : 'revoked'

        const { error: updateError } = await (supabase.from('api_keys') as any)
            .update({
                status: newStatus,
                updated_at: new Date().toISOString(),
            })
            .eq('id', key_id)

        if (updateError) {
            console.error('[Admin API Keys PATCH] Update error:', updateError.message)
            return NextResponse.json({ error: 'Failed to update API key' }, { status: 500 })
        }

        // ── Send notification to key owner ────────────────────────────────
        const notifMessage = action === 'approve'
            ? 'Your Developer API key has been approved and is now active. You can start making API requests.'
            : 'Your Developer API key has been revoked by an administrator.'

        ;(supabase.from('notifications') as any).insert({
            user_id: currentKey.user_id,
            title: action === 'approve' ? 'API Key Approved ✅' : 'API Key Revoked ❌',
            message: notifMessage,
            type: 'system',
            action_url: '/dashboard/api',
        }).then(() => {}).catch((e: any) => console.error('[Admin API Keys] Notification error:', e.message))

        return NextResponse.json({
            success: true,
            message: `API key ${action === 'approve' ? 'approved' : 'revoked'} successfully`,
            key: {
                id: currentKey.id,
                prefix: currentKey.key_prefix,
                name: currentKey.name,
                status: newStatus,
            },
        })

    } catch (error: any) {
        console.error('[Admin API Keys PATCH] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
