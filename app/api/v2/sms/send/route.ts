// POST /api/v2/sms/send — the developer API's endpoint. Body lives in lib/api-handlers/sms-send.ts.
import { handleSmsSend } from '@/lib/api-handlers/sms-send'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const POST = handleSmsSend
