// POST /api/v2/data/bulk — the developer API's endpoint. Body lives in lib/api-handlers/data-bulk.ts.
import { handleDataBulk } from '@/lib/api-handlers/data-bulk'

export const POST = handleDataBulk
