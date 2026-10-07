'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RefreshCw } from 'lucide-react'

/**
 * Inline expand-to-confirm refund control. iOS-PWA safe (NO native confirm()).
 * Mirrors the production withdrawal Reject&Refund pattern:
 *   click → reveal a panel (optional warning + optional extra controls + optional reason) → Cancel/Confirm.
 * The `busy` flag guards against double-taps; `onConfirm` should throw on failure so the panel stays open.
 */
export interface RefundConfirmProps {
  /** Trigger button label. */
  label?: string
  triggerVariant?: 'outline' | 'destructive' | 'ghost' | 'secondary' | 'default'
  size?: 'sm' | 'default'
  /** Warning line shown in the confirm panel (e.g. processing "may already be delivered"). */
  warning?: string
  confirmLabel?: string
  /** Require a non-empty reason before Confirm enables. */
  requireReason?: boolean
  reasonPlaceholder?: string
  /** Called with the (trimmed) reason. Throw to keep the panel open (e.g. on API failure). */
  onConfirm: (reason: string) => Promise<void>
  disabled?: boolean
  className?: string
  /** Extra controls rendered inside the panel (e.g. a shop refund mechanism picker). */
  children?: ReactNode
  /** Consumer gate — Confirm stays disabled until true (e.g. a mechanism has been chosen). */
  canConfirm?: boolean
}

export function RefundConfirm({
  label = 'Refund',
  triggerVariant = 'outline',
  size = 'sm',
  warning,
  confirmLabel = 'Confirm refund',
  requireReason = false,
  reasonPlaceholder = 'Reason (optional)…',
  onConfirm,
  disabled = false,
  className = '',
  children,
  canConfirm = true,
}: RefundConfirmProps) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const reasonOk = !requireReason || reason.trim().length > 0
  const confirmDisabled = busy || !reasonOk || !canConfirm

  const handleConfirm = async () => {
    if (confirmDisabled) return
    setBusy(true)
    try {
      await onConfirm(reason.trim())
      setOpen(false)
      setReason('')
    } catch {
      // keep panel open; consumer surfaces the error (toast). Never double-submits (busy guard).
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant={triggerVariant}
        size={size}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={className}
      >
        <RefreshCw className="w-4 h-4 mr-1.5 text-amber-500" />
        {label}
      </Button>
    )
  }

  return (
    <div className={`rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2 ${className}`}>
      {warning && (
        <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
      {children}
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={reasonPlaceholder}
        rows={2}
        className="w-full text-sm rounded-md border border-input bg-background px-2.5 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setOpen(false); setReason('') }}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={confirmDisabled} onClick={handleConfirm}>
          {busy ? 'Processing…' : confirmLabel}
        </Button>
      </div>
    </div>
  )
}

export default RefundConfirm
