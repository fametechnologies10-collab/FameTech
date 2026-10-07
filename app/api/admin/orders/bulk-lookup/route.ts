import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/admin/orders/bulk-lookup
 * Strict admin-only (no sub-admin — this feeds the bulk status/refund page).
 * Finds orders either by browsing filters (network/status/date range) or by a pasted/uploaded
 * list of { phoneNumber, size? } rows, or both combined (AND). Read-only — never mutates orders.
 * `size` is optional per row — a bare phone number returns every order for that beneficiary
 * (matches how suppliers export order sheets: phone number, with size only sometimes present).
 *
 * JSON body: {
 *   rows?: { phoneNumber: string; size?: string }[],
 *   network?: string, status?: string, dateFrom?: string, dateTo?: string  // 'YYYY-MM-DD'
 * }
 * multipart/form-data (file upload): file, mode ('csv'|'excel'),
 *   plus the same network/status/dateFrom/dateTo fields as plain strings.
 */

const MAX_LOOKUP_ROWS = 200
const MAX_RESULTS = 300
const PHONE_CHUNK = 100
const HEADER_WORDS = new Set(['phone', 'phone number', 'phonenumber', 'phone_number', 'beneficiary', 'number', 'msisdn'])

type UploadRow = { phoneNumber: string; size: string }

const SELECT = `
    id, created_at, phone_number, network, size, price, status, fulfillment_method,
    reference_code, refunded_at, payment_status, shop_order_id, source,
    users!orders_user_id_fkey ( first_name, last_name )
`

function norm(s: unknown): string {
    return String(s ?? '').trim().toLowerCase()
}

/**
 * Sizes are stored as "1GB", "4GB", etc., but admins commonly type the bare number
 * ("1" meaning 1GB) when pasting from a supplier sheet — a bare number is always GB
 * for these bundles, so treat "1", "1gb", and "1 gb" as the same size.
 */
function normSize(s: unknown): string {
    const raw = String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')
    return /^\d+(\.\d+)?$/.test(raw) ? `${raw}gb` : raw
}

/** "phoneNumber,size" per line — size column is optional. Used for pasted text and .csv uploads. */
function parseCSVText(text: string): UploadRow[] {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim())
    if (lines.length === 0) return []
    const firstCell = (lines[0].split(',')[0] || '').trim().replace(/^"|"$/g, '')
    const startIndex = HEADER_WORDS.has(norm(firstCell)) ? 1 : 0

    const rows: UploadRow[] = []
    for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(/[,\t]/).map(p => p.trim().replace(/^"|"$/g, ''))
        const phoneNumber = parts[0]?.trim()
        const size = parts[1]?.trim() || ''
        if (phoneNumber) rows.push({ phoneNumber, size })
    }
    return rows
}

async function parseExcelBuffer(buffer: ArrayBuffer): Promise<UploadRow[]> {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: '' })

    const rows: UploadRow[] = []
    for (const row of jsonData) {
        const phoneNumber = String(
            row.phone_number || row.phoneNumber || row.beneficiary || row.Phone || row.phone || row.Number || row.number || ''
        ).trim()
        const size = String(row.size || row.data_size || row.dataSize || row.Size || '').trim()
        if (phoneNumber) rows.push({ phoneNumber, size })
    }
    return rows
}

export async function POST(request: NextRequest) {
    try {
        const auth = await validateAdminAccess(false, request)
        if (auth.error !== null) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const rl = consumeRateLimit(`admin-bulk-lookup:${auth.user.id}`, 30, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many lookup requests, slow down.' }, { status: 429 })
        }

        let rawRows: UploadRow[] = []
        let network: string | null = null
        let status: string | null = null
        let dateFrom: string | null = null
        let dateTo: string | null = null

        const contentType = request.headers.get('content-type') || ''
        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData()
            const mode = String(formData.get('mode') || 'csv').trim()
            const file = formData.get('file') as File | null
            if (!file) return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 })

            if (mode === 'csv') {
                rawRows = parseCSVText(await file.text())
            } else if (mode === 'excel') {
                rawRows = await parseExcelBuffer(await file.arrayBuffer())
            } else {
                return NextResponse.json({ success: false, error: 'Invalid mode. Use csv or excel' }, { status: 400 })
            }

            const f = (k: string) => { const v = formData.get(k); return typeof v === 'string' && v.trim() ? v.trim() : null }
            network = f('network') !== 'All' ? f('network') : null
            status = f('status') !== 'All' ? f('status')?.toLowerCase() ?? null : null
            dateFrom = f('dateFrom')
            dateTo = f('dateTo')
        } else {
            let body: any
            try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

            const jsonRows: Array<{ phoneNumber?: unknown; size?: unknown }> = Array.isArray(body?.rows) ? body.rows : []
            rawRows = jsonRows
                .map(r => ({ phoneNumber: String(r?.phoneNumber ?? '').trim(), size: String(r?.size ?? '').trim() }))
                .filter(r => r.phoneNumber)

            network = typeof body?.network === 'string' && body.network !== 'All' ? body.network : null
            status = typeof body?.status === 'string' && body.status !== 'All' ? body.status.toLowerCase() : null
            dateFrom = typeof body?.dateFrom === 'string' && body.dateFrom ? body.dateFrom : null
            dateTo = typeof body?.dateTo === 'string' && body.dateTo ? body.dateTo : null
        }

        // Dedupe on (phone + size) so the same beneficiary can appear multiple times in one
        // paste with different sizes — deduping on phone alone would silently drop those rows.
        const dedupedRows = Array.from(new Map(rawRows.map(r => [`${norm(r.phoneNumber)}|${norm(r.size)}`, r])).values())
        if (dedupedRows.length > MAX_LOOKUP_ROWS) {
            return NextResponse.json({ success: false, error: `At most ${MAX_LOOKUP_ROWS} rows per lookup — split into batches` }, { status: 400 })
        }

        const admin = createServerClient()

        const buildQuery = () => {
            let q = admin.from('orders').select(SELECT)
            if (network) q = q.eq('network', network)
            if (status) q = q.eq('status', status)
            if (dateFrom) q = q.gte('created_at', `${dateFrom}T00:00:00.000Z`)
            if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59.999Z`)
            return q
        }

        let orders: any[] = []

        if (dedupedRows.length > 0) {
            const phones = Array.from(new Set(dedupedRows.map(r => r.phoneNumber)))
            for (let i = 0; i < phones.length; i += PHONE_CHUNK) {
                const chunk = phones.slice(i, i + PHONE_CHUNK)
                const { data, error } = await buildQuery().in('phone_number', chunk)
                if (error) {
                    console.error('[BulkLookup] chunk query error:', error)
                    return NextResponse.json({ success: false, error: 'Lookup failed — please retry' }, { status: 500 })
                }
                orders.push(...(data || []))
            }
        } else {
            const { data, error } = await buildQuery()
                .order('created_at', { ascending: false })
                .limit(MAX_RESULTS)
            if (error) {
                console.error('[BulkLookup] browse query error:', error)
                return NextResponse.json({ success: false, error: 'Lookup failed — please retry' }, { status: 500 })
            }
            orders = data || []
        }

        // De-dupe orders (a phone could repeat across chunks) and cap the response.
        const uniqueOrders = Array.from(new Map(orders.map(o => [o.id, o])).values())
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        const truncated = uniqueOrders.length > MAX_RESULTS
        const limitedOrders = uniqueOrders.slice(0, MAX_RESULTS)

        let notFound: string[] = []
        let sizeMismatch: Array<{ phoneNumber: string; expectedSize: string; foundSizes: string[] }> = []

        if (dedupedRows.length > 0) {
            const byPhone = new Map<string, any[]>()
            for (const o of uniqueOrders) {
                const key = norm(o.phone_number)
                if (!key) continue
                if (!byPhone.has(key)) byPhone.set(key, [])
                byPhone.get(key)!.push(o)
            }

            const matchedIds = new Set<string>()
            for (const row of dedupedRows) {
                const candidates = byPhone.get(norm(row.phoneNumber))
                if (!candidates || candidates.length === 0) {
                    notFound.push(row.size ? `${row.phoneNumber} (${row.size})` : row.phoneNumber)
                    continue
                }
                // No size given for this row — every order for that beneficiary counts as a match.
                if (!row.size) {
                    candidates.forEach(c => matchedIds.add(c.id))
                    continue
                }
                const sizeMatches = candidates.filter(c => normSize(c.size) === normSize(row.size))
                if (sizeMatches.length === 0) {
                    sizeMismatch.push({
                        phoneNumber: row.phoneNumber,
                        expectedSize: row.size,
                        foundSizes: Array.from(new Set(candidates.map(c => c.size))),
                    })
                    continue
                }
                sizeMatches.forEach(c => matchedIds.add(c.id))
            }

            // Only matched (phone, + size when given) orders go into the results grid.
            const matchedOrders = limitedOrders.filter(o => matchedIds.has(o.id))
            return NextResponse.json({
                success: true,
                data: { orders: matchedOrders, notFound, sizeMismatch, totalMatched: matchedOrders.length, truncated: false },
            })
        }

        return NextResponse.json({
            success: true,
            data: { orders: limitedOrders, notFound, sizeMismatch, totalMatched: limitedOrders.length, truncated },
        })
    } catch (error: any) {
        console.error('[BulkLookup] error:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 })
    }
}
