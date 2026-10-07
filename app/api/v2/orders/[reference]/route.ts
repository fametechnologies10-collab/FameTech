// GET /api/v2/orders/:reference — the developer API's endpoint. Body lives in lib/api-handlers/order-status.ts.
import { handleOrderStatus } from '@/lib/api-handlers/order-status'

export const GET = handleOrderStatus
