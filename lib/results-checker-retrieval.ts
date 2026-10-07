import { createServerClient } from '@/lib/supabase'
import {
    normalizeResultsCheckerPhone,
    type ResultsCheckerVoucher,
} from '@/lib/results-checker-utils'

export interface ResultsCheckerRetrievedOrder {
    id: string
    reference_code: string
    type_name: string
    quantity: number
    total_paid: number
    status: string
    payment_status: string
    created_at: string
    customer_phone: string | null
    customer_email: string | null
    inventory_ids: string[]
}

type RetrievalResult = {
    order: ResultsCheckerRetrievedOrder
    vouchers: ResultsCheckerVoucher[]
}

function reorderVouchers(
    inventoryIds: string[],
    vouchers: Array<{ id: string; pin: string; serial_number: string }>
): ResultsCheckerVoucher[] {
    const voucherMap = new Map(vouchers.map((voucher) => [voucher.id, voucher]))

    return inventoryIds
        .map((inventoryId) => voucherMap.get(inventoryId))
        .filter(Boolean)
        .map((voucher) => ({
            pin: voucher!.pin,
            serial_number: voucher!.serial_number,
        }))
}

async function fetchVouchers(inventoryIds: string[]): Promise<ResultsCheckerVoucher[]> {
    if (!inventoryIds.length) {
        return []
    }

    const db = createServerClient() as any
    const { data, error } = await db
        .from('results_checker_inventory')
        .select('id, pin, serial_number')
        .in('id', inventoryIds)

    if (error || !data) {
        console.error('[RC Retrieval] Voucher fetch error:', error)
        return []
    }

    return reorderVouchers(inventoryIds, data)
}

export async function getResultsCheckerOrderForUser(
    orderId: string,
    userId: string
): Promise<RetrievalResult | null> {
    const db = createServerClient() as any
    const { data, error } = await db
        .from('results_checker_orders')
        .select(`
            id,
            reference_code,
            type_name,
            quantity,
            total_paid,
            status,
            payment_status,
            created_at,
            customer_phone,
            customer_email,
            inventory_ids
        `)
        .eq('id', orderId)
        .eq('user_id', userId)
        .single()

    if (error || !data) {
        return null
    }

    const order = data as ResultsCheckerRetrievedOrder
    const vouchers = order.status === 'completed' && order.payment_status === 'completed'
        ? await fetchVouchers(order.inventory_ids || [])
        : []

    return { order, vouchers }
}

export async function getResultsCheckerOrderForGuest(
    reference: string,
    phone: string
): Promise<RetrievalResult | null> {
    const db = createServerClient() as any
    const { data, error } = await db
        .from('results_checker_orders')
        .select(`
            id,
            reference_code,
            type_name,
            quantity,
            total_paid,
            status,
            payment_status,
            created_at,
            customer_phone,
            customer_email,
            inventory_ids
        `)
        .eq('reference_code', reference)
        .single()

    if (error || !data) {
        return null
    }

    const order = data as ResultsCheckerRetrievedOrder
    const expectedPhone = normalizeResultsCheckerPhone(phone)
    const actualPhone = normalizeResultsCheckerPhone(order.customer_phone || '')

    if (!actualPhone || actualPhone !== expectedPhone) {
        return null
    }

    const vouchers = order.status === 'completed' && order.payment_status === 'completed'
        ? await fetchVouchers(order.inventory_ids || [])
        : []

    return { order, vouchers }
}
