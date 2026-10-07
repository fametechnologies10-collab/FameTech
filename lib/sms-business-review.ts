/**
 * Pure decision logic for sms_business_profiles review/revoke transitions.
 * No I/O – the admin/user API routes call these and act on the result.
 */

export type BusinessReviewDecision = 'approved' | 'rejected' | 'revoked'

const REVIEW_TRANSITIONS: Record<BusinessReviewDecision, { from: string; to: string }> = {
    approved: { from: 'under_review', to: 'approved' },
    rejected: { from: 'under_review', to: 'rejected' },
    revoked: { from: 'approved', to: 'revoked' },
}

/** The required current status → next status for a given admin decision. */
export function reviewTransitionFor(decision: BusinessReviewDecision): { from: string; to: string } {
    return REVIEW_TRANSITIONS[decision]
}

/**
 * Approval requires the admin to have already checked the "verified via
 * WhatsApp" box – server-enforced, not just a disabled button. Reject and
 * revoke carry no such requirement.
 */
export function validateBusinessReview(
    decision: BusinessReviewDecision,
    whatsappVerified: boolean,
): { ok: true } | { ok: false; error: string } {
    if (decision === 'approved' && !whatsappVerified) {
        return { ok: false, error: 'Confirm documents were verified via WhatsApp before approving' }
    }
    return { ok: true }
}

/**
 * A profile is locked from user self-edits only while under_review or
 * approved. Both rejected AND revoked stay resubmittable – there is no
 * cooldown or admin re-invite gate for either.
 */
export function isBusinessProfileLocked(status: string | null | undefined): boolean {
    return status === 'under_review' || status === 'approved'
}
