'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatCurrency, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Copy, Check, AlertTriangle, Loader2, Smartphone, Landmark } from 'lucide-react'
import type { WithdrawalRow } from './types'

// Moolre payouts retired 2026-09-26 — Paystack (MoMo) + manual only.
type Provider = 'paystack' | 'manual'

export function PayoutDialog({
  row,
  open,
  onOpenChange,
  onPaid,
  processOne,
}: {
  row: WithdrawalRow | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onPaid: () => void
  processOne: (id: string, action: Provider, note?: string) => Promise<any>
}) {
  const [provider, setProvider] = useState<Provider>('manual')
  const [paying, setPaying] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => { if (row) { setProvider('manual'); setCopied(false) } }, [row?.id])

  if (!row) return null

  const isBank = row.payment_type === 'bank'
  const dest = row.momo_number ?? row.account_number ?? ''

  // Provider eligibility
  const paystackOk = !isBank   // MoMo only

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(dest)
      setCopied(true)
      toast.success(`Copied ${dest}`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy — please copy manually')
    }
  }

  const pay = async () => {
    if (paying) return  // single-submit guard (defense-in-depth over hook's in-flight ref)
    setPaying(true)
    try {
      const r = await processOne(row.id, provider)
      if (r?.skipped) {
        toast.info('Already processing — please wait')
        return
      }
      toast.success(
        `Payout ${r?.status === 'completed' ? 'completed' : 'submitted'} via ${provider}`
      )
      onOpenChange(false)
      onPaid()
    } catch (e: any) {
      toast.error(e?.message ?? 'Payout failed')
    } finally {
      setPaying(false)
    }
  }

  const net = row.net_amount ?? 0
  const gross = row.amount ?? 0
  const fee = row.fee ?? 0

  const providerOptions: [Provider, string, boolean][] = [
    ['paystack', 'Paystack', paystackOk],
    ['manual', 'Manual', true],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm payout</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Net amount — primary */}
          <div className="text-center">
            <p className="text-4xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
              {formatCurrency(net)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Gross {formatCurrency(gross)} · Fee {formatCurrency(fee)}
            </p>
          </div>

          {/* Unverified-name warning */}
          {row.name_unverified && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                <strong>Name not verified.</strong> The name lookup could not confirm this account
                holder. Verify with the shop owner before paying.
              </span>
            </div>
          )}

          {/* Destination block */}
          <div className="rounded-xl border p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Account name</span>
              <span className="font-semibold">{row.account_name ?? '—'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {isBank ? 'Account no.' : 'MoMo number'}
              </span>
              <button
                onClick={copy}
                className="font-mono inline-flex items-center gap-1 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
              >
                {dest}
                {copied
                  ? <Check className="w-3 h-3" />
                  : <Copy className="w-3 h-3" />}
              </button>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Network</span>
              <span>{row.network ?? '—'}</span>
            </div>
          </div>

          {/* Provider selector */}
          <div>
            <p className="text-[11px] font-bold uppercase text-muted-foreground mb-1.5">
              Pay with
            </p>
            <div className="grid grid-cols-2 gap-2">
              {providerOptions.map(([id, label, ok]) => (
                <button
                  key={id}
                  disabled={!ok}
                  onClick={() => setProvider(id)}
                  className={cn(
                    'h-10 rounded-lg text-xs font-bold border-2 transition',
                    provider === id
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'
                      : 'border-border',
                    !ok && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  {label}
                  {!ok && id === 'paystack' ? ' (MoMo only)' : ''}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={paying}
          >
            Cancel
          </Button>
          <Button
            onClick={pay}
            disabled={paying}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold gap-2"
          >
            {paying
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : provider === 'manual'
                ? <Landmark className="w-4 h-4" />
                : <Smartphone className="w-4 h-4" />}
            Pay {formatCurrency(net)} now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
