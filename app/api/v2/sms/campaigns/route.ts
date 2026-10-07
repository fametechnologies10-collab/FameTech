// GET /api/v2/sms/campaigns — the developer API's endpoint. Body lives in lib/api-handlers/sms-campaigns.ts.
import { handleSmsCampaigns } from '@/lib/api-handlers/sms-campaigns'

export const dynamic = 'force-dynamic'
export const GET = handleSmsCampaigns
