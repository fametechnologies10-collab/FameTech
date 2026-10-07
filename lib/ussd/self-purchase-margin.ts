const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Recruiter margin for a sub-agent's own non-shop USSD purchase. The sub is quoted
 * `subPrice` (recruiter-derived cost) plus the global USSD fee, which the platform keeps.
 * If what was paid matches that quote, the margin is the resolved `recruiterEarns`; if the
 * price moved between quote and payment, re-derive it from the fee-stripped amount paid.
 */
export function deriveSelfPurchaseMargin(p: {
    paid: number
    feePercent: number
    subPrice: number
    recruiterEarns: number
}): { amount: number; drifted: boolean } {
    const fee = p.feePercent > 0 ? p.feePercent : 0
    const expected = round2(p.subPrice * (1 + fee / 100))
    if (Math.abs(p.paid - expected) <= 0.01) {
        return { amount: round2(p.recruiterEarns), drifted: false }
    }
    const paidBase = p.paid / (1 + fee / 100)
    const recruiterCost = p.subPrice - p.recruiterEarns
    return { amount: round2(Math.max(0, paidBase - recruiterCost)), drifted: true }
}
