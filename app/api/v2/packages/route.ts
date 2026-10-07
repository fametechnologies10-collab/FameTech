// GET /api/v2/packages — the developer API's endpoint. Body lives in lib/api-handlers/packages.ts.
import { handlePackages } from '@/lib/api-handlers/packages'

export const GET = handlePackages
