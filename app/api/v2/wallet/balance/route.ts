// GET /api/v2/wallet/balance — the developer API's endpoint. Body lives in lib/api-handlers/wallet-balance.ts.
import { handleWalletBalance } from '@/lib/api-handlers/wallet-balance'

export const GET = handleWalletBalance
