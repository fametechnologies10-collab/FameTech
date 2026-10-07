export type PaymentSource = 'main' | 'shop' | 'results_checker'

export interface SourceStat {
  completed_count: number
  completed_amount: number
  pending_count: number
  pending_amount: number
  failed_count: number
}
export interface StatsResponse {
  main: SourceStat
  shop: SourceStat
  results_checker: SourceStat
}

export interface PendingRow {
  reference: string
  source: PaymentSource
  status: string
  amount: number
  customer: string
  createdAt: string
  orderId?: string
}

export type ReconState =
  | 'reconciled' | 'paid_unsettled' | 'mismatch' | 'in_flight' | 'failed' | 'unknown'

export interface ReconRow {
  reference: string
  source: PaymentSource
  paystackStatus: string
  amount: number
  customer: string
  channel?: string
  paidAt?: string
  dbState: 'processed' | 'pending' | 'missing' | 'failed'
  reconState: ReconState
}

export const SOURCE_LABEL: Record<PaymentSource, string> = {
  main: 'Main', shop: 'Shop', results_checker: 'Results-Checker',
}
