/**
 * Shop SMS message preparation — the single source of truth for turning a
 * composed shop message into the exact text that is delivered to recipients.
 *
 * Both the live "Recipient preview" in the dashboard and the server-side send
 * route MUST run a message through `prepareSmsMessage` so that what the shop
 * owner sees in the preview is byte-for-byte what the customer receives.
 *
 * Two transforms are applied, in order:
 *   1. substituteShopTokens — replace {shop_name} / {shop_link} / {shop_phone}
 *      / {shop_whatsapp} with the shop's real branding.
 *   2. stripUndeliverableChars — remove characters SMS cannot deliver (color
 *      emoji), which Ghanaian gateways otherwise replace with "?".
 */

export interface ShopBrandTokens {
    shopName?: string | null
    shopSlug?: string | null
    shopPhone?: string | null
    shopWhatsapp?: string | null
}

/** Canonical public storefront host — matches the middleware shop-subdomain rewrite. */
const SHOP_LINK_HOST = 'shop.kingflexygh.com'

/**
 * Replace branding tokens with the shop's real values.
 *
 * Mirrors the dashboard preview exactly. A missing value collapses to an empty
 * string (the token disappears) rather than leaving a raw `{token}` in the SMS.
 */
export function substituteShopTokens(message: string, shop: ShopBrandTokens): string {
    const name     = (shop.shopName ?? '').trim()
    const slug     = (shop.shopSlug ?? '').trim()
    const phone    = (shop.shopPhone ?? '').trim()
    const whatsapp = ((shop.shopWhatsapp ?? '') || (shop.shopPhone ?? '')).trim()

    return message
        .replace(/\{shop_name\}/gi,     name)
        .replace(/\{shop_link\}/gi,     slug ? `${SHOP_LINK_HOST}/${slug}` : '')
        .replace(/\{shop_phone\}/gi,    phone)
        .replace(/\{shop_whatsapp\}/gi, whatsapp)
}

// Astral-plane code points (> U+FFFF): all modern colour emoji, regional
// indicators (flags) and skin-tone modifiers. SMS uses UCS-2 (16-bit, BMP
// only) for non-GSM text, so these cannot be encoded and GH gateways deliver
// them as "?". We drop them so customers receive clean text.
const ASTRAL_CHARS = /[\u{10000}-\u{10FFFF}]/gu
// Emoji presentation helpers that would be orphaned once their base/astral
// char is removed: ZWJ (U+200D), variation selectors (U+FE0E/U+FE0F),
// combining enclosing keycap (U+20E3).
const EMOJI_MODIFIERS = /[\u200D\uFE0E\uFE0F\u20E3]/g

/**
 * Remove characters the SMS channel cannot deliver (color emoji) so they never
 * arrive as "?". BMP text such as accented letters and basic symbols is left
 * untouched because those encode fine over UCS-2.
 *
 * When nothing is removed the input is returned unchanged (so ordinary
 * messages are never reformatted). When emoji are stripped, the stray spacing
 * they leave behind is tidied up while preserving line breaks.
 */
export function stripUndeliverableChars(message: string): string {
    const stripped = message.replace(ASTRAL_CHARS, '').replace(EMOJI_MODIFIERS, '')
    if (stripped === message) return message

    return stripped
        .replace(/[ \t]{2,}/g, ' ') // collapse runs of spaces/tabs left behind
        .replace(/ +(\n)/g, '$1')   // drop trailing spaces before a newline
        .replace(/(\n) +/g, '$1')   // drop leading spaces after a newline
        .trim()
}

/**
 * Produce the final SMS text exactly as it will be delivered: tokens
 * substituted, then undeliverable characters stripped.
 */
export function prepareSmsMessage(message: string, shop: ShopBrandTokens): string {
    return stripUndeliverableChars(substituteShopTokens(message, shop))
}
