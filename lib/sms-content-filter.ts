/**
 * Shop SMS content filter — server-side gate against fraudulent or abusive
 * broadcasts. Conservative by design: blocks clear fraud signals, flags
 * borderline content for admin review.
 *
 * Hardened 2026-06-16 over two adversarial red-team rounds. Layers:
 *   1. NORMALIZATION (detection-only copy): NFKC fold, zero-width strip,
 *      homoglyph/confusables fold (Cyrillic о→o etc.), leetspeak fold
 *      (j4ckpot→jackpot), repeat-collapse (piiin→pin) and single-letter
 *      de-spacing across ANY non-alphanumeric run (p i n / p.i.n / p,i,n /
 *      p/i/n / p🔑i🔑n → pin).
 *   2. LINK ALLOWLIST: host-based. De-fangs obfuscated/percent-encoded dots,
 *      blocks raw IPs and non-ASCII (homoglyph) hosts, recognises exotic scam
 *      TLDs + shorteners, yet does not mistake run-on prose ("data.Store your
 *      bundles") for a link.
 *   3. FRAUD PATTERNS: direction-aware fake receipts (inbound money vs. outbound
 *      promo), phishing/credential, reversal scams, prizes.
 *
 * Enforcement happens at ONE choke point: app/api/shop/sms/send/route.ts, on the
 * PREPARED text (after {shop_link}→shop.kingflexygh.com/<slug>).
 *
 * Admin controls (shop_global_settings): sms_blocked_keywords (CONTAINS) and
 * sms_allowed_link_domains (extra social domains).
 */

export interface FilterResult {
    blocked: boolean
    flagged: boolean
    reason: string | null
    /** Present on flagged results: 'fraud' = demoted fraud-layer hit (business
     *  mode), 'info' = generic marketing-tone flag. Blocked results are always
     *  fraud-grade. */
    severity?: 'fraud' | 'info'
}

/**
 * Filter profiles:
 *  - 'strict'     (default): full filter — link allowlist + every fraud layer
 *                 blocks. Shop SMS and platform-mode user SMS.
 *  - 'telco-only': business-mode user SMS (own/pool sender ID, link freedom).
 *                 BLOCKS only telco transaction-message impersonation, reversal
 *                 social engineering, and admin keywords. Phishing/prize/link-
 *                 hazard layers are demoted to FLAG-ONLY (delivered, surfaced
 *                 to admin with severity 'fraud'). The generic merchant-receipt
 *                 grammar (INBOUND_RE) is NOT applied, so legitimate business
 *                 receipts ("Payment received: GHS 150 school fees") deliver.
 */
export type FilterPolicy = 'strict' | 'telco-only'

export interface FilterOptions {
    blockedKeywords?: string[]
    /** Flag-only admin list (e.g. business-mode flagged keywords) — matches
     *  demote to `{ flagged: true, severity: 'info' }`, NEVER block. Independent
     *  of `blockedKeywords`; checked after it so an explicit block always wins
     *  if a term sits on both lists. */
    flaggedKeywords?: string[]
    allowedDomains?: string[]
    policy?: FilterPolicy
}

// ════════════════════════════════════════════════════════════════════════════
// Normalization (defeats obfuscation; used only for fraud detection)
// ════════════════════════════════════════════════════════════════════════════

const ZERO_WIDTH_RE = /[​-‍﻿­]/g
const LEET_MAP: Record<string, string> = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i',
}
// Common Cyrillic/Greek look-alikes → ASCII (after lowercasing).
const CONFUSABLES: Record<string, string> = {
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
    'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ο': 'o',
    'α': 'a', 'ε': 'e', 'ρ': 'p', 'τ': 't', 'ν': 'v', 'κ': 'k', 'μ': 'm', 'χ': 'x', 'ι': 'i',
}

function deconfuse(s: string): string {
    return s.replace(/[Ѐ-ӿͰ-Ͽ]/g, c => CONFUSABLES[c] ?? c)
}
/** Strip diacritics (á→a, ó→o) so accented keywords still match. Twi base
 *  letters (ɛ, ɔ) have no canonical decomposition and are left untouched. */
function stripDiacritics(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}
/** Fold leetspeak ONLY between two letters (keeps "GHS 500"). */
function leetFold(s: string): string {
    return s.replace(/(?<=[a-z])[0134579@$!](?=[a-z])/gi, c => LEET_MAP[c] ?? c)
}
/** Join single-letter runs split by any non-alphanumeric gap (incl. newlines):
 *  "p i n" / "p.i.n" / "p,i,n" / "p/i/n" / "p🔑i🔑n" / "p\ni\nn" → pin.
 *  (Single-letter only — joining 2-letter fragments over-absorbs trailing words
 *  like "p i n to" → "pinto"; the rare 2-letter split is left to admin keywords.) */
function despaceSingleLetters(s: string): string {
    return s.replace(/\b[a-z](?:[^a-z0-9]{1,3}[a-z]\b)+/gi, m => m.replace(/[^a-z0-9]/gi, ''))
}
/** Detection-only normalized copy for word/phrase patterns.
 *  Exported for sender-ID reserved-name validation (lib/sms-sender-validation). */
export function normalizeForWords(message: string): string {
    let s = stripDiacritics(message.normalize('NFKC')).replace(ZERO_WIDTH_RE, '').toLowerCase()
    s = deconfuse(s)
    s = leetFold(s)
    s = s.replace(/([a-z])\1{2,}/g, '$1')   // collapse 3+ repeats: piiin→pin
    s = despaceSingleLetters(s)
    return s
}

// ════════════════════════════════════════════════════════════════════════════
// Link allowlist
// ════════════════════════════════════════════════════════════════════════════

const KINGFLEXY_DOMAINS = ['kingflexygh.com']

export const DEFAULT_ALLOWED_LINK_DOMAINS = [
    'whatsapp.com', 'wa.me', 'chat.whatsapp.com',
    'facebook.com', 'fb.com', 'fb.me', 'm.facebook.com', 'instagram.com', 'instagr.am',
    'twitter.com', 'x.com',
    't.me', 'telegram.me', 'telegram.org',
]

export const URL_SHORTENERS = [
    'bit.ly', 'tinyurl.com', 't.co', 'cutt.ly', 'shorturl.at', 'rb.gy', 'is.gd', 'v.gd',
    'ow.ly', 'buff.ly', 'lnkd.in', 's.id', 'goo.gl', 'rebrand.ly', 'tiny.cc', 'shorte.st',
    'tr.im', 'qr.ae', 't.ly', 'qr.codes',
]

/** Real infrastructure TLDs — recognised on a BARE (scheme-less) host. Excludes
 *  word-colliding TLDs so run-on prose ("data.Store …") isn't mistaken for a link. */
const INFRA_TLDS = new Set([
    'com', 'net', 'org', 'io', 'co', 'gh', 'cm', 'info', 'biz', 'xyz', 'site', 'app', 'dev',
    'page', 'web', 'africa', 'ng', 'ru', 'cn', 'in', 'uk', 'us', 'click', 'im', 'gd', 'ae',
    'ly', 'gy', 'id', 'gl', 'st', 'tk', 'ml', 'ga', 'cf', 'icu', 'sbs', 'cfd', 'rest', 'fun',
    'space', 'website', 'digital', 'link', 'codes',
])
const MULTI_TLDS = new Set(['com.gh', 'org.gh', 'edu.gh', 'gov.gh', 'co.uk'])

const IPV4_RE = /(?:https?:\/\/|www\.)?\b(?:\d{1,3}\.){3}\d{1,3}\b/i
// Host token containing a Cyrillic/Greek look-alike → homoglyph spoof.
const HOMOGLYPH_HOST_RE = /[a-z0-9-]*[Ѐ-ӿͰ-Ͽ][a-z0-9-]*(?:\.[a-z0-9Ѐ-ӿͰ-Ͽ-]+)*\.[a-z]{2,}/i

/** Normalise obfuscated/defanged/encoded dots so host extraction sees real domains. */
function defang(s: string): string {
    return s
        .replace(/%2e/gi, '.').replace(/%2f/gi, '/')   // percent-encoded . and /
        .replace(/[([{]\s*\.\s*[)\]}]/g, '.')          // [.]  (.)  {.}
        .replace(/\s*[([]\s*dot\s*[)\]]\s*/gi, '.')     // (dot) [dot]
        .replace(/\s+dot\s+/gi, '.')                    // " dot "
        // Lowercase-only on the right: a real TLD is always lowercase, while an
        // uppercase letter right after ". " is a sentence boundary, not a spaced-out
        // domain (e.g. "shop code: 5964. Click here…" must NOT become "5964.Click").
        .replace(/(\w)\s*\.\s*([a-z])/g, '$1.$2')      // "scamsite . com" → join
        .replace(/\.{2,}/g, '.')                        // "free-airtime..com" → single dot
}

function hostMatches(host: string, list: string[]): boolean {
    return list.some(d => host === d || host.endsWith('.' + d))
}

/**
 * Link inspection. Two modes:
 *  - allowlist (strict): hazards AND non-allowlisted hosts → blocking verdict.
 *  - hazardsOnly (telco-only): ANY real domain is permitted (business-mode link
 *    freedom); only hazard classes (homoglyph hosts, raw IPs, URL shorteners)
 *    return a verdict, and it is FLAG-ONLY (delivered, severity 'fraud').
 *    REVERTED (Stage-4 2026-07-08): generic URL shorteners are ALWAYS
 *    flagged in business mode, admin-allowlisted or not — a shortener hides
 *    its real destination, which is a fraud vector no admin vetting can
 *    close. IP-literal and homoglyph hazards were never exempt either way.
 */
function checkLinks(rawText: string, allowedDomains: string[], hazardsOnly = false): FilterResult | null {
    const text = defang(rawText)
    const verdict = (reason: string): FilterResult =>
        hazardsOnly
            ? { blocked: false, flagged: true, reason, severity: 'fraud' }
            : { blocked: true, flagged: true, reason, severity: 'fraud' }

    if (HOMOGLYPH_HOST_RE.test(text)) {
        return verdict('Suspicious link (non-standard characters)')
    }

    const ipMatch = text.match(IPV4_RE)
    if (ipMatch) {
        const octets = ipMatch[0].match(/\d{1,3}/g) || []
        if (octets.length >= 4 && octets.slice(-4).every(o => Number(o) <= 255)) {
            const ip = ipMatch[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '')
            return verdict(`External link not allowed: ${ip}`)
        }
    }

    const adminAllowed = allowedDomains.map(d => d.trim().toLowerCase()).filter(Boolean)
    const allowed = [...DEFAULT_ALLOWED_LINK_DOMAINS, ...adminAllowed]
    const hostRe = /(https?:\/\/)?(www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s]*)?/gi
    let m: RegExpExecArray | null
    while ((m = hostRe.exec(text)) !== null) {
        const explicit = Boolean(m[1] || m[2] || m[4]) // scheme / www / path
        const original = m[3]
        const host = original.toLowerCase()
        const labels = host.split('.')
        const tld = labels[labels.length - 1]
        const lastTwo = labels.slice(-2).join('.')

        // Run-on-sentence guard: bare "lowerword.Capitalword" is prose, not a link.
        if (!explicit) {
            const lastLabelOrig = original.split('.').pop() || ''
            const beforeDot = original.slice(0, original.length - lastLabelOrig.length - 1).slice(-1)
            if (/[a-z]/.test(beforeDot) && /[A-Z]/.test(lastLabelOrig[0] || '')) continue
        }

        const isLink = explicit || INFRA_TLDS.has(tld) || MULTI_TLDS.has(lastTwo)
        if (!isLink) continue

        if (hostMatches(host, URL_SHORTENERS)) {
            // REVERTED (Stage-4): generic URL shorteners are ALWAYS flagged,
            // in both strict (blocking) and hazardsOnly/business (flag-only)
            // modes — never exempt via the admin allowlist. Shorteners hide
            // their real destination, same fraud class as raw IPs/homoglyphs,
            // neither of which is ever exempt.
            return verdict('URL shortener not allowed in SMS')
        }
        if (hazardsOnly) continue // business mode: any real domain is allowed
        if (hostMatches(host, KINGFLEXY_DOMAINS)) continue
        if (hostMatches(host, allowed)) continue
        return verdict(`External link not allowed: ${host}`)
    }
    return null
}

// ════════════════════════════════════════════════════════════════════════════
// Fraud patterns (block) — matched against the normalized text
// ════════════════════════════════════════════════════════════════════════════

const PHISH_PATTERNS: { re: RegExp; reason: string; cred?: boolean }[] = [
    { re: /\b(otp|one[\s-]?time\s?(pass(word|code)?|pin))\b/i, reason: 'OTP/verification-code bait', cred: true },
    // Account verification / authentication phishing (carrier "network/operator" check excluded).
    { re: /\b(verify|confirm|update|validate|authenticate|re-?activate|reconfirm)\s+(your\s+)?(account|wallet|pin|password|sim|details|registration|profile|identity|info|kyc)\b(?!\s+(network|operator|provider|coverage))/i, reason: 'Account-verification phishing pattern', cred: true },
    // Credential / secret harvesting: harvest verb ... secret noun (incl. N-digit
    // codes, but NOT promo/order codes). Bare "code" is intentionally allowed.
    { re: /\b(enter|share|send|give|provide|reply\s+with|furnish|disclose|tell\s+(us|me)|type\s+in|key\s+in|forward|submit)\b[^.]{0,30}?\b(pin|otp|passcode|password|one[\s-]?time|secret\s+(code|pin)|security\s+code|access\s+code|verification\s+(code|number|pin)|activation\s+code|your\s+login|(?:\d|one|two|three|four|five|six)\s*[\s-]?digit\s+(?!promo|discount|order|voucher|coupon|reference|checkout)(?:\w+\s+)?(?:code|pin|number|secret|otp|password))\b/i, reason: 'Credential (PIN/OTP/secret) harvesting', cred: true },
    { re: /\b(momo|mobile\s*money|sim)\s*(pin|password|passcode|secret)\b/i, reason: 'MoMo credential harvesting', cred: true },
    // OTP relay ("reply with the code we sent you").
    { re: /\b(reply\s+with|send|share|forward)\b[^.]{0,20}?\b(code|otp|pin)\b[^.]{0,20}?\b(we\s+(just\s+)?(sent|texted)|you\s+(just\s+)?(got|received))\b/i, reason: 'One-time-code relay bait', cred: true },
    // Account-scare states — require a "will be / has been / is" linker.
    { re: /\b(your\s+)?(account|wallet|sim|number|line|profile)\b[^.]{0,20}?\b(will\s+be|has\s+been|is|are|about\s+to\s+be|gonna\s+be)\b[^.]{0,12}?\b(blocked|suspended|frozen|deactivated|de-?activated|locked|barred|restricted|disabled|terminated|deregistered)\b/i, reason: 'Account-scare phishing pattern' },
    // Account-scare in noun form ("SIM scheduled for deactivation").
    { re: /\b(account|wallet|sim|number|line|profile)\b[^.]{0,20}?\b(scheduled|due|set|marked|flagged|slated)\s+for\s+(deactivation|suspension|blocking|termination|deregistration|closure|disconnection|restriction)\b/i, reason: 'Account-scare phishing pattern' },
    // Prizes / "you have won" (prize noun close by, not a distant price). Lottery/
    // jackpot handled by the next rule (with a "(?!of)" figurative-idiom guard).
    { re: /\byou\s+(have\s+)?won\b.{0,20}\b(prize|reward|gift|raffle|draw)\b/i, reason: 'Lottery/prize scam pattern' },
    { re: /\b(won|win|bagged|scooped|grabbed|hit)\s+(the\s+)?(lottery|jackpot)\b(?!\s+of\s+(low|cheap|best|amazing|great|sweet|good|our|the\s+best))/i, reason: 'Lottery/jackpot scam pattern' },
    { re: /\b(grand\s+prize|jackpot|cash\s+prize|first|mega)\s+winner\b/i, reason: 'Prize-winner scam pattern' },
    // "lucky winner/customer" only with a claim/payout cue (ordinary "be a winner"
    // promo allowed). Cue may sit across a sentence boundary, hence [\s\S]{0,60}.
    { re: /\b(lucky|selected|chosen)\s+(winner|customer|subscriber|user)\b[\s\S]{0,60}\b(claim|prize|reward|fee|collect|congratulations?|receive|winning)\b|\b(claim|congratulations?|prize|reward|fee)\b[\s\S]{0,60}\b(lucky|selected|chosen)\s+(winner|customer|subscriber)\b/i, reason: 'Prize-winner scam pattern' },
    { re: /\bclaim\s+(your\s+)?(prize|winnings|lottery)\b/i, reason: 'Prize-claim scam pattern' },
    { re: /\bwinner\b.{0,30}\b(promo|draw|raffle|lottery)\b|\b(promo|draw|raffle)\b.{0,30}\bwinner\b/i, reason: 'Promo-draw winner scam pattern' },
    { re: /\b(you\s+have\s+been|been)\s+selected\b.{0,30}\b(cash|prize|money|jackpot|lottery|reward\s+of\s+(gh|\d))\b/i, reason: 'Selection scam pattern' },
    { re: /\b(emerged|came\s+out)\b.{0,20}\bwinner\b/i, reason: 'Prize-winner scam pattern' },
    { re: /\b(drawn|picked|chosen|selected)\b[\s\S]{0,60}\b(winner|grand\s+prize|prize|jackpot|lottery|raffle|cash\s+prize|mega\s+draw|claim\s+your|gh[sc₵]?\s*\d{3,})\b/i, reason: 'Prize-draw scam pattern' },
]

// MoMo reversal / wrong-transfer "send it back" social engineering. ("wrong
// number/line" excluded — that's a customer's mistyped phone, not a mis-transfer;
// merchant "we return the money" excluded — recipient-directed framing required.)
const REVERSAL_RE = /\b(reversal|reverse\s+the\s+(transaction|transfer|payment|money|funds)|wrong\s+(transfer|transaction|payment|account)|(mistakenly|accidentally|wrongly)\s+(sent|transferred|credited|paid)|(sent|transferred|credited|paid)\b[^.]{0,30}?\b(by\s+mistake|by\s+accident|in\s+error|wrongly|mistakenly)|(refund|return|send|push|pay)\s+(it|the\s+(money|cash|cedis|amount|funds))\b[^.]{0,15}?\bback\b(?!\s+to\s+(you|your|the\s+(buyer|customer|client|wallet|account)))|(refund|return|send|push)\s+(it|the\s+(money|cash|cedis|amount|funds))\b[^.]{0,12}?\bto\s+me\b|honest\s+mistake)\b/i

// Narrowed variant for the 'telco-only' policy: the social-engineering grammar
// only — the bare "reversal" token is dropped so a legitimate business notice
// ("Your reversal of GHS 10.00 has been processed") DELIVERS (it flags instead).
const REVERSAL_SOCIAL_RE = /\b(reverse\s+the\s+(transaction|transfer|payment|money|funds)|wrong\s+(transfer|transaction|payment|account)|(mistakenly|accidentally|wrongly)\s+(sent|transferred|credited|paid)|(sent|transferred|credited|paid)\b[^.]{0,30}?\b(by\s+mistake|by\s+accident|in\s+error|wrongly|mistakenly)|(refund|return|send|push|pay)\s+(it|the\s+(money|cash|cedis|amount|funds))\b[^.]{0,15}?\bback\b(?!\s+to\s+(you|your|the\s+(buyer|customer|client|wallet|account)))|(refund|return|send|push)\s+(it|the\s+(money|cash|cedis|amount|funds))\b[^.]{0,12}?\bto\s+me\b|honest\s+mistake)\b/i
const BARE_REVERSAL_RE = /\breversal\b/i

// ════════════════════════════════════════════════════════════════════════════
// Fake MoMo / bank transaction-confirmation ("receipt") detection
// ════════════════════════════════════════════════════════════════════════════

// Outbound / promo cues — a price quote or pay instruction is NOT a receipt.
// SECURITY FIX (2026-07-06): "for GHS" must not count as a promo cue when it is
// part of the real telco receipt grammar ("Cash In received for GHS 200.00…",
// "Payment received for GHS 3.00…") — that early-exit let verbatim MTN receipt
// templates through. Negative lookbehinds exclude "received for".
const OUTBOUND_RE = /\b(pay|buy|order|grab|sell|recharge|top\s?up|checkout|gets?\s+you|get\s+\d|(?<!received\s)(?<!recieved\s)for\s+(only\s+)?(gh|₵|\d)|from\s+(only\s+)?gh|discount|%\s*off|off\s+your|cashback)\b/i

// ════════════════════════════════════════════════════════════════════════════
// Telco transaction-message impersonation (blocks in EVERY policy)
// ════════════════════════════════════════════════════════════════════════════
// Anchored on the VERBATIM Ghanaian carrier receipt grammars captured by the
// MoMo claim webhook (app/api/webhooks/sms-forward/route.ts) — evaluated with
// NO promo/outbound early-exit, so "…Top up today!" suffixes cannot bypass it.
// "from you/your" is excluded so merchant acknowledgements to the payer pass.

const TELCO_TEMPLATE_RES: RegExp[] = [
    // MTN merchant: "Cash In received for GHS 200.00 from EDWARD APPIAH."
    /\bcash\s+in\s+(received|recieved)\s+for\s+(ghs?|ghc|₵)?\s*[\d,]+(\.\d{1,2})?\b/i,
    // MTN P2P/cross-net: "Payment received for GHS 3.00 from FELIX BOAHEN"
    /\bpayment\s+(received|recieved)\s+for\s+(ghs?|ghc|₵)\s*[\d,]+(\.\d{1,2})?\s+from\b(?!\s+(you|your|u)\b)/i,
    // Telecel: "GHS 20.00 has been received from KWAME"
    /\b(ghs?|ghc|₵)\s*[\d,]+(\.\d{1,2})?\s+has\s+been\s+(received|recieved)\s+from\b(?!\s+(you|your|u)\b)/i,
    // AirtelTigo: "received GHS 15.00 from AKOSUA"
    /\b(received|recieved)\s+(ghs?|ghc|₵)\s*[\d,]+(\.\d{1,2})?\s+from\b(?!\s+(you|your|u)\b)/i,
]
// Balance marker + Transaction ID together = screenshot-grade carrier receipt.
const TELCO_BALANCE_RE = /\b(current|available|new)\s+balance\b|\bavail(?:able)?\.?\s?bal\b/i
const TELCO_TXN_ID_RE = /\btransaction\s+id\b|\btxn\s+id\b/i

function looksLikeTelcoTemplate(text: string): boolean {
    // Join spaced digit groups ("200 . 00" → "200.00") like the receipt layer.
    const t = text.replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3')
    if (TELCO_TEMPLATE_RES.some(re => re.test(t))) return true
    return TELCO_BALANCE_RE.test(t) && TELCO_TXN_ID_RE.test(t)
}
// Inbound money-arrival grammar (recipient-directed; broad synonym families,
// incl. misspellings + Twi/Pidgin). "received" is never bare and "received from
// you/your" is excluded so a merchant ack ("we received your payment of GHS 8",
// "GHS 18 received from you") is NOT mistaken for a fake receipt.
const INBOUND_RE = /\b(?:you('?ve|\s+have|\s+just)?\s+(been\s+)?(received|recieved|recived)|(received|recieved)\b[^.]{0,15}\bfrom\b(?!\s+(you|your|u\b))|\d[\d,]*\s*(gh[sc₵]?|cedis|ghc)?\s*(has\s+been\s+)?(received|recieved)\b(?![^.]{0,15}\bfrom\s+(you|your|u\b))|payment\s+(received|recieved)|(you|u)('?ve|\s+have|\s+just)?\s+got\s+paid|got\s+paid|credited\s+(with|to\s+you)|cr\s+edited|(has\s+been|just|now)\s+credited|has\s+(been\s+)?(added|credited)\s+to\s+your|your\s+(account|wallet|number|momo|balance)\b[^.]{0,15}?(credited|topped\s*up|funded|loaded|increased|gone\s+up|grown)|(hit|reached|arrived\s+in|landed\s+in|landed|entered|reflects?\s+in|reflected\s+in|gone\s+into|come\s+into)\s+your\s+(account|wallet|number|momo|balance)|has\s+entered\s+your\s+wallet|(money|cash|payment|funds|credit)\s+(has\s+)?(just\s+)?(arrived|landed|hit|entered|reflected|come\s+in)|(transferred|credited|paid|moved|sent)\s+to\s+(you|your\s+(number|wallet|account|momo))|incoming\s+(payment|transfer|money|credit|cash)|(was\s+)?deposited\s+(into|to)\s+your\s+(wallet|account|number|momo)|deposit\s+of|payment\s+of\b[^.]{0,20}\bto\s+your?\b|money\s+don\s+enter|don\s+(enter|receive|land|show|cash)|sika\b[^.]{0,15}\b(aba|aduru)\b[^.]{0,20}\b(wo|for\s+your)|wo\s+aka\s+sika|abedu\s+wo|land(ed)?\s+for\s+your\s+(number|momo|wallet)|cash\s+received|transaction\s+successful|successfully\s+(received|sent))/i
// Balance / transaction-screenshot markers.
const BALANCE_RE = /\b((current|available|new|account|wallet)\s+balanc(e)?|avail(?:able)?\.?\s?bal|transaction\s+id|txn\s+id|reference\s+(no|number|id)|ref\s+no|has\s+been\s+debited|debited\s+with)\b/i
// Telco / bank brand tokens.
const BRAND_RE = /\b(mtn\s+(mobile\s*money|momo)|telecel\s+cash|airteltigo\s+money|at\s+money|vodafone\s+cash|gcb|ecobank|fidelity\s+bank|absa|stanbic|calbank|gt\s?bank|zenith\s+bank|access\s+bank|uba)\b/i

function looksLikeFakeReceipt(text: string): boolean {
    if (OUTBOUND_RE.test(text)) return false   // a pay/promo, not a receipt
    // Normalise spaced digit groups, strip USSD codes (so *124# isn't an "amount").
    const amt = text
        .replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3')
        .replace(/\*\d{2,5}#?/g, ' ')
        .replace(/\b\d{2,5}#/g, ' ')
    const hasCurrency = /(?:gh[s₵c]|₵)\s*\d|\b\d[\d,]*\s*(cedis|ghc|gh)\b|\b\d{2,}gh\b/i.test(amt)
    const hasDecimal = /\b\d{1,3}(,\d{3})*\.\d{2}\b/.test(amt)
    const hasBareInt = /\b\d{2,7}\b(?!\s*(gb|mb|kb|min|mins|sms|day|days|hr|hrs|hour|hours|%|pcs|pieces|points|pts))/i.test(amt)
    const hasAmount = hasCurrency || hasDecimal || hasBareInt
    const hasBrand = BRAND_RE.test(text)
    if (!hasAmount && !hasBrand) return false

    const hasReceiptCue = INBOUND_RE.test(text) || BALANCE_RE.test(text)
    if (hasReceiptCue && hasAmount) return true
    // Brand + real money is a receipt only with a receipt cue — otherwise it's a
    // legit price quote ("Telecel Cash GHS 500") or merchant ack.
    if (hasBrand && (hasCurrency || hasDecimal) && hasReceiptCue) return true
    return false
}

// ════════════════════════════════════════════════════════════════════════════
// Flag-only patterns (delivered, surfaced to admin)
// ════════════════════════════════════════════════════════════════════════════

const FLAG_PATTERNS: { re: RegExp; reason: string }[] = [
    { re: /\b(urgent|act\s+now|immediately|last\s+chance|hurry|limited\s+time)\b/i, reason: 'High-pressure language' },
    { re: /\b(send|transfer)\s+(money|cash|ghs|funds)\b/i, reason: 'Money-transfer request' },
]

/** Suggested scam keywords/phrases for the admin CONTAINS blocklist. */
export const SUGGESTED_SCAM_KEYWORDS = [
    'you have won', 'lottery', 'jackpot', 'lucky winner', 'free airtime', 'free data',
    'send your pin', 'share your pin', 'enter your pin', 'verify your account',
    'confirm your account', 'momo reversal', 'reverse the transaction', 'wrong transfer',
    'send it back', 'you have received', 'payment received', 'current balance',
    'available balance', 'click here', 'claim your reward', 'account blocked',
    'update your details', 'congratulations you won', 'secret code', 'activation code',
]

/**
 * Classify an SMS message under a policy profile.
 *
 * strict (default — shop SMS + platform-mode user SMS), first block wins:
 *   telco impersonation → links (allowlist) → fake receipt → phishing →
 *   reversal → admin keywords → flag-only.
 *
 * telco-only (business-mode user SMS): BLOCKS are telco impersonation,
 * reversal social engineering, and admin keywords. Link hazards
 * (shortener/IP/homoglyph — any real domain is fine), phishing/prize hits and
 * the bare "reversal" token are demoted to FLAG-ONLY with severity 'fraud'.
 */
export function filterSmsContent(message: string, options: FilterOptions = {}): FilterResult {
    const raw = (message || '').trim()
    if (!raw) return { blocked: false, flagged: false, reason: null }

    const policy: FilterPolicy = options.policy || 'strict'
    const base = raw.normalize('NFKC').replace(ZERO_WIDTH_RE, '')
    const lower = base.toLowerCase()
    const norm = normalizeForWords(raw)   // obfuscation-resistant copy for fraud patterns
    const hasDotCue = base.includes('.') || /\bdot\b/i.test(base) || /%2e/i.test(base)

    // 0. Telco transaction-message impersonation — unconditional, EVERY policy.
    //    (Runs before everything: no promo-suffix or link trickery can skip it.)
    if (looksLikeTelcoTemplate(lower) || looksLikeTelcoTemplate(norm)) {
        return { blocked: true, flagged: true, reason: 'Telco transaction-message impersonation', severity: 'fraud' }
    }

    const safetyNotice = /\b(never|will\s+not|won'?t|do\s+not|don'?t|we\s+(never|don'?t|do\s+not|will\s+not))\b[^.]{0,30}\b(ask|request|require|need|verify|confirm|share|tell|send|collect)\b[^.]{0,25}\b(pin|otp|password|passcode|code|account|details|number|card)\b/i.test(norm)

    if (policy === 'strict') {
        // 1. Links — allowlist + shorteners + raw IPs + homoglyph hosts.
        if (hasDotCue) {
            const linkVerdict = checkLinks(base, options.allowedDomains || [])
            if (linkVerdict) return linkVerdict
        }

        // 2. Fake MoMo / bank transaction-confirmation receipts.
        if (looksLikeFakeReceipt(lower) || looksLikeFakeReceipt(norm)) {
            return { blocked: true, flagged: true, reason: 'Fake payment/bank confirmation message', severity: 'fraud' }
        }

        // 3. Credential / OTP / account / prize phishing. Skip the credential-asking
        //    rules inside a protective safety notice ("we never ask for your PIN/OTP")
        //    — that's exactly the security advice shops should be able to broadcast.
        for (const { re, reason, cred } of PHISH_PATTERNS) {
            if (cred && safetyNotice) continue
            if (re.test(norm) || re.test(lower)) return { blocked: true, flagged: true, reason, severity: 'fraud' }
        }

        // 4. MoMo reversal / wrong-transfer social engineering.
        if (REVERSAL_RE.test(norm) || REVERSAL_RE.test(lower)) {
            return { blocked: true, flagged: true, reason: 'MoMo reversal / wrong-transfer scam pattern', severity: 'fraud' }
        }
    } else {
        // telco-only: remaining hard blocks are reversal social engineering
        // (the bare "reversal" token flags below instead) …
        if (REVERSAL_SOCIAL_RE.test(norm) || REVERSAL_SOCIAL_RE.test(lower)) {
            return { blocked: true, flagged: true, reason: 'MoMo reversal / wrong-transfer scam pattern', severity: 'fraud' }
        }
    }

    // 5. Admin CONTAINS blocklist (substring, partial matches count) — both policies.
    for (const keyword of (options.blockedKeywords || [])) {
        const kw = keyword.trim().toLowerCase()
        if (kw.length >= 2 && (lower.includes(kw) || norm.includes(kw))) {
            return { blocked: true, flagged: true, reason: `Admin-blocked keyword: "${kw}"`, severity: 'fraud' }
        }
    }

    // 5.5. Admin FLAG-ONLY list (e.g. business-mode flagged keywords) — demote-only,
    // never block, both policies. Checked after the block list above so an
    // explicit block always wins if the same term sits on both lists.
    for (const keyword of (options.flaggedKeywords || [])) {
        const kw = keyword.trim().toLowerCase()
        if (kw.length >= 2 && (lower.includes(kw) || norm.includes(kw))) {
            return { blocked: false, flagged: true, reason: `Flagged keyword: "${kw}"`, severity: 'info' }
        }
    }

    // 6. telco-only demotions — delivered, surfaced to admin as fraud-grade flags.
    if (policy === 'telco-only') {
        if (hasDotCue) {
            // Business allowedDomains is still threaded through, but (Stage-4
            // reversal) no longer changes hazardsOnly's verdict: ordinary
            // domains are already permitted regardless, and shorteners are
            // now always flagged rather than admin-exemptible.
            const hazard = checkLinks(base, options.allowedDomains || [], true)
            if (hazard) return hazard
        }
        for (const { re, reason, cred } of PHISH_PATTERNS) {
            if (cred && safetyNotice) continue
            if (re.test(norm) || re.test(lower)) {
                return { blocked: false, flagged: true, reason, severity: 'fraud' }
            }
        }
        if (BARE_REVERSAL_RE.test(norm) || BARE_REVERSAL_RE.test(lower)) {
            return { blocked: false, flagged: true, reason: 'Mentions transaction reversal', severity: 'fraud' }
        }
    }

    // 7. Flag-only — delivered, surfaced to admin (marketing-tone signals).
    for (const { re, reason } of FLAG_PATTERNS) {
        if (re.test(norm) || re.test(lower)) return { blocked: false, flagged: true, reason, severity: 'info' }
    }

    return { blocked: false, flagged: false, reason: null }
}
