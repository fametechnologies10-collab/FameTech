/**
 * User SMS Platform — shared types (KFT SMS).
 * Mirrors supabase/migrations/20260706*, hand-maintained until the generated
 * types/supabase.ts is regenerated after the migrations are applied.
 */

export type SmsAccountMode = 'platform' | 'business'
export type SmsAccountStatus = 'active' | 'suspended'

export type SmsCampaignStatus =
    | 'queued' | 'processing' | 'completed' | 'partial'
    | 'failed' | 'blocked' | 'cancelled'

/** queued/sent = in flight; failed = provider rejected at send (refundable);
 *  delivered/undelivered/expired/rejected = DLR verdicts (not refundable). */
export type SmsMessageStatus =
    | 'queued' | 'sent' | 'delivered' | 'undelivered'
    | 'failed' | 'expired' | 'rejected'

export type SmsSenderStatus =
    | 'under_review' | 'submitted_to_hubtel' | 'approved' | 'rejected' | 'revoked'

export type SmsBusinessProfileStatus = 'draft' | 'under_review' | 'approved' | 'rejected' | 'revoked'

export type SmsLedgerKind = 'purchase' | 'debit' | 'refund' | 'bonus' | 'admin_adjust'

/** Bundle visibility scope: 'platform'/'business' bundles are mode-exclusive,
 *  'both' bundles are purchasable from either account mode. */
export type SmsBundleMode = 'platform' | 'business' | 'both'

export interface SmsAccount {
    id: string
    user_id: string
    mode: SmsAccountMode
    status: SmsAccountStatus
    suspended_reason: string | null
    default_sender: string | null
    /** Admin "hold business mode" (Task D4) — while true, a business-mode
     *  account is enforced as if it were platform mode everywhere policy is
     *  resolved (strict filter, platform sender only). Set/cleared only via
     *  the admin `set_business_hold` action. */
    business_on_hold: boolean
    /** User opt-in (Task E4): when true AND the account has ≥1 approved
     *  sender, THEIR OWN order-confirmation/completion SMS (data/RC/airtime/
     *  mashup) go out under their approved sender instead of the platform
     *  default. Resolved by `resolveOwnConfirmationSender` (lib/sms-confirmation-sender.ts). */
    use_own_sender_for_confirmations: boolean
    created_at: string
    updated_at: string
}

export interface SmsWallet {
    account_id: string
    credits: number
    total_purchased: number
    total_used: number
    updated_at: string
}

export interface SmsCreditLedgerRow {
    id: string
    account_id: string
    delta: number
    balance_after: number | null
    kind: SmsLedgerKind
    idempotency_key: string
    reference: string | null
    created_at: string
}

export interface SmsBundle {
    id: string
    name: string
    credits: number
    price: number
    business_price: number | null
    is_active: boolean
    sort_order: number
    mode: SmsBundleMode
}

export interface SmsCampaign {
    id: string
    account_id: string
    sender_used: string | null
    mode_at_send: SmsAccountMode
    message: string
    recipients_count: number
    segments: number
    credits_charged: number
    status: SmsCampaignStatus
    flagged: boolean
    flag_reason: string | null
    flag_severity: 'fraud' | 'info' | null
    scheduled_at: string | null
    claimed_at: string | null
    settled_at: string | null
    source: 'dashboard' | 'api'
    provider: string
    created_at: string
}

export interface SmsMessage {
    id: string
    campaign_id: string
    account_id: string
    recipient: string
    chunk_no: number
    provider: string
    provider_message_id: string | null
    status: SmsMessageStatus
    status_detail: string | null
    network_id: string | null
    rate: number | null
    status_updated_at: string | null
    created_at: string
}

export interface SmsSenderId {
    id: string
    account_id: string
    sender_text: string
    status: SmsSenderStatus
    is_default: boolean
    hubtel_reference: string | null
    rejection_reason: string | null
    requested_at: string
    approved_at: string | null
}

export interface SmsBusinessProfile {
    id: string
    account_id: string
    business_name: string
    description: string
    domain_link: string | null
    ghana_card_number_masked: string | null
    docs: Array<{ type: 'ghana_card' | 'business_cert' | 'form_a' | 'other'; path: string; uploaded_at: string }>
    status: SmsBusinessProfileStatus
    review_notes: string | null
    reviewed_at: string | null
    created_at: string
}

export interface SmsModeCaps {
    max_recipients_per_send: number
    sends_per_hour: number
    recipients_per_day: number
}

export const DEFAULT_SMS_CAPS: Record<SmsAccountMode, SmsModeCaps> = {
    platform: { max_recipients_per_send: 500, sends_per_hour: 10, recipients_per_day: 2000 },
    business: { max_recipients_per_send: 10000, sends_per_hour: 60, recipients_per_day: 100000 },
}

/** Bundles visible to an account of the given mode: same-mode bundles plus
 *  any 'both' bundle. Never surfaces the opposite mode's exclusive bundles. */
export function bundlesForMode(bundles: SmsBundle[], mode: SmsAccountMode): SmsBundle[] {
    return bundles.filter((b) => b.mode === mode || b.mode === 'both')
}

/** Purchase-time guard mirroring the DB's mode check on purchase_user_sms_credits:
 *  an account may buy a bundle only if the bundle is 'both' or matches its own mode. */
export function canPurchaseBundle(bundleMode: SmsBundleMode, accountMode: SmsAccountMode): boolean {
    return bundleMode === 'both' || bundleMode === accountMode
}
