'use client'

/**
 * SavedAccountsGrid — a responsive card grid of saved accounts FOR ONE BILLER,
 * rendered inside UtilityFlowSheet's account step (replaces the old page-level
 * MyAccountsRow horizontal chip strip, which mixed every biller together and
 * was the "looks poor" complaint). Scoping to a single biller here means each
 * biller's sheet can show exactly the fields that matter for it, with room to
 * grow (a grid cell has far more room than a 190px-wide scroll chip did).
 *
 * Tap a card → parent applies it (prefill + auto-run a FRESH lookup — saved
 * data is a shortcut, never a verification bypass).
 * The ⋯ menu on each card offers Rename (inline input, ≤30 chars, PATCH) and
 * Remove (inline confirm — no native confirm(), DELETE).
 *
 * Renders nothing at all when the list is empty — the caller decides whether
 * to show a "Saved accounts" heading around it.
 */

import { useState } from 'react'
import { Check, Loader2, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UTILITY_BILLERS } from '@/lib/hubtel-utility/billers'
import { BILLER_UI } from './biller-ui'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'
import type { UtilitySavedAccount } from './types'

function maskAccount(account: string): string {
    if (account.length <= 4) return account
    return `…${account.slice(-4)}`
}

interface SavedAccountsGridProps {
    /** Already scoped to a single biller by the caller. */
    accounts: UtilitySavedAccount[]
    /** Tap-to-pay — parent prefills the flow and auto-runs a fresh lookup. */
    onPay: (account: UtilitySavedAccount) => void
    /** Called after a successful rename/remove so the parent refetches. */
    onChanged: () => void
}

export function SavedAccountsGrid({ accounts, onPay, onChanged }: SavedAccountsGridProps) {
    const [renamingId, setRenamingId] = useState<string | null>(null)
    const [renameValue, setRenameValue] = useState('')
    const [removingId, setRemovingId] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    if (accounts.length === 0) return null

    const startRename = (acc: UtilitySavedAccount) => {
        setRemovingId(null)
        setRenamingId(acc.id)
        setRenameValue(acc.label ?? '')
    }

    const submitRename = async (id: string) => {
        setBusyId(id)
        try {
            const res = await fetch('/api/utilities/saved', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, label: renameValue.trim().slice(0, 30) }),
            })
            const data = await res.json().catch(() => null)
            if (res.ok && data?.success) {
                toast.success('Account renamed')
                setRenamingId(null)
                onChanged()
            } else {
                toast.error(data?.error || 'Could not rename account')
            }
        } catch {
            toast.error('Could not rename account')
        } finally {
            setBusyId(null)
        }
    }

    const submitRemove = async (id: string) => {
        setBusyId(id)
        try {
            const res = await fetch('/api/utilities/saved', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            })
            const data = await res.json().catch(() => null)
            if (res.ok && data?.success) {
                toast.success('Account removed')
                setRemovingId(null)
                onChanged()
            } else {
                toast.error(data?.error || 'Could not remove account')
            }
        } catch {
            toast.error('Could not remove account')
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {accounts.map((acc) => {
                const def = UTILITY_BILLERS[acc.biller]
                const ui = BILLER_UI[acc.biller]
                if (!def || !ui) return null
                const displayName = acc.label ?? acc.account_name ?? acc.account_number
                const isRenaming = renamingId === acc.id
                const isRemoving = removingId === acc.id
                const isBusy = busyId === acc.id

                return (
                    <div
                        key={acc.id}
                        className="rounded-2xl border border-border bg-card shadow-sm"
                    >
                        {isRenaming ? (
                            /* Inline rename */
                            <div className="p-3 space-y-2">
                                <input
                                    autoFocus
                                    type="text"
                                    maxLength={30}
                                    value={renameValue}
                                    placeholder={acc.account_name ?? acc.account_number}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') submitRename(acc.id) }}
                                    className="w-full h-9 rounded-lg border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                />
                                <div className="flex items-center justify-end gap-1.5">
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => setRenamingId(null)}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
                                    >
                                        <X className="w-4 h-4" />
                                        <span className="sr-only">Cancel rename</span>
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => submitRename(acc.id)}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center bg-foreground text-background hover:opacity-90 transition-opacity"
                                    >
                                        {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                        <span className="sr-only">Save name</span>
                                    </button>
                                </div>
                            </div>
                        ) : isRemoving ? (
                            /* Inline remove confirm — never native confirm() */
                            <div className="p-3 space-y-2">
                                <p className="text-xs text-foreground">
                                    Remove <span className="font-semibold">{displayName}</span>?
                                </p>
                                <div className="flex items-center justify-end gap-2">
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => setRemovingId(null)}
                                        className="px-2.5 h-8 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
                                    >
                                        Keep
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => submitRemove(acc.id)}
                                        className="px-2.5 h-8 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors inline-flex items-center gap-1.5"
                                    >
                                        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                        Remove
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* Normal card — a full column, so there's room for name, masked
                               number, last-paid AND (for ECG/GW) the linked phone, unlike the
                               old horizontal chip which had to fit everything on one line. */
                            <div className="flex flex-col gap-2.5 p-3">
                                <div className="flex items-start justify-between gap-1">
                                    <UtilityBillerLogo biller={acc.biller} FallbackIcon={ui.Icon} badgeClassName={ui.badge} size={36} />
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button
                                                type="button"
                                                className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors shrink-0 -mt-0.5 -mr-0.5"
                                                aria-label={`Options for ${displayName}`}
                                            >
                                                <MoreHorizontal className="w-4 h-4" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" className="w-36">
                                            <DropdownMenuItem onClick={() => startRename(acc)}>
                                                <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                className="text-red-600 focus:text-red-600 dark:text-red-400"
                                                onClick={() => { setRenamingId(null); setRemovingId(acc.id) }}
                                            >
                                                <Trash2 className="w-3.5 h-3.5 mr-2" /> Remove
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onPay(acc)}
                                    className="text-left active:opacity-70 transition-opacity"
                                >
                                    <p className="text-sm font-semibold truncate">{displayName}</p>
                                    <p className="text-[11px] text-muted-foreground truncate font-mono mt-0.5">
                                        {maskAccount(acc.account_number)}
                                    </p>
                                    {acc.destination_phone && (
                                        <p className="text-[11px] text-muted-foreground truncate font-mono">
                                            {acc.destination_phone}
                                        </p>
                                    )}
                                    {typeof acc.last_amount === 'number' && acc.last_amount > 0 && (
                                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                                            Last paid GHS {acc.last_amount.toFixed(2)}
                                        </p>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
