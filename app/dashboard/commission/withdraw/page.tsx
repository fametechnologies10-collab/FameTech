// app/dashboard/commission/withdraw/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Loader2, Banknote } from 'lucide-react'
import { toast } from '@/lib/toast'

const NETWORKS = ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'] as const

/** Parses and validates a withdrawal amount against the available balance.
 *  Strict `>` against balance so withdrawing the exact full balance is allowed.
 *  The server remains authoritative for the admin-configurable minimum — this
 *  only catches the client-obvious cases (non-finite, non-positive, over balance). */
function validateWithdrawAmount(raw: string, balance: number): { amount: number; error: string | null } {
    const trimmed = raw.trim()
    const amount = Number(trimmed)
    if (trimmed === '') return { amount: 0, error: null }
    if (!Number.isFinite(amount) || amount <= 0) return { amount, error: 'Enter a valid amount' }
    if (amount > balance) return { amount, error: `Amount exceeds your available balance of ${formatCurrency(balance)}` }
    return { amount, error: null }
}

export default function CommissionWithdrawPage() {
    const router = useRouter()
    const [balance, setBalance] = useState(0)
    const [amount, setAmount] = useState('')
    const [momoNumber, setMomoNumber] = useState('')
    const [network, setNetwork] = useState<typeof NETWORKS[number]>('MTN MoMo')
    const [loading, setLoading] = useState(true)
    const [submitting, setSubmitting] = useState(false)
    // Revealed only after the server can't verify the MoMo name via Moolre —
    // mirrors app/dashboard/shop/withdraw/page.tsx's manual-fallback flow.
    const [needsManualName, setNeedsManualName] = useState(false)
    const [manualName, setManualName] = useState('')

    useEffect(() => {
        fetch('/api/commission/wallet').then(r => r.json()).then((res) => {
            if (res.success) setBalance(res.data.balance)
            setLoading(false)
        }).catch(() => setLoading(false))
    }, [])

    const { amount: parsedAmount, error: amountError } = validateWithdrawAmount(amount, balance)
    const canSubmit = amount.trim() !== '' && !amountError && parsedAmount > 0 && momoNumber.trim() !== ''
        && (!needsManualName || manualName.trim().length >= 2)

    const handleSubmit = async () => {
        if (!canSubmit) {
            toast.error(amountError || 'Enter a valid amount')
            return
        }
        if (needsManualName && !manualName.trim()) {
            toast.error('Enter the account holder\'s name')
            return
        }
        setSubmitting(true)
        try {
            const res = await fetch('/api/commission/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: parsedAmount, momoNumber: momoNumber.trim(), network,
                    ...(needsManualName ? { manualAccountName: manualName.trim() } : {}),
                }),
            })
            const data = await res.json()
            if (data.success) {
                toast.success('Withdrawal requested — awaiting admin approval')
                router.push('/dashboard/commission')
            } else if (!needsManualName && /verify account name/i.test(data.error || '')) {
                // We couldn't confirm this number automatically — let the user type
                // the name themselves instead of dead-ending on a bare error toast.
                setNeedsManualName(true)
                toast.error('Could not auto-verify this number. Enter the account name to continue.')
            } else {
                toast.error(data.error || 'Withdrawal failed')
            }
        } catch {
            toast.error('Withdrawal failed')
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>

    return (
        <div className="p-4 md:p-6 max-w-md mx-auto space-y-4">
            <Link href="/dashboard/commission" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4" /> Back to Commission Wallet
            </Link>
            <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><Banknote className="w-5 h-5" /> Withdraw Commission</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label>Amount (GHS)</Label>
                            <span className="text-xs text-muted-foreground">Available: {formatCurrency(balance)}</span>
                        </div>
                        <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                        {amountError && (
                            <p className="text-xs text-red-600">{amountError}</p>
                        )}
                    </div>
                    <div className="space-y-2">
                        <Label>Network</Label>
                        <Select value={network} onValueChange={(v) => setNetwork(v as typeof NETWORKS[number])}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {NETWORKS.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label>MoMo Number</Label>
                        <Input
                            value={momoNumber}
                            onChange={(e) => {
                                setMomoNumber(e.target.value)
                                // A changed number invalidates any manual-name fallback
                                // typed for the previous number — never carry it forward.
                                setNeedsManualName(false)
                                setManualName('')
                            }}
                            placeholder="0241234567"
                        />
                    </div>
                    {needsManualName && (
                        <div className="space-y-2">
                            <Label>Account Holder Name</Label>
                            <Input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Full name on the MoMo account" />
                            <p className="text-xs text-amber-600">We couldn&apos;t auto-verify this number. Your withdrawal will be flagged for extra admin review.</p>
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">Paid out via Paystack Mobile Money only. Withdrawals require admin approval before payout — this is not instant.</p>
                    <Button className="w-full" onClick={handleSubmit} disabled={submitting || !canSubmit}>
                        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Request Withdrawal'}
                    </Button>
                </CardContent>
            </Card>
        </div>
    )
}
