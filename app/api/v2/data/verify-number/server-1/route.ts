// app/api/v2/data/verify-number/server-1/route.ts — Server 1 only check. Body lives in lib/api-handlers/verify-number.ts.
import { handleVerifyNumberServer1 } from '@/lib/api-handlers/verify-number'

export const POST = handleVerifyNumberServer1
