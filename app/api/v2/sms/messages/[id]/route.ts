// GET /api/v2/sms/messages/{id} — the developer API's endpoint. Body lives in lib/api-handlers/sms-message-status.ts.
import { handleSmsMessageStatus } from '@/lib/api-handlers/sms-message-status'

export const dynamic = 'force-dynamic'
export const GET = handleSmsMessageStatus
