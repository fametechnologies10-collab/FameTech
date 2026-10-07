// app/dashboard/commission/history/page.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Loader2, Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { TransactionRow, type CommissionTransaction } from '@/components/dashboard/commission-transaction-row'

export default function CommissionHistoryPage() {
    const router = useRouter()
    const [fromDate, setFromDate] = useState('')
    const [toDate, setToDate] = useState('')
    const [transactions, setTransactions] = useState<CommissionTransaction[]>([])
    const [loading, setLoading] = useState(false)
    const [searched, setSearched] = useState(false)

    const handleFind = async () => {
        if (!fromDate || !toDate) {
            toast.error('Pick both a from and a to date')
            return
        }
        setLoading(true)
        try {
            const params = new URLSearchParams({ from: fromDate, to: toDate })
            const res = await fetch(`/api/commission/transactions?${params}`)
            const data = await res.json()
            if (data.success) {
                setTransactions(data.data.transactions)
                setSearched(true)
            } else {
                toast.error(data.error || 'Failed to load history')
            }
        } catch {
            toast.error('Failed to load history')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
            <div>
                <Button
                    variant="ghost"
                    className="w-fit -ml-4 text-muted-foreground hover:text-foreground"
                    onClick={() => router.push('/dashboard/commission')}
                >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to Commission Wallet
                </Button>
                <h1 className="text-2xl font-bold mt-1">Full Transaction History</h1>
                <p className="text-muted-foreground text-sm">Pick a date range to see every commission wallet movement in it.</p>
            </div>

            <Card>
                <CardHeader><CardTitle className="text-base">Date Range</CardTitle></CardHeader>
                <CardContent>
                    <div className="flex flex-col sm:flex-row gap-4 sm:items-end">
                        <div className="space-y-2 w-full sm:w-auto">
                            <Label className="text-xs font-medium text-muted-foreground">From</Label>
                            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full sm:w-auto" />
                        </div>
                        <div className="space-y-2 w-full sm:w-auto">
                            <Label className="text-xs font-medium text-muted-foreground">To</Label>
                            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full sm:w-auto" />
                        </div>
                        <Button onClick={handleFind} disabled={loading} className="w-full sm:w-auto gap-2">
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                            Find
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle className="text-base">Results</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                    {loading ? (
                        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : !searched ? (
                        <p className="text-center py-10 text-sm text-muted-foreground">Choose a date range above and press Find.</p>
                    ) : transactions.length === 0 ? (
                        <p className="text-center py-10 text-sm text-muted-foreground">No movements in that range.</p>
                    ) : (
                        transactions.map((r) => <TransactionRow key={r.id} r={r} />)
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
