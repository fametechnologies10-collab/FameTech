/**
 * GSM SMS segment calculation — single source of truth for SMS credit billing.
 *
 * GSM-7 messages: 160 chars = 1 segment; longer messages split into
 * 153-char segments (7 chars consumed by concatenation headers).
 * Unicode messages (emoji, non-GSM chars): 70 chars first / 67 per segment.
 *
 * Credits charged = segments × recipients.
 */

// GSM 03.38 basic character set + extension table characters
const GSM7_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM7_EXTENDED = '^{}\\[~]|€'

const GSM7_SET = new Set([...GSM7_BASIC])
const GSM7_EXT_SET = new Set([...GSM7_EXTENDED])

export interface SegmentInfo {
    encoding: 'gsm7' | 'unicode'
    /** Effective length (GSM-7 extended chars count double) */
    length: number
    segments: number
    /** Characters remaining in the current segment */
    remaining: number
    /** Max chars for a single-segment message in this encoding */
    singleLimit: number
}

export function calculateSegments(message: string): SegmentInfo {
    let isGsm7 = true
    let gsmLength = 0

    for (const ch of message) {
        if (GSM7_SET.has(ch)) {
            gsmLength += 1
        } else if (GSM7_EXT_SET.has(ch)) {
            gsmLength += 2 // extension chars need an escape prefix
        } else {
            isGsm7 = false
            break
        }
    }

    if (isGsm7) {
        const segments = gsmLength === 0 ? 1 : gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153)
        const capacity = segments === 1 ? 160 : segments * 153
        return { encoding: 'gsm7', length: gsmLength, segments, remaining: capacity - gsmLength, singleLimit: 160 }
    }

    const codePoints = [...message].length
    const segments = codePoints === 0 ? 1 : codePoints <= 70 ? 1 : Math.ceil(codePoints / 67)
    const capacity = segments === 1 ? 70 : segments * 67
    return { encoding: 'unicode', length: codePoints, segments, remaining: capacity - codePoints, singleLimit: 70 }
}

/** Credits charged for sending `message` to `recipients` numbers. */
export function calculateCredits(message: string, recipients: number): number {
    return calculateSegments(message).segments * Math.max(0, recipients)
}
