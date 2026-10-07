import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteClient } from '@/lib/supabase-server'

// Verify Admin Role (read-only access: admin + sub-admin)
async function verifyAdmin() {
    const supabaseRoute = await createRouteClient()
    const { data: { user } } = await supabaseRoute.auth.getUser()
    if (!user) return false

    const supabaseServer = createServerClient()
    const { data: userData } = await supabaseServer
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()
        
    return ['admin', 'sub-admin'].includes((userData as any)?.role)
}

// Verify full Admin Role (write actions: admin only, NOT sub-admin)
async function verifyFullAdmin() {
    const supabaseRoute = await createRouteClient()
    const { data: { user } } = await supabaseRoute.auth.getUser()
    if (!user) return false

    const supabaseServer = createServerClient()
    const { data: userData } = await supabaseServer
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()
        
    return (userData as any)?.role === 'admin'
}

export async function GET() {
    try {
        if (!(await verifyAdmin())) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()

        // Fetch transactions
        const { data: txns, error: txnsError } = await (supabase
            .from('momo_transactions') as any)
            .select('*')
            .order('created_at', { ascending: false })
            .limit(200)

        if (txnsError) throw txnsError

        // Fetch claim attempts (suspicious last 24h)
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const { data: attemptsData } = await (supabase
            .from('momo_claim_attempts') as any)
            .select('user_id')
            .gte('created_at', since)

        // Fetch current MoMo settings for the Settings tab
        const { data: settingsRows } = await (supabase
            .from('admin_settings') as any)
            .select('key, value')
            .in('key', [
                'momo_claim_enabled',
                'momo_payment_accounts',
                'momo_account_name',
                'momo_claim_fee_customer',
                'momo_claim_fee_agent',
                'momo_min_claimable',
                'momo_max_claimable',
            ])

        const settingsMap: Record<string, any> = {}
        ;((settingsRows as any[]) || []).forEach((s: any) => { settingsMap[s.key] = s.value })

        // Parse payment accounts from JSONB
        let paymentAccounts: { network: string; number: string }[] = []
        const rawAccts = settingsMap['momo_payment_accounts']
        if (Array.isArray(rawAccts)) paymentAccounts = rawAccts
        else if (typeof rawAccts === 'string') {
            try { const p = JSON.parse(rawAccts); if (Array.isArray(p)) paymentAccounts = p } catch {}
        }

        const safeStr = (v: any, fallback: string) => {
            if (!v) return fallback
            const s = typeof v === 'string' ? v : String(v)
            return s.replace(/^\"|\"$/g, '') || fallback
        }

        return NextResponse.json({
            success: true,
            transactions: txns || [],
            attempts: attemptsData || [],
            settings: {
                momo_claim_enabled: settingsMap['momo_claim_enabled'] !== 'false' && settingsMap['momo_claim_enabled'] !== false,
                momo_payment_accounts: paymentAccounts,
                momo_account_name: safeStr(settingsMap['momo_account_name'], ''),
                momo_claim_fee_customer: safeStr(settingsMap['momo_claim_fee_customer'], '0'),
                momo_claim_fee_agent: safeStr(settingsMap['momo_claim_fee_agent'], '0'),
                momo_min_claimable: safeStr(settingsMap['momo_min_claimable'], '1'),
                momo_max_claimable: safeStr(settingsMap['momo_max_claimable'], '50000'),
            },
        })

    } catch (error: any) {
        console.error('Error fetching admin momo claims:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

// ── POST: Save MoMo settings (admin only) ───────────────────────
export async function POST(request: NextRequest) {
    try {
        // Sub-admins are blocked here — only full admin can save settings
        if (!(await verifyFullAdmin())) {
            return NextResponse.json({ error: 'Only full admins can modify MoMo settings' }, { status: 403 })
        }

        const body = await request.json()
        const {
            momo_claim_enabled,
            momo_payment_accounts,
            momo_account_name,
            momo_claim_fee_customer,
            momo_claim_fee_agent,
            momo_min_claimable,
            momo_max_claimable,
        } = body

        // Validate fee fields
        const feeCustomer = parseFloat(momo_claim_fee_customer ?? '0')
        const feeAgent = parseFloat(momo_claim_fee_agent ?? '0')
        const minAmt = parseFloat(momo_min_claimable ?? '1')
        const maxAmt = parseFloat(momo_max_claimable ?? '50000')

        if (isNaN(feeCustomer) || feeCustomer < 0 || feeCustomer > 100) {
            return NextResponse.json({ error: 'Customer fee must be between 0 and 100' }, { status: 400 })
        }
        if (isNaN(feeAgent) || feeAgent < 0 || feeAgent > 100) {
            return NextResponse.json({ error: 'Agent fee must be between 0 and 100' }, { status: 400 })
        }
        if (isNaN(minAmt) || minAmt < 0) {
            return NextResponse.json({ error: 'Minimum claimable must be a positive number' }, { status: 400 })
        }
        if (isNaN(maxAmt) || maxAmt < minAmt) {
            return NextResponse.json({ error: 'Maximum claimable must be greater than or equal to minimum' }, { status: 400 })
        }
        if (momo_account_name && String(momo_account_name).length > 80) {
            return NextResponse.json({ error: 'Account name exceeds maximum length of 80 characters' }, { status: 400 })
        }
        if (!Array.isArray(momo_payment_accounts)) {
            return NextResponse.json({ error: 'Payment accounts must be an array' }, { status: 400 })
        }

        const supabase = createServerClient()
        const updates = [
            { key: 'momo_claim_enabled', value: String(momo_claim_enabled ?? true) },
            { key: 'momo_payment_accounts', value: JSON.stringify(momo_payment_accounts.filter((a: any) => a.network && String(a.number).trim())) },
            { key: 'momo_account_name', value: String(momo_account_name ?? '').trim() },
            { key: 'momo_claim_fee_customer', value: String(feeCustomer) },
            { key: 'momo_claim_fee_agent', value: String(feeAgent) },
            { key: 'momo_min_claimable', value: String(minAmt) },
            { key: 'momo_max_claimable', value: String(maxAmt) },
        ]

        const { error } = await (supabase.from('admin_settings') as any).upsert(updates)
        if (error) throw error

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('Error saving MoMo settings:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

export async function PATCH(request: NextRequest) {
    try {
        // Only full admin can void/restore — sub-admins cannot
        if (!(await verifyFullAdmin())) {
            return NextResponse.json({ error: 'Only admins can void or restore transactions' }, { status: 403 })
        }

        const body = await request.json()
        const { id, status } = body

        if (!id || !status || !['voided', 'pending'].includes(status)) {
            return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
        }

        const supabase = createServerClient()

        // Fetch the current transaction status before modifying
        const { data: currentTxn, error: fetchError } = await (supabase
            .from('momo_transactions') as any)
            .select('status')
            .eq('id', id)
            .single()

        if (fetchError || !currentTxn) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
        }

        // Block voiding a claimed transaction — wallet has already been credited
        if ((currentTxn as any).status === 'claimed') {
            return NextResponse.json({
                error: 'Cannot modify a claimed transaction. The user\'s wallet has already been credited.'
            }, { status: 400 })
        }

        const { error } = await (supabase
            .from('momo_transactions') as any)
            .update({ status })
            .eq('id', id)

        if (error) throw error

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('Error updating momo transaction:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
