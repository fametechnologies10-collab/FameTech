/**
 * KFT SMS — merged sendable-sender set (feature-wave7).
 *
 * A PLATFORM-mode KFT SMS account may ALSO send under its owner's own
 * APPROVED shop sender ID. This is the single seam that merges an account's
 * own `sms_sender_ids` rows with the caller's shop's approved
 * `shop_sender_ids` row(s) (falling back to the legacy `shop_profiles`
 * mirror column when no `shop_sender_ids` rows exist yet), so every
 * `resolveSmsPolicy` caller sees one unified sendable set.
 *
 * MODE-AWARE (owner constraint — "keep business mode the same"): the shop
 * sender is fetched/merged ONLY when `mode === 'platform'`. BUSINESS-mode
 * accounts (including admin-held business accounts, which are
 * `mode === 'business'`) get EXACTLY their own `sms_sender_ids` rows —
 * byte-unchanged from before this wave. Callers MUST pass the account's REAL
 * mode so a held business account never gains a shop sender.
 *
 * Scoping: the shop lookup is keyed strictly by `owner_id = userId` — this
 * NEVER returns another user's sender. NEVER throws: any shop-lookup error
 * degrades to the KFT-only rows (or `[]`), logged but not surfaced — a
 * shop-lookup failure must never block campaign creation or dispatch.
 */

import type { SmsAccountMode } from '@/lib/sms-platform-types'

export interface SendableSenderRow {
    sender_text: string
    status: string
    is_default: boolean
}

/**
 * `db` must be a SERVICE-ROLE client. Fetches the account's own
 * `sms_sender_ids` rows (ANY status — callers filter, e.g. by 'approved').
 * For PLATFORM mode ONLY, it also merges in the owner's approved shop
 * sender(s), deduped by normalized (trim+lowercase) `sender_text`; a
 * `sms_sender_ids` row always WINS over a shop duplicate of the same name
 * (keeps its real status/is_default) — it is the authoritative KFT-side
 * record. For BUSINESS mode the shop sender is never fetched or merged.
 */
export async function getSendableSenderRows(
    db: any,
    userId: string,
    accountId: string,
    mode: SmsAccountMode
): Promise<SendableSenderRow[]> {
    const { data: kftRows, error: kftErr } = await db
        .from('sms_sender_ids')
        .select('sender_text, status, is_default')
        .eq('account_id', accountId)
    if (kftErr) {
        console.error('[getSendableSenderRows] sms_sender_ids fetch failed:', kftErr.message)
    }

    const merged: SendableSenderRow[] = ((kftRows as SendableSenderRow[]) || []).map(r => ({
        sender_text: r.sender_text,
        status: r.status,
        is_default: r.is_default,
    }))

    // Business mode (and held business, which is mode==='business') keeps
    // EXACTLY its own sms_sender_ids rows — the shop sender is platform-only.
    if (mode !== 'platform') return merged

    const seen = new Set(merged.map(r => r.sender_text.trim().toLowerCase()))

    try {
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, sms_sender_id, sms_sender_status')
            .eq('owner_id', userId)
            .maybeSingle()
        if (!shop) return merged
        const shopId = (shop as any).id

        const { data: shopSenderRows, error: shopErr } = await db
            .from('shop_sender_ids')
            .select('sender_text')
            .eq('shop_id', shopId)
            .eq('status', 'approved')
        if (shopErr) {
            console.error('[getSendableSenderRows] shop_sender_ids fetch failed:', shopErr.message)
        }

        let shopSenderTexts = (((shopSenderRows as { sender_text: string }[]) || []).map(r => r.sender_text))
        // Fallback: no shop_sender_ids rows yet (or the query itself failed) —
        // use the legacy shop_profiles mirror column when it is approved.
        if (shopSenderTexts.length === 0 && (shop as any).sms_sender_status === 'approved' && (shop as any).sms_sender_id) {
            shopSenderTexts = [(shop as any).sms_sender_id as string]
        }

        for (const text of shopSenderTexts) {
            const key = text.trim().toLowerCase()
            if (seen.has(key)) continue // a KFT row already owns this name — it wins
            seen.add(key)
            merged.push({ sender_text: text, status: 'approved', is_default: false })
        }
        return merged
    } catch (err: any) {
        console.error('[getSendableSenderRows] shop lookup failed (degrading to KFT rows):', err?.message)
        return merged
    }
}
