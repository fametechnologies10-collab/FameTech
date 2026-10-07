// POST /api/v2/data/purchase — the developer API's endpoint. Body lives in lib/api-handlers/data-purchase.ts.
import { handleDataPurchase } from '@/lib/api-handlers/data-purchase'

export const POST = handleDataPurchase
