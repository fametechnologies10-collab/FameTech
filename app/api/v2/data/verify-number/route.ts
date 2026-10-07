// app/api/v2/data/verify-number/route.ts — the developer API's endpoint. Body lives in lib/api-handlers/verify-number.ts.
import { handleVerifyNumber } from '@/lib/api-handlers/verify-number'

export const POST = handleVerifyNumber
