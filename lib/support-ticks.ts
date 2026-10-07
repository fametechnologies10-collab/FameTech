// Tick-state derivation for support_messages, mirroring WhatsApp's
// sent -> delivered -> read progression using in-app data only (no real
// WhatsApp Business API involved — see docs/superpowers/specs).

export type MessageTickState = 'sent' | 'delivered' | 'read'

export interface DirectionalReceipt {
    delivered_to_user_at: string | null
    delivered_to_admin_at: string | null
    read_by_user_at: string | null
    read_by_admin_at: string | null
}

/**
 * A message's tick state is always relative to its counterpart (the role
 * that did NOT send it) — an admin message is ticked by the user's
 * delivered/read columns, and vice versa.
 */
export function getCounterpartReceipt(
    senderRole: 'user' | 'admin',
    row: DirectionalReceipt
): { delivered_at: string | null; read_at: string | null } {
    return senderRole === 'admin'
        ? { delivered_at: row.delivered_to_user_at, read_at: row.read_by_user_at }
        : { delivered_at: row.delivered_to_admin_at, read_at: row.read_by_admin_at }
}

export function getMessageTickState(receipt: { delivered_at: string | null; read_at: string | null }): MessageTickState {
    if (receipt.read_at) return 'read'
    if (receipt.delivered_at) return 'delivered'
    return 'sent'
}
