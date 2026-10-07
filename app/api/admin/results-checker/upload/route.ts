import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { fulfillPendingRCOrders } from '@/lib/results-checker-service'

type UploadRow = { pin: string; serial_number: string }
type ParseResult = { rows: UploadRow[]; errors: string[] }

/**
 * Parse CSV text (from file or manual entry)
 * Expected columns: pin, serial_number
 */
function parseCSVText(text: string, hasHeader: boolean): ParseResult {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim())
    const rows: UploadRow[] = []
    const errors: string[] = []
    const startIndex = hasHeader ? 1 : 0

    for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''))
        const pin = parts[0]?.trim()
        const serial_number = parts[1]?.trim()
        if (!pin || !serial_number) {
            errors.push(`Row ${i + 1}: Missing pin or serial_number`)
            continue
        }
        rows.push({ pin, serial_number })
    }

    return { rows, errors }
}

/**
 * Parse Excel buffer using SheetJS
 */
async function parseExcelBuffer(buffer: ArrayBuffer): Promise<ParseResult> {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[sheetName]
    const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: '' })

    const rows: UploadRow[] = []
    const errors: string[] = []

    jsonData.forEach((row: Record<string, any>, i: number) => {
        // Support both lowercase and uppercase column names
        const pin = String(row.pin || row.PIN || row.Pin || '').trim()
        const serial_number = String(
            row.serial_number || row.Serial_Number || row.SerialNumber ||
            row.SERIAL_NUMBER || row.serial || row.Serial || ''
        ).trim()

        if (!pin || !serial_number) {
            errors.push(`Row ${i + 2}: Missing pin or serial_number`)
            return
        }
        rows.push({ pin, serial_number })
    })

    return { rows, errors }
}

/**
 * POST /api/admin/results-checker/upload
 *
 * Three upload modes:
 *   - csv:    multipart/form-data with file field + type_id
 *   - excel:  multipart/form-data with file field + type_id
 *   - manual: JSON body with lines: string[] + type_id
 *
 * All modes feed into the same validation + batch insert pipeline.
 */
export async function POST(request: NextRequest) {
    try {
        // ── Admin auth ─────────────────────────────────────────────────────
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()
        const db = supabase as any

        // Verify admin role
        const { data: userProfile } = await db
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!userProfile || !['admin'].includes(userProfile.role)) {
            return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
        }

        let typeId: string
        let mode: string
        let parsedRows: UploadRow[] = []
        let parseErrors: string[] = []

        const contentType = request.headers.get('content-type') || ''

        // ── Mode detection and parsing ────────────────────────────────────
        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData()
            typeId = String(formData.get('type_id') || '').trim()
            mode = String(formData.get('mode') || 'csv').trim()
            const file = formData.get('file') as File | null

            if (!file) {
                return NextResponse.json({ error: 'No file provided' }, { status: 400 })
            }

            if (mode === 'csv') {
                const text = await file.text()
                const result = parseCSVText(text, true)
                parsedRows = result.rows
                parseErrors = result.errors
            } else if (mode === 'excel') {
                const buffer = await file.arrayBuffer()
                const result = await parseExcelBuffer(buffer)
                parsedRows = result.rows
                parseErrors = result.errors
            } else {
                return NextResponse.json({ error: 'Invalid mode. Use csv, excel, or manual' }, { status: 400 })
            }
        } else {
            // JSON body for manual entry
            let body: any
            try {
                body = await request.json()
            } catch {
                return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
            }

            typeId = String(body.type_id || '').trim()
            mode = 'manual'
            const rawText = String(body.text || '').trim()

            if (!rawText) {
                return NextResponse.json({ error: 'No text content provided' }, { status: 400 })
            }

            // Manual: each line is PIN,SERIAL_NUMBER — no header
            const result = parseCSVText(rawText, false)
            parsedRows = result.rows
            parseErrors = result.errors
        }

        // ── Validate type_id ───────────────────────────────────────────────
        if (!typeId) {
            return NextResponse.json({ error: 'type_id is required' }, { status: 400 })
        }

        const { data: rcType, error: typeError } = await db
            .from('results_checker_types')
            .select('id, name')
            .eq('id', typeId)
            .single()

        if (typeError || !rcType) {
            return NextResponse.json({ error: 'Invalid type_id — voucher type not found' }, { status: 404 })
        }

        if (parsedRows.length === 0) {
            return NextResponse.json({
                success: false,
                inserted: 0,
                duplicates_skipped: 0,
                errors: parseErrors.length ? parseErrors : ['No valid rows found in input'],
            }, { status: 400 })
        }

        // ── Duplicate PIN check ────────────────────────────────────────────
        const incomingPins = parsedRows.map(r => r.pin)
        const { data: existingPins } = await db
            .from('results_checker_inventory')
            .select('pin')
            .eq('type_id', typeId)
            .in('pin', incomingPins)

        const existingPinSet = new Set((existingPins || []).map((r: any) => r.pin))
        const uniqueRows = parsedRows.filter(r => !existingPinSet.has(r.pin))
        const duplicatesSkipped = parsedRows.length - uniqueRows.length

        if (uniqueRows.length === 0) {
            return NextResponse.json({
                success: true,
                inserted: 0,
                duplicates_skipped: duplicatesSkipped,
                errors: parseErrors,
                message: 'All pins already exist in inventory — nothing inserted',
            })
        }

        // ── Batch insert ───────────────────────────────────────────────────
        const batchId = `BATCH-${Date.now()}`
        const insertRows = uniqueRows.map(row => ({
            type_id:       typeId,
            pin:           row.pin,
            serial_number: row.serial_number,
            status:        'available',
            batch_id:      batchId,
        }))

        const { error: insertError, count: insertCount } = await db
            .from('results_checker_inventory')
            .insert(insertRows, { count: 'exact' })

        if (insertError) {
            console.error('[RC Upload] Insert error:', insertError)
            return NextResponse.json({ error: 'Failed to insert inventory' }, { status: 500 })
        }

        // ── Non-blocking backorder fulfillment ────────────────────────────
        fulfillPendingRCOrders(typeId)
            .catch((err: any) => console.error('[RC Upload] Backorder fulfillment error:', err))

        return NextResponse.json({
            success:            true,
            inserted:           insertCount ?? uniqueRows.length,
            duplicates_skipped: duplicatesSkipped,
            batch_id:           batchId,
            type_name:          rcType.name,
            errors:             parseErrors,
            mode,
        })

    } catch (error) {
        console.error('[RC Upload] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
