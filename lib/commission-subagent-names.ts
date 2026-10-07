// lib/commission-subagent-names.ts
// =============================================================================
// Resolves a sub-agent's display name for sub_agent_margin / sub_agent_margin_reversal
// commission transactions, so the recruiter's commission history can show
// "Ama Owusu's Order" instead of a generic "Sub-Agent Earning" label.
//
// Only ever selects first_name/last_name from `users` — never email, phone,
// or wallet data. One round trip to sub_agent_order_earnings (to map the
// order reference back to the sub-agent's user id) and one to users (to
// resolve that id to a name); no side effects beyond those two reads.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

interface EnrichableTransaction {
    type: string
    order_table: string | null
    order_reference: string | null
    [key: string]: unknown
}

export async function attachSubAgentNames<T extends EnrichableTransaction>(
    db: SupabaseClient,
    transactions: T[],
): Promise<(T & { subAgentName?: string })[]> {
    const marginRows = transactions.filter((t) => t.type === 'sub_agent_margin' || t.type === 'sub_agent_margin_reversal')
    if (marginRows.length === 0) return transactions

    const refs = marginRows.map((t) => t.order_reference).filter(Boolean) as string[]
    if (refs.length === 0) return transactions

    const { data: earnings } = await (db.from('sub_agent_order_earnings') as any)
        .select('order_table, order_reference, sub_user_id')
        .in('order_reference', refs)

    const subUserIdByRef = new Map((earnings || []).map((e: any) => [`${e.order_table}:${e.order_reference}`, e.sub_user_id]))
    const subUserIds = [...new Set([...subUserIdByRef.values()])] as string[]
    if (subUserIds.length === 0) return transactions

    const { data: users } = await (db.from('users') as any)
        .select('id, first_name, last_name')
        .in('id', subUserIds)

    const nameById = new Map((users || []).map((u: any) => [u.id, `${u.first_name || ''} ${u.last_name || ''}`.trim()]))

    return transactions.map((t) => {
        const subUserId = subUserIdByRef.get(`${t.order_table}:${t.order_reference}`)
        const name = subUserId ? nameById.get(subUserId) : undefined
        return name ? { ...t, subAgentName: name } : t
    })
}
