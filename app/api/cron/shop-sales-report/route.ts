import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendShopSalesSummaryEmail } from '@/lib/email-service'
import { validateCronAuth } from '@/lib/cron-utils'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    try {
        // SEC-012: fail-closed cron auth (constant-time, 500 if secret unset)
        const authError = validateCronAuth(request)
        if (authError) return authError

        const { searchParams } = new URL(request.url)
        const type = (searchParams.get('type') || 'daily') as 'daily' | 'weekly' | 'monthly'

        const supabase = createServerClient()

        // 1. Calculate time range
        const now = new Date()
        let startDate = new Date()
        let dateRangeStr = ''

        if (type === 'daily') {
            startDate.setDate(now.getDate() - 1)
            startDate.setHours(0, 0, 0, 0)
            now.setHours(23, 59, 59, 999)
            now.setDate(now.getDate() - 1) // yesterday
            dateRangeStr = startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        } else if (type === 'weekly') {
            startDate.setDate(now.getDate() - 7)
            startDate.setHours(0, 0, 0, 0)
            dateRangeStr = `Past 7 Days (${startDate.toLocaleDateString('en-GB')} - ${now.toLocaleDateString('en-GB')})`
        } else if (type === 'monthly') {
            startDate.setMonth(now.getMonth() - 1)
            startDate.setHours(0, 0, 0, 0)
            dateRangeStr = `Past 30 Days (${startDate.toLocaleDateString('en-GB')} - ${now.toLocaleDateString('en-GB')})`
        }

        // 2. Fetch active shops
        const { data: shops, error: shopsError } = await supabase
            .from('shop_profiles')
            .select('id, shop_name, owner_id, owner:users!shop_profiles_owner_id_fkey(email, first_name)')
            .eq('approval_status', 'approved')

        if (shopsError || !shops) {
            console.error('[Shop Sales Cron] Failed to fetch shops:', shopsError)
            return NextResponse.json({ error: 'Failed to fetch shops' }, { status: 500 })
        }

        let sentCount = 0

        // 3. Process each shop
        for (const shop of (shops as any[])) {
            if (!shop.owner || !shop.owner.email) continue

            const ownerEmail = shop.owner.email
            const ownerFirstName = shop.owner.first_name || 'Partner'

            // Fetch orders for this shop in the time range
            const { data: orders, error: ordersError } = await supabase
                .from('shop_orders')
                .select('id, status, price, cost_price, profit, network')
                .eq('shop_id', shop.id)
                .gte('created_at', startDate.toISOString())
                .lte('created_at', now.toISOString())

            if (ordersError) {
                console.error(`[Shop Sales Cron] Failed to fetch orders for ${shop.shop_name}:`, ordersError)
                continue
            }

            if (!orders || orders.length === 0) {
                // Skip emailing if 0 orders to avoid spamming empty reports
                continue
            }

            const ordersList = orders as any[]
            const totalOrders = ordersList.length
            const successfulOrders = ordersList.filter(o => o.status === 'completed' || o.status === 'processing')
            const successfulCount = successfulOrders.length

            // Aggregate metrics
            let grossSales = 0
            let netProfit = 0
            const networkCounts: Record<string, number> = {}

            successfulOrders.forEach(o => {
                grossSales += Number(o.price || 0)
                // If profit column exists and is set, use it. Otherwise calculate.
                if (o.profit !== null && o.profit !== undefined) {
                    netProfit += Number(o.profit)
                } else {
                    netProfit += Number(o.price || 0) - Number(o.cost_price || 0)
                }

                // Count networks
                const net = o.network || 'Unknown'
                networkCounts[net] = (networkCounts[net] || 0) + 1
            })

            // Find top selling network
            let topSellingNetwork = 'N/A'
            let maxCount = 0
            for (const [net, count] of Object.entries(networkCounts)) {
                if (count > maxCount) {
                    maxCount = count
                    topSellingNetwork = net
                }
            }

            // Only send if there was at least one successful sale (optional rule, but good practice)
            // Or maybe they want to know even if all failed? We'll send it regardless if they had orders.
            
            // Send the email
            try {
                await sendShopSalesSummaryEmail(
                    ownerEmail,
                    ownerFirstName,
                    shop.shop_name,
                    type,
                    dateRangeStr,
                    {
                        totalOrders,
                        successfulOrders: successfulCount,
                        grossSales,
                        netProfit,
                        topSellingNetwork
                    }
                )
                sentCount++
            } catch (err) {
                console.error(`[Shop Sales Cron] Failed to send email to ${ownerEmail}:`, err)
            }
        }

        return NextResponse.json({ 
            success: true, 
            message: `Processed ${shops.length} shops, sent ${sentCount} ${type} reports.` 
        })

    } catch (error: any) {
        console.error('[Shop Sales Cron] Internal error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
