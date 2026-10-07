import { z } from 'zod'
import { phoneSchema, adminLongTextSchema } from './validation'
import { WEBSITE_REQUEST_CATEGORY_KEYS } from './website-request-categories'

// -----------------------------------------------------------------------------
// Why these fields don't use lib/validation.ts's shortTextSchema/longTextSchema:
// those block `&` outright (htmlBlockRegex = /[<>&]/), which would reject
// perfectly ordinary project copy — "sales & marketing site", "Jumia & Jiji",
// "school & church website". We still block the actual injection vectors:
// `<`, `>`, backtick, the `javascript:` scheme, and raw control characters.
// -----------------------------------------------------------------------------
const forbiddenCharsRegex = /[<>`]/
const jsSchemeRegex = /javascript:/i
// Multi-line fields allow \t \n \r but block every other control character.
const CONTROL_CHARS_MULTILINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const CONTROL_CHARS_SINGLE_LINE = /[\x00-\x1f\x7f]/

function safeProseSchema(min: number, max: number, label: string) {
    return z.string()
        .trim()
        .min(min, `${label} must be at least ${min} characters`)
        .max(max, `${label} must be ${max} characters or less`)
        .refine(val => !forbiddenCharsRegex.test(val), 'Please remove the characters < > and ` and try again')
        .refine(val => !jsSchemeRegex.test(val), 'Contains a disallowed URL scheme')
        .refine(val => !CONTROL_CHARS_MULTILINE.test(val), 'Contains invisible or control characters')
}

/** Optional single-line free text (reference sites). Empty string is allowed. */
const referenceSitesSchema = z.union([
    z.literal(''),
    z.string()
        .trim()
        .max(300, 'Reference must be 300 characters or less')
        .refine(val => !forbiddenCharsRegex.test(val), 'Please remove the characters < > and ` and try again')
        .refine(val => !jsSchemeRegex.test(val), 'Contains a disallowed URL scheme')
        .refine(val => !CONTROL_CHARS_SINGLE_LINE.test(val), 'Contains invisible or control characters'),
]).optional()

// contact_whatsapp reuses phoneSchema (not the dedicated `whatsappSchema` in
// lib/validation.ts) because it must accept the SAME format as contact_phone
// when the user leaves it blank and the form falls back to contact_phone —
// whatsappSchema expects a different, non-'0'/'+233'-prefixed format.
const optionalWhatsapp = z.union([phoneSchema, z.literal('')])

// Feature keys are machine-generated slugs, never user prose — a strict
// character class is correct here and is re-checked against the category's
// allow-list in the route via isValidFeatureSet().
const featureKeySchema = z.string().max(60).regex(/^[a-z0-9_]+$/, 'Invalid feature key')

const fullRequestSchema = z.object({
    request_type: z.literal('full_request'),
    category: z.enum(WEBSITE_REQUEST_CATEGORY_KEYS),
    budget_ghs: z.number()
        .min(1000, 'Budget must be at least GHS 1,000')
        .max(10_000_000, 'Budget must be GHS 10,000,000 or less'),
    features: z.array(featureKeySchema).max(20, 'Too many features selected'),
    timeline: z.enum(['asap', '1_month', '2_3_months', 'flexible']),
    description: safeProseSchema(10, 2000, 'Project description'),
    reference_sites: referenceSitesSchema,
    contact_phone: phoneSchema,
    contact_whatsapp: optionalWhatsapp,
    confirm_serious: z.literal(true, {
        errorMap: () => ({ message: 'Please confirm this is a genuine project request' }),
    }),
})

const callRequestSchema = z.object({
    request_type: z.literal('call_request'),
    description: safeProseSchema(5, 2000, 'Note'),
    contact_phone: phoneSchema,
    contact_whatsapp: optionalWhatsapp,
})

export const websiteRequestSchema = z.discriminatedUnion('request_type', [fullRequestSchema, callRequestSchema])
export type WebsiteRequestInput = z.infer<typeof websiteRequestSchema>

export const adminUpdateSchema = z.object({
    status: z.enum(['new', 'contacted', 'closed']).optional(),
    closed_outcome: z.enum(['won', 'lost', 'spam']).optional(),
    admin_notes: adminLongTextSchema.optional(),
}).refine(
    data => data.status !== undefined || data.closed_outcome !== undefined || data.admin_notes !== undefined,
    'At least one field must be provided'
)
