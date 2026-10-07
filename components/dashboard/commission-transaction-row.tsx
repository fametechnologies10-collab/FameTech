// components/dashboard/commission-transaction-row.tsx
// Shared row rendering for commission wallet transactions — used by both the main
// dashboard page's inline (last-10) history and the full-history view, so the two
// never drift apart.
import { formatCurrency, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
    Wallet, ArrowRightLeft, Banknote, TrendingUp, RotateCcw, UserCheck,
} from 'lucide-react'

export const TYPE_META: Record<string, { label: string; sign: '+' | '-'; cls: string; Icon: typeof Wallet }> = {
    commission:          { label: 'Commission Earned',   sign: '+', cls: 'text-emerald-600', Icon: TrendingUp },
    sub_agent_margin:    { label: 'Sub-Agent Earning',   sign: '+', cls: 'text-emerald-600', Icon: UserCheck },
    transfer_out_main:   { label: 'Transfer to Wallet',  sign: '-', cls: 'text-blue-600',    Icon: ArrowRightLeft },
    transfer_out_shop:   { label: 'Transfer to Shop',    sign: '-', cls: 'text-blue-600',    Icon: ArrowRightLeft },
    withdrawal:          { label: 'Withdrawal',          sign: '-', cls: 'text-violet-600',  Icon: Banknote },
    withdrawal_reversal: { label: 'Withdrawal Reversed', sign: '+', cls: 'text-amber-600',   Icon: RotateCcw },
}

export const STATUS_META: Record<string, string> = {
    pending: 'Pending',
    processing: 'Processing',
    paystack_pending: 'Processing',
    completed: 'Completed',
    success: 'Completed',
    failed: 'Failed',
    reversed: 'Reversed',
}

export interface CommissionTransaction {
    id: string
    type: string
    amount: number
    status: string
    created_at: string
    item_detail?: string | null
    subAgentName?: string
    [key: string]: unknown
}

export function TransactionRow({ r }: { r: CommissionTransaction }) {
    const meta = TYPE_META[r.type] || { label: r.type, sign: '+' as const, cls: 'text-foreground', Icon: Wallet }
    const Icon = meta.Icon
    // Sub-agent margin rows show the sub-agent's real name when it's been resolved
    // (app/api/commission/transactions/route.ts), falling back to the generic label
    // otherwise — defensive only, sub-agents can't be deleted so resolution should
    // always succeed.
    const isSubAgentRow = r.type === 'sub_agent_margin' || r.type === 'sub_agent_margin_reversal'
    const label = isSubAgentRow && r.subAgentName ? `${r.subAgentName}'s Order` : meta.label
    return (
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0"><Icon className="w-4 h-4" /></div>
                <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{label}</p>
                    {r.item_detail && (
                        <p className="text-xs text-muted-foreground truncate">{r.item_detail}</p>
                    )}
                    <p className="text-xs text-muted-foreground">{formatDate(r.created_at)}</p>
                </div>
            </div>
            <div className="text-right shrink-0">
                <p className={`text-sm font-semibold ${meta.cls}`}>{meta.sign}{formatCurrency(r.amount)}</p>
                <Badge variant="outline" className="text-[10px] capitalize">{STATUS_META[r.status] || r.status}</Badge>
            </div>
        </div>
    )
}
