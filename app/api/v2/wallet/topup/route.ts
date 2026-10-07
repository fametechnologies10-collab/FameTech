// POST /api/v2/wallet/topup — tombstone (410), carried from v1 so a migrating
// caller gets the informative "use the dashboard" message rather than a bare
// 404. Body shared via lib/api-handlers/wallet-topup.ts.
import { handleWalletTopup } from '@/lib/api-handlers/wallet-topup'

export const POST = handleWalletTopup
