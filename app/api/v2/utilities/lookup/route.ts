// GET /api/v2/utilities/lookup — the developer API's endpoint. Body lives in lib/api-handlers/utilities-lookup.ts.
import { handleUtilitiesLookup } from '@/lib/api-handlers/utilities-lookup'

export const dynamic = 'force-dynamic'
export const GET = handleUtilitiesLookup
