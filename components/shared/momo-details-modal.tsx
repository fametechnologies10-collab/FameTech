'use client'

import { useEffect, useState } from 'react'
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils'
import { Loader2, Smartphone, X } from 'lucide-react'

interface MomoDetailsData {
    name: string | null
    number: string
    network: string
    amountPaid: number
    source: 'ussd' | 'website'
}

interface MomoDetailsModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Full API path to fetch, e.g. `/api/shop/orders/<id>/momo-details`. Pass null while nothing is selected. */
    fetchUrl: string | null
}

export function MomoDetailsModal({ open, onOpenChange, fetchUrl }: MomoDetailsModalProps) {
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [data, setData] = useState<MomoDetailsData | null>(null)

    useEffect(() => {
        if (!open || !fetchUrl) {
            setData(null)
            setError(null)
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        setError(null)
        setData(null)

        fetch(fetchUrl, { cache: 'no-store' })
            .then(async (res) => {
                const json = await res.json().catch(() => ({}))
                if (cancelled) return
                if (!res.ok || !json.success) {
                    setError(json.error || 'MoMo details unavailable for this order')
                    return
                }
                setData(json.data)
            })
            .catch(() => {
                if (!cancelled) setError('MoMo details unavailable for this order')
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => { cancelled = true }
    }, [open, fetchUrl])

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent hideCloseButton className="max-w-sm">
                <div className="relative flex items-center justify-center">
                    <DialogClose className="absolute right-3 w-9 h-9 rounded-full flex items-center justify-center hover:bg-muted transition-colors">
                        <X className="w-4 h-4" />
                        <span className="sr-only">Close</span>
                    </DialogClose>
                </div>

                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Smartphone className="w-4 h-4" /> MoMo Payment Details
                    </DialogTitle>
                    <DialogDescription>The number and name used to pay for this order.</DialogDescription>
                </DialogHeader>

                {loading && (
                    <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                    </div>
                )}

                {!loading && error && (
                    <div className="py-6 text-center text-sm text-muted-foreground">{error}</div>
                )}

                {!loading && !error && data && (
                    <div className="space-y-3 py-2">
                        <div className="flex justify-between items-center gap-3">
                            <span className="text-xs uppercase text-muted-foreground font-medium">MoMo Name</span>
                            <span className="text-sm font-semibold text-right">{data.name || 'Unavailable'}</span>
                        </div>
                        <div className="flex justify-between items-center gap-3">
                            <span className="text-xs uppercase text-muted-foreground font-medium">MoMo Number</span>
                            <span className="text-sm font-mono font-semibold">{data.number}</span>
                        </div>
                        <div className="flex justify-between items-center gap-3">
                            <span className="text-xs uppercase text-muted-foreground font-medium">Network</span>
                            <Badge variant="outline">{data.network || 'Unknown'}</Badge>
                        </div>
                        <div className="flex justify-between items-center gap-3 border-t pt-3">
                            {/* "Order Value", not "Total Paid": for USSD airtime, selling_price is the
                                airtime face value, but the customer was actually charged face value
                                PLUS a fee (verified across all USSD airtime payloads). Stating a false
                                charged amount on a refund screen is not acceptable — this is the cheap,
                                correct label. Sourcing the true charged amount is out of scope here. */}
                            <span className="text-xs uppercase text-muted-foreground font-medium">Order Value</span>
                            <span className="text-sm font-bold text-primary">{formatCurrency(data.amountPaid)}</span>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}
