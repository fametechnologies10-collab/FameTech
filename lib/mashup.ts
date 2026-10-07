/**
 * Special MTN Mashup helpers. Mashup packages/orders are tagged with
 * MASHUP_CATEGORY and are fulfilled MANUALLY — never by the auto-fulfillment
 * pipeline. Keep this logic centralized so every call site agrees.
 */
export const MASHUP_CATEGORY = 'mtn_mashup'

export function isMashupCategory(category: string | null | undefined): boolean {
    return category === MASHUP_CATEGORY
}

/** Orders that are NOT Special MTN Mashup auto-fulfill as today. Mashup does not. */
export function shouldAutoFulfill(category: string | null | undefined): boolean {
    return !isMashupCategory(category)
}
