// Pure types — no imports, no logic.
// Mirrors server route shapes exactly (GET /api/admin/withdrawals + GET /api/admin/shop-credits).

export interface WithdrawalRow {
  id: string
  amount: number
  fee: number | null
  net_amount: number | null
  account_name: string | null
  momo_number: string | null
  account_number: string | null
  bank_name: string | null
  branch: string | null
  network: string | null
  payment_type: 'momo' | 'bank' | null
  status:
    | 'pending'
    | 'moolre_pending'
    | 'paystack_pending'
    | 'completed'
    | 'failed'
    | 'reversed'
  payout_provider: 'moolre' | 'paystack' | 'manual' | null
  moolre_transaction_id: string | null
  paystack_transfer_code: string | null
  paystack_transfer_reference: string | null
  paystack_transfer_status: string | null
  paystack_fee: number | null
  processed_by: string | null
  processed_at: string | null
  failure_reason: string | null
  balance_snapshot: number | null
  description: string | null
  created_at: string
  /** Derived server-side — true when description contains '[UNVERIFIED-NAME]' */
  name_unverified: boolean
  shop: {
    shop_name: string
    owner_id: string | null
    owner_name: string
    owner_email: string
    owner_phone: string
  }
}

export interface CreditRow {
  id: string
  shop_wallet_id: string
  owner_id: string
  shop_id: string | null
  shop_name: string
  owner_name: string
  owner_email: string
  owner_phone: string
  amount: number
  expected_amount: number | null
  created_at: string
  shop_order_id: string | null
  order_ref: string | null
  order_status: string | null
  network: string | null
  package_size: string | null
  guest_phone: string | null
  credit_source: string
  risk_status: 'green' | 'amber' | 'red'
  risk_reasons: string[]
}

export interface Rollups {
  green_total: number
  amber_total: number
  red_total: number
  red_count: number
}
