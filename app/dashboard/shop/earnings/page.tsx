'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Download, Loader2, TrendingUp, ArrowDownRight, RotateCcw, Wallet, ArrowRightLeft } from 'lucide-react'

// Full shop earnings ledger: profit credits, withdrawals, AND refund reversals (profit_reversal).
// Fills the gap where only withdrawals were visible — owners can now see every wallet movement,
// including money clawed back when one of their sales is refunded via Paystack.

const TYPE_META: Record<string, { label: string; sign: '+' | '-'; cls: string; Icon: typeof Wallet }> = {
    profit:                { label: 'Earning',   sign: '+', cls: 'text-emerald-600', Icon: TrendingUp },
    withdrawal:            { label: 'Withdrawal', sign: '-', cls: 'text-blue-600',    Icon: ArrowDownRight },
    profit_reversal:       { label: 'Refund reversal', sign: '-', cls: 'text-purple-600', Icon: RotateCcw },
    commission_transfer_in: { label: 'Transfer from Commission', sign: '+', cls: 'text-violet-600', Icon: ArrowRightLeft },
}

export default function ShopEarningsPage() {
    const { dbUser } = useAuth()
    const [wallet, setWallet] = useState<any>(null)
    const [rows, setRows] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [typeFilter, setTypeFilter] = useState<'all' | 'profit' | 'withdrawal' | 'profit_reversal' | 'commission_transfer_in'>('all')

    const fetchData = useCallback(async () => {
        if (!dbUser) return
        setLoading(true)
        try {
            const { data: w } = await (supabase.from('shop_wallets') as any)
                .select('*').eq('owner_id', dbUser.id).maybeSingle()
            setWallet(w)
            if (!w) { setRows([]); return }
            let q = (supabase.from('shop_wallet_transactions') as any)
                .select('*').eq('shop_wallet_id', w.id).order('created_at', { ascending: false }).limit(200)
            if (typeFilter !== 'all') q = q.eq('type', typeFilter)
            const { data } = await q
            setRows(data || [])
        } catch (e) {
            console.error('Error loading shop earnings:', e)
        } finally {
            setLoading(false)
        }
    }, [dbUser, typeFilter])

    useEffect(() => { fetchData() }, [fetchData])

    const exportCsv = () => {
        const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
        const header = ['Date', 'Type', 'Amount', 'Status', 'Order']
        // shop_order_id is NULL on AFA profit rows (they key off afa_order_id instead) —
        // fall back so the Order column isn't blank for AFA earnings.
        const lines = rows.map(r => [formatDate(r.created_at), r.type, r.amount, r.status, r.shop_order_id ?? r.afa_order_id ?? ''].map(esc).join(','))
        const csv = [header.map(esc).join(','), ...lines].join('\n')
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = `shop-earnings-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
        URL.revokeObjectURL(url)
    }

    return (
        <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold">Earnings Ledger</h1>
                    <p className="text-muted-foreground text-sm">Every movement in your shop wallet — earnings, withdrawals and refund reversals.</p>
                </div>
                <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
                    <Download className="w-4 h-4 mr-1.5" /> Export
                </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Card><CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Balance</p>
                    <p className="text-xl font-bold">{formatCurrency(wallet?.balance ?? 0)}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Total earned</p>
                    <p className="text-xl font-bold text-emerald-600">{formatCurrency(wallet?.total_earned ?? 0)}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Total withdrawn</p>
                    <p className="text-xl font-bold text-blue-600">{formatCurrency(wallet?.total_withdrawn ?? 0)}</p>
                </CardContent></Card>
            </div>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-base">History</CardTitle>
                    <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
                        <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All movements</SelectItem>
                            <SelectItem value="profit">Earnings</SelectItem>
                            <SelectItem value="withdrawal">Withdrawals</SelectItem>
                            <SelectItem value="profit_reversal">Refund reversals</SelectItem>
                            <SelectItem value="commission_transfer_in">Transfers from Commission</SelectItem>
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent className="space-y-2">
                    {loading ? (
                        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
                    ) : rows.length === 0 ? (
                        <p className="text-center py-10 text-sm text-muted-foreground">No movements yet.</p>
                    ) : rows.map((r) => {
                        const meta = TYPE_META[r.type] || { label: r.type, sign: '+' as const, cls: 'text-foreground', Icon: Wallet }
                        const Icon = meta.Icon
                        return (
                            <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                                        <Icon className="w-4 h-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium truncate">{meta.label}</p>
                                        <p className="text-xs text-muted-foreground">{formatDate(r.created_at)}</p>
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className={`text-sm font-semibold ${meta.cls}`}>{meta.sign}{formatCurrency(r.amount)}</p>
                                    <Badge variant="outline" className="text-[10px] capitalize">{r.status}</Badge>
                                </div>
                            </div>
                        )
                    })}
                </CardContent>
            </Card>
        </div>
    )
}
