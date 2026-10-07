import { z } from 'zod'
import { shortTextSchema, longTextSchema, phoneSchema } from './validation'

export const SUPPORT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Shared by POST /api/support/threads and scripts/test-support-threads.ts —
// the tests exercise the exact schema the route enforces.
export const createThreadSchema = z.object({
    subject: shortTextSchema.refine(v => v.trim().length >= 3, 'Subject is too short'),
    category: z.enum(['order', 'payment', 'account', 'other']).default('other'),
    message: longTextSchema.refine(v => v.trim().length >= 5, 'Message is too short'),
    phone_number: phoneSchema,
    whatsapp_number: phoneSchema,
    order_id: z.string().regex(SUPPORT_UUID_RE, 'Invalid order reference').optional(),
})
