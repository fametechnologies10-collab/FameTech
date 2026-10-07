import type { UtilityBiller } from '@/lib/hubtel-utility/billers'

/** Mirrors utility_orders.status / admin route's VALID_STATUS allowlist. */
export type UtilityOrderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'

export interface UtilityConfig {
    enabled: boolean
    billers: Record<UtilityBiller, boolean>
    minAmount: number
    maxAmount: number
}

export interface UtilitySavedAccount {
    id: string
    user_id: string
    biller: UtilityBiller
    account_number: string
    account_name: string | null
    destination_phone: string | null
    label: string | null
    last_paid_at: string | null
    last_amount: number | null
    created_at: string
}

/** ECG meter row from a "find my meters" lookup. */
export interface UtilityLookupMeter {
    name: string
    meterNumber: string
    outstanding: number
}

/**
 * Client-safe lookup result — the shape returned by POST /api/utilities/lookup
 * (UtilityAccountInfo with sessionId always stripped to null by the server).
 */
export interface UtilityLookupInfo {
    accountName: string | null
    accountNumber: string | null
    amountDue: number | null // negative = customer credit balance
    bouquet: string | null // startimes only
    sessionId: null
    meters: UtilityLookupMeter[] // ecg only; empty otherwise
    raw: Array<{ Display: string; Value: string; Amount: number }>
}

export interface UtilityOrderRow {
    id: string
    biller: UtilityBiller
    account_number: string
    account_name: string | null
    amount: number
    status: string
    payment_status: string
    payment_method: string
    reference_code: string
    created_at: string
    updated_at: string
}
