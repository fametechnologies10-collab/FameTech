// GET /api/v2/utilities/orders/:reference — the developer API's endpoint. Body lives in lib/api-handlers/utilities-order-status.ts.
import { handleUtilitiesOrderStatus } from '@/lib/api-handlers/utilities-order-status'

export const dynamic = 'force-dynamic'
export const GET = handleUtilitiesOrderStatus
