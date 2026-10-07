/**
 * /dashboard/sms/records/[id] — server wrapper for the campaign delivery
 * drill-down. Resolves the Next 15 async params and hands the id to the
 * client component, which owns all fetching/state.
 */

import RecordsDetailClient from './RecordsDetailClient'

export const dynamic = 'force-dynamic'

export default async function CampaignRecordPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    return <RecordsDetailClient campaignId={id} />
}
