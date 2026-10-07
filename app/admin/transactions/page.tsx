'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, Download, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

const PAGE_SIZE = 50
// Canonical wallet_transactions enums (see wallet_transactions_source_check / _type_check).
const SOURCES = ['all', 'payment', 'purchase', 'airtime', 'refund', 'ussd', 'admin'] as const
const TYPES = ['all', 'credit', 'debit'] as const

export default function AdminTransactionsPage() {
    const [transactions, setTransactions] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')
    const [typeFilter, setTypeFilter] = useState<(typeof TYPES)[number]>('all')
    const [sourceFilter, setSourceFilter] = useState<(typeof SOURCES)[number]>('all')

    const fetchTransactions = useCallback(async (reset: boolean) => {
        reset ? setLoading(true) : setLoadingMore(true)
        try {
            const offset = reset ? 0 : transactions.length
            let query = (supabase.from('wallet_transactions') as any)
                .select(`*, users ( first_name, last_name, email, phone_number )`)
                .order('created_at', { ascending: false })
                .range(offset, offset + PAGE_SIZE - 1)
            if (typeFilter !== 'all') query = query.eq('type', typeFilter)
            if (sourceFilter !== 'all') query = query.eq('source', sourceFilter)

            const { data, error } = await query
            if (error) throw error
            const rows = data || []
            setHasMore(rows.length === PAGE_SIZE)
            setTransactions(prev => reset ? rows : [...prev, ...rows])
        } catch (error) {
            console.error('Error fetching transactions:', error)
        } finally {
            reset ? setLoading(false) : setLoadingMore(false)
        }
    }, [transactions.length, typeFilter, sourceFilter])

    // Re-fetch from the top whenever a server-side filter changes.
    useEffect(() => { fetchTransactions(true) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [typeFilter, sourceFilter])

    // Client-side text search over the loaded rows (server filters narrow the set first).
    const filteredTransactions = transactions.filter(txn =>
        !searchTerm ||
        txn.users?.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        txn.users?.last_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        txn.users?.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        txn.users?.phone_number?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        txn.reference?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        txn.description?.toLowerCase().includes(searchTerm.toLowerCase())
    )

    const exportCsv = () => {
        const header = ['Date', 'User', 'Contact', 'Reference', 'Type', 'Source', 'Description', 'Amount', 'Status']
        const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
        const rows = filteredTransactions.map(t => [
            formatDate(t.created_at),
            `${t.users?.first_name ?? ''} ${t.users?.last_name ?? ''}`.trim(),
            t.users?.phone_number || t.users?.email || '',
            t.reference ?? '', t.type ?? '', t.source ?? '', t.description ?? '',
            t.amount ?? 0, t.status ?? '',
        ].map(esc).join(','))
        const csv = [header.map(esc).join(','), ...rows].join('\n')
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`
        a.click()
        URL.revokeObjectURL(url)
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Global Transactions</h1>
                    <p className="text-muted-foreground">View all wallet transactions across the platform</p>
                </div>
                <Button variant="outline" size="sm" onClick={exportCsv} disabled={filteredTransactions.length === 0}>
                    <Download className="w-4 h-4 mr-1.5" /> Export CSV
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <div className="flex flex-col md:flex-row md:items-center gap-3">
                        <div className="relative w-full md:w-80">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Search loaded rows by user, reference, description…"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-9"
                            />
                        </div>
                        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
                            <SelectTrigger className="w-full md:w-36"><SelectValue placeholder="Type" /></SelectTrigger>
                            <SelectContent>
                                {TYPES.map(t => <SelectItem key={t} value={t}>{t === 'all' ? 'All types' : t}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as any)}>
                            <SelectTrigger className="w-full md:w-40"><SelectValue placeholder="Source" /></SelectTrigger>
                            <SelectContent>
                                {SOURCES.map(s => <SelectItem key={s} value={s}>{s === 'all' ? 'All sources' : s}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>User</TableHead>
                                <TableHead>Reference</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Source</TableHead>
                                <TableHead>Description</TableHead>
                                <TableHead>Amount</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Date</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {loading ? (
                                <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
                            ) : filteredTransactions.length === 0 ? (
                                <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground">No transactions found</TableCell></TableRow>
                            ) : filteredTransactions.map((txn) => (
                                <TableRow key={txn.id}>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-medium">{txn.users?.first_name} {txn.users?.last_name}</span>
                                            <span className="text-xs text-muted-foreground">{txn.users?.phone_number || txn.users?.email}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{txn.reference}</TableCell>
                                    <TableCell>
                                        <Badge variant={txn.type === 'credit' ? 'completed' : 'destructive'}>
                                            {(txn.type ?? '—').toUpperCase()}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-xs capitalize text-muted-foreground">{txn.source ?? '—'}</TableCell>
                                    <TableCell className="max-w-xs truncate">{txn.description}</TableCell>
                                    <TableCell className={txn.type === 'credit' ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                                        {txn.type === 'credit' ? '+' : '-'}{formatCurrency(txn.amount)}
                                    </TableCell>
                                    <TableCell>
                                        <span className={`text-xs capitalize ${txn.status === 'completed' ? 'text-green-600' :
                                            txn.status === 'failed' ? 'text-red-600' : 'text-amber-600'
                                            }`}>
                                            {txn.status}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {formatDate(txn.created_at)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    {!loading && hasMore && (
                        <div className="flex justify-center p-4 border-t">
                            <Button variant="outline" size="sm" onClick={() => fetchTransactions(false)} disabled={loadingMore}>
                                {loadingMore ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
                                Load more
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
