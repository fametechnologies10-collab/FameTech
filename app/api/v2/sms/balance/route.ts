// GET /api/v2/sms/balance — the developer API's endpoint. Body lives in lib/api-handlers/sms-balance.ts.
import { handleSmsBalance } from '@/lib/api-handlers/sms-balance'

export const dynamic = 'force-dynamic'
export const GET = handleSmsBalance
