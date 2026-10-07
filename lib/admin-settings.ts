/**
 * Shared definitions for admin system-settings control.
 *
 * Single source of truth for which settings keys are safe to flip from the
 * dashboard System Control Center. The server toggle route, the audit trigger
 * (mirrored in SQL), and the UI all reference this list so they cannot drift.
 */

/** Settings keys that may be flipped via /api/admin/settings/toggle (admin-only). */
export const CRITICAL_TOGGLE_KEYS = [
    'auto_fulfillment_enabled',
    'ussd_enabled',
    'phone_verification_enabled',
    'page_access_storefront',
    'mtn_express_delivery_enabled',
    'number_registration_gate_enabled',
    'mtn_agentportal_whitelist_gate_enabled',
    'mtn_bundleportal_whitelist_gate_enabled',
] as const

export type ToggleKey = (typeof CRITICAL_TOGGLE_KEYS)[number]

/** Type guard: is this an allowlisted toggle key? */
export function isToggleKey(key: unknown): key is ToggleKey {
    return typeof key === 'string' && (CRITICAL_TOGGLE_KEYS as readonly string[]).includes(key)
}

/** Coerce any truthy/string representation into the canonical 'true' | 'false' string. */
export function coerceBool(value: unknown): 'true' | 'false' {
    return value === true || value === 'true' ? 'true' : 'false'
}

/** Read-only money-config keys surfaced (but not editable) on the dashboard. */
export const MONEY_CONFIG_KEYS = [
    'paystack_fee_percent',
    'agent_paystack_fee_percent',
    'dealer_paystack_fee_percent',
    'paystack_min_topup',
    'paystack_max_topup',
    'mtn_price_adjustment',
] as const

/** Human-friendly labels + deep-link tab for the read-only money config grid. */
export const TOGGLE_META: Record<ToggleKey, { label: string; description: string }> = {
    auto_fulfillment_enabled: {
        label: 'Auto-Fulfillment',
        description: 'Automatically process data orders via fulfillment APIs',
    },
    ussd_enabled: {
        label: 'USSD Service',
        description: 'Master switch for *713*9939# USSD service',
    },
    phone_verification_enabled: {
        label: 'Phone Verification',
        description: 'Require SMS OTP on signup',
    },
    page_access_storefront: {
        label: 'Public Storefront',
        description: 'Disabling takes all shops offline',
    },
    mtn_express_delivery_enabled: {
        label: 'MTN Express Delivery',
        description: 'Route MTN data orders via the DataKazina express product line (network_id 6)',
    },
    number_registration_gate_enabled: {
        label: 'MTN Number Registration Gate',
        description: 'Hold orders to unregistered MTN numbers as "queued" until the supplier confirms registration',
    },
    mtn_agentportal_whitelist_gate_enabled: {
        label: 'MTN Whitelist Gate — Server 1 (AgentPortal)',
        description: 'Make Server 1 an active whitelist server: MTN purchases are blocked unless the number is registered on an active server (independent of the Number Registration Gate above)',
    },
    mtn_bundleportal_whitelist_gate_enabled: {
        label: 'MTN Whitelist Gate — Server 2 (Bundle Portal)',
        description: 'Make Server 2 an active whitelist server: MTN purchases are blocked unless the number is registered on an active server. Works alone or with Server 1 (registered on either active server passes)',
    },
}
