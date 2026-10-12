import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
    try {
        // 1. AUTHENTICATE USER
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // 2. VERIFY ADMIN ROLE
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden - Admin access required' }, { status: 403 })
        }

        // 3. CONTINUE WITH PRICE UPDATE LOGIC
        const body = await request.json()
        const { prices, dealerPrice, dealerPrice1m, dealerPrice3m, showStrikethrough } = body

        if (!prices) {
            return NextResponse.json({ error: 'Prices are required' }, { status: 400 })
        }

        // Every price that will be stored must be a finite, positive GHS amount. Anything else
        // ("NaN", 0, negative) would otherwise be saved and then rejected (fail-closed) at checkout.
        const candidatePrices: Record<string, unknown> = {
            '3d': prices['3d'], '14d': prices['14d'], '30d': prices['30d'], 'permanent': prices['permanent'],
            ...(dealerPrice !== undefined ? { dealer6m: dealerPrice } : {}),
            ...(dealerPrice1m !== undefined ? { dealer1m: dealerPrice1m } : {}),
            ...(dealerPrice3m !== undefined ? { dealer3m: dealerPrice3m } : {}),
        }
        for (const [label, raw] of Object.entries(candidatePrices)) {
            const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
            if (!Number.isFinite(n) || n <= 0 || n > 100000) {
                return NextResponse.json({ error: `Invalid price for ${label}` }, { status: 400 })
            }
        }

        // Create admin client with service role key to bypass RLS
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )

        // First, fetch current prices to move them to old prices
        const { data: currentData } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['agent_upgrade_price_3d', 'agent_upgrade_price_14d', 'agent_upgrade_price_30d', 'agent_upgrade_price_permanent'])

        // Store current prices as old prices (only if they exist and are different)
        const oldPriceUpdates = []
        if (currentData) {
            const current3d = currentData.find(s => s.key === 'agent_upgrade_price_3d')?.value
            const current14d = currentData.find(s => s.key === 'agent_upgrade_price_14d')?.value
            const current30d = currentData.find(s => s.key === 'agent_upgrade_price_30d')?.value
            const currentPermanent = currentData.find(s => s.key === 'agent_upgrade_price_permanent')?.value

            if (current3d && current3d !== String(prices['3d'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_3d_old', value: current3d })
            }
            if (current14d && current14d !== String(prices['14d'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_14d_old', value: current14d })
            }
            if (current30d && current30d !== String(prices['30d'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_30d_old', value: current30d })
            }
            if (currentPermanent && currentPermanent !== String(prices['permanent'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_permanent_old', value: currentPermanent })
            }
        }

        // New prices (old-price snapshots are folded into the same atomic upsert below)
        const updates: Array<{ key: string; value: any }> = [
            { key: 'agent_upgrade_price_3d', value: String(prices['3d']) },
            { key: 'agent_upgrade_price_14d', value: String(prices['14d']) },
            { key: 'agent_upgrade_price_30d', value: String(prices['30d']) },
            { key: 'agent_upgrade_price_permanent', value: String(prices['permanent']) }
        ]

        // Update strikethrough toggle if provided
        if (showStrikethrough !== undefined) {
            updates.push({ key: 'show_price_strikethrough', value: String(showStrikethrough) })
        }

        if (dealerPrice !== undefined) {
            updates.push({ key: 'dealer_upgrade_price_6m', value: String(dealerPrice) })
        }
        if (dealerPrice1m !== undefined) {
            updates.push({ key: 'dealer_upgrade_price_1m', value: String(dealerPrice1m) })
        }
        if (dealerPrice3m !== undefined) {
            updates.push({ key: 'dealer_upgrade_price_3m', value: String(dealerPrice3m) })
        }

        // ONE atomic upsert. The previous delete-then-insert per key left a window in which the
        // price row didn't exist, during which the purchase flow fell back to its hardcoded default
        // price (and a failure mid-loop left the prices half-updated).
        const { error: upsertError } = await supabaseAdmin
            .from('admin_settings')
            .upsert([...oldPriceUpdates, ...updates] as any, { onConflict: 'key' })

        if (upsertError) {
            console.error('Error updating prices:', upsertError)
            return NextResponse.json({ error: 'Failed to update prices' }, { status: 500 })
        }

        // Verify the updates
        const { data: verifyData, error: verifyError } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['agent_upgrade_price_3d', 'agent_upgrade_price_14d', 'agent_upgrade_price_30d', 'agent_upgrade_price_permanent'])

        if (verifyError) {
            console.error('Verification error:', verifyError)
        }

        const verified = {
            '3d': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_3d')?.value || prices['3d'],
            '14d': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_14d')?.value || prices['14d'],
            '30d': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_30d')?.value || prices['30d'],
            'permanent': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_permanent')?.value || prices['permanent']
        }

        return NextResponse.json({
            success: true,
            verified,
            message: `Prices updated: 3d=GHS${verified['3d']}, 14d=GHS${verified['14d']}, 30d=GHS${verified['30d']}, permanent=GHS${verified['permanent']}`
        })

    } catch (error: any) {
        console.error('Error in update-prices API:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
