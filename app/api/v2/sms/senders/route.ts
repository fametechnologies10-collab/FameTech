// GET /api/v2/sms/senders — the developer API's endpoint. Body lives in lib/api-handlers/sms-senders.ts.
import { handleSmsSenders } from '@/lib/api-handlers/sms-senders'

export const dynamic = 'force-dynamic'
export const GET = handleSmsSenders
