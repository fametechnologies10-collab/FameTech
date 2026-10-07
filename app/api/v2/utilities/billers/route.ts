// GET /api/v2/utilities/billers — the developer API's endpoint. Body lives in lib/api-handlers/utilities-billers.ts.
import { handleUtilitiesBillers } from '@/lib/api-handlers/utilities-billers'

export const dynamic = 'force-dynamic'
export const GET = handleUtilitiesBillers
