// POST /api/v2/utilities/pay — the developer API's endpoint. Body lives in lib/api-handlers/utilities-pay.ts.
import { handleUtilitiesPay } from '@/lib/api-handlers/utilities-pay'

export const dynamic = 'force-dynamic'
export const POST = handleUtilitiesPay
