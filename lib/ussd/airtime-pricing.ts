// =============================================================================
// Pure USSD airtime pricing math (no I/O) — shared by the airtime handler and
// unit tests. Exact mode: the beneficiary receives `airtimeAmount`; the customer
// pays `airtimeAmount + fee`, where the fee = admin per-network fee (+ the shop's
// own markup for a shop USSD sale). Kept dependency-free so `tsx` can import it.
// =============================================================================

export const round2 = (n: number) => Math.round(n * 100) / 100

export function computeAirtimePricing(airtimeAmount: number, adminFeeRate: number, shopFeeRate: number) {
    const adminFeeAmount = round2(airtimeAmount * adminFeeRate / 100)
    const shopFeeAmount = round2(airtimeAmount * shopFeeRate / 100)
    const feeAmount = round2(adminFeeAmount + shopFeeAmount)
    const price = round2(airtimeAmount + feeAmount)
    return { adminFeeAmount, shopFeeAmount, feeAmount, price }
}
