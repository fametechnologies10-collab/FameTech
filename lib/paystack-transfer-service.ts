// lib/paystack-transfer-service.ts
/**
 * Paystack Transfers (PAYOUT) service — MoMo only.
 * Isolated from collection code. Uses PAYSTACK_SECRET_KEY (same account/secret
 * that collects payments and signs webhooks). NEVER auto-sends; called by the
 * admin-gated process-withdrawal route.
 */
const PAYSTACK_BASE_URL = 'https://api.paystack.co'

// Ghana telco -> Paystack mobile_money bank_code. Confirm live via getMomoTelcos();
// these are the documented codes and serve as a safe fallback.
export const PAYSTACK_MOMO_BANK_CODE: Record<'MTN MoMo' | 'Telecel Cash' | 'AirtelTigo Money', string> = {
    'MTN MoMo': 'MTN',
    'Telecel Cash': 'VOD',   // Telecel = ex-Vodafone Ghana
    'AirtelTigo Money': 'ATL',
}

/** Stable, idempotent reference. Paystack: lowercase a-z 0-9 _ - , 16..50 chars. */
export function buildWithdrawalReference(txId: string): string {
    const ref = `kfg-wd-${txId.toLowerCase()}`
    if (ref.length < 16 || ref.length > 50) {
        throw new RangeError(`[PaystackTransfer] Reference out of bounds (${ref.length} chars): ${ref}`)
    }
    return ref
}

/** GHS -> pesewas (integer subunit). */
export function toPesewas(ghs: number): number {
    return Math.round(ghs * 100)
}

function authHeaders(): HeadersInit {
    const key = process.env.PAYSTACK_SECRET_KEY
    if (!key) throw new Error('[PaystackTransfer] PAYSTACK_SECRET_KEY is not configured.')
    return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
}

export async function createMomoRecipient(p: {
    name: string; momoNumber: string; network: keyof typeof PAYSTACK_MOMO_BANK_CODE
}): Promise<{ success: boolean; recipientCode: string | null; error?: string }> {
    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/transferrecipient`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({
                type: 'mobile_money',
                name: p.name,
                account_number: p.momoNumber,
                bank_code: PAYSTACK_MOMO_BANK_CODE[p.network],
                currency: 'GHS',
            }),
        })
        const data = await res.json()
        if (res.ok && data.status && data.data?.recipient_code) {
            return { success: true, recipientCode: data.data.recipient_code }
        }
        return { success: false, recipientCode: null, error: data.message || `HTTP ${res.status}` }
    } catch (err: any) {
        return { success: false, recipientCode: null, error: err.message || 'Network error' }
    }
}

export async function initiateTransfer(p: {
    amountGhs: number; recipientCode: string; reference: string; reason: string
}): Promise<{ success: boolean; status: string | null; transferCode: string | null; reference: string; error?: string }> {
    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({
                source: 'balance',
                amount: toPesewas(p.amountGhs),
                recipient: p.recipientCode,
                reference: p.reference,
                reason: p.reason,
            }),
        })
        const data = await res.json()
        // Duplicate reference => the transfer already exists (idempotent retry). Treat as in-flight, not error.
        if (!res.ok && /reference already exists/i.test(data?.message || '')) {
            const v = await verifyTransfer(p.reference)
            if (v.error) {
                return { success: false, status: null, transferCode: null, reference: p.reference, error: `Duplicate ref; verify failed: ${v.error}` }
            }
            return { success: true, status: v.status, transferCode: v.transferCode, reference: p.reference }
        }
        if (res.ok && data.status && data.data) {
            return { success: true, status: data.data.status ?? null, transferCode: data.data.transfer_code ?? null, reference: p.reference }
        }
        return { success: false, status: null, transferCode: null, reference: p.reference, error: data.message || `HTTP ${res.status}` }
    } catch (err: any) {
        return { success: false, status: null, transferCode: null, reference: p.reference, error: err.message || 'Network error' }
    }
}

export async function verifyTransfer(reference: string): Promise<{ status: string | null; transferCode: string | null; feeGhs: number | null; error?: string }> {
    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/transfer/verify/${encodeURIComponent(reference)}`, {
            method: 'GET', headers: authHeaders(),
        })
        const data = await res.json()
        if (res.ok && data.status && data.data) {
            const feeSub = data.data.fee_charged
            return {
                status: data.data.status ?? null,
                transferCode: data.data.transfer_code ?? null,
                feeGhs: typeof feeSub === 'number' ? feeSub / 100 : null,
            }
        }
        return { status: null, transferCode: null, feeGhs: null, error: data.message || `HTTP ${res.status}` }
    } catch (err: any) {
        return { status: null, transferCode: null, feeGhs: null, error: err.message }
    }
}

export async function getBalanceGhs(): Promise<number | null> {
    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/balance`, { method: 'GET', headers: authHeaders() })
        const data = await res.json()
        if (res.ok && Array.isArray(data.data)) {
            const ghs = data.data.find((b: any) => b.currency === 'GHS')
            return ghs ? ghs.balance / 100 : null
        }
        return null
    } catch { return null }
}

// CAUTION: caller MUST lock each row (status CAS) before invoking — this performs no idempotency/status guarding. Not currently wired; the admin bulk path uses serial single transfers in process-withdrawal.
export async function initiateBulkTransfer(p: {
    transfers: Array<{ amountGhs: number; recipientCode: string; reference: string; reason: string }>
}): Promise<{ success: boolean; results: Array<{ reference: string; status: string | null; transferCode: string | null }>; error?: string }> {
    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/transfer/bulk`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({
                currency: 'GHS', source: 'balance',
                transfers: p.transfers.map(t => ({
                    amount: toPesewas(t.amountGhs), recipient: t.recipientCode, reference: t.reference, reason: t.reason,
                })),
            }),
        })
        const data = await res.json()
        if (res.ok && data.status && Array.isArray(data.data)) {
            return { success: true, results: data.data
                .filter((d: any) => d && d.reference)
                .map((d: any) => ({ reference: d.reference, status: d.status ?? null, transferCode: d.transfer_code ?? null })) }
        }
        return { success: false, results: [], error: data.message || `HTTP ${res.status}` }
    } catch (err: any) {
        return { success: false, results: [], error: err.message || 'Network error' }
    }
}
