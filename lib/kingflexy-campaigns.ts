/**
 * KingFlexyGH SMS campaign lookups.
 *
 * KingFlexyGH accepts `POST /sms/send` and forwards to its upstream carrier
 * gateway afterwards; a gateway rejection (e.g. "Hubtel batch rejected, status
 * 12") only shows up later as the campaign's `status: "failed"`. This lists
 * those failed campaigns so FameTech can stop reporting them as delivered.
 *
 * Uses the campaign LIST endpoint (30 per page) — the per-message status
 * endpoint is limited to 5 calls/min and is not used here.
 */

const KINGFLEXY_BASE_URL = 'https://api.kingflexygh.com/api/v2'
const PAGE_SIZE = 30
const MAX_PAGES = 20

export async function listKingFlexyFailedCampaignIds(opts: {
    from: Date
    to: Date
    fetchFn?: typeof fetch
}): Promise<Set<string>> {
    const apiKey = process.env.KINGFLEXY_API_KEY
    if (!apiKey) throw new Error('KINGFLEXY_API_KEY not configured.')

    const doFetch = opts.fetchFn ?? fetch
    const ids = new Set<string>()

    for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
            status: 'failed',
            from: opts.from.toISOString(),
            to: opts.to.toISOString(),
            page: String(page),
        })
        const response = await doFetch(`${KINGFLEXY_BASE_URL}/sms/campaigns?${params}`, {
            headers: { Authorization: apiKey },
        })

        let data: any
        try {
            data = await response.json()
        } catch {
            throw new Error(`KingFlexyGH campaign list returned a non-JSON response (HTTP ${response.status})`)
        }
        if (response.status !== 200 || data?.success !== true) {
            throw new Error(data?.error?.message || `KingFlexyGH campaign list error ${response.status}`)
        }

        const campaigns: Array<{ id?: string }> = data.data?.campaigns ?? []
        for (const c of campaigns) if (c.id) ids.add(c.id)
        if (campaigns.length < PAGE_SIZE) return ids
    }

    throw new Error(`KingFlexyGH campaign list exceeded ${MAX_PAGES} pages — window too large to verify`)
}
