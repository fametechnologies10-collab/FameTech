// app/api/v2/data/verify-number/server-2/route.ts — Server 2 only check. Body lives in lib/api-handlers/verify-number.ts.
import { handleVerifyNumberServer2 } from '@/lib/api-handlers/verify-number'

export const POST = handleVerifyNumberServer2
