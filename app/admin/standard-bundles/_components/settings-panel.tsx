'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/toast'

type FlagNet = 'mtn' | 'telecel' | 'at' | 'broadband'
type DiscNet = 'mtn' | 'telecel' | 'at'

interface State {
    enabled: boolean
    networks: Record<FlagNet, boolean>
    discounts: Record<DiscNet, number>
}

const FLAG_NETS: { key: FlagNet; label: string }[] = [
    { key: 'mtn', label: 'MTN' },
    { key: 'telecel', label: 'Telecel' },
    { key: 'at', label: 'AirtelTigo' },
    { key: 'broadband', label: 'Broadband' },
]
const DISC_NETS: { key: DiscNet; label: string }[] = [
    { key: 'mtn', label: 'MTN' },
    { key: 'telecel', label: 'Telecel' },
    { key: 'at', label: 'AirtelTigo' },
]

// Mirrors the server rule: a number from 0 to 50 with at most 2 decimals.
function parseDiscountInput(raw: string): number | null {
    if (raw.trim() === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0 || n > 50) return null
    if (Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) return null
    return n
}

export function SettingsPanel() {
    const [state, setState] = useState<State | null>(null)
    const [discountText, setDiscountText] = useState<Record<DiscNet, string>>({ mtn: '0', telecel: '0', at: '0' })
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    const apply = useCallback((s: State) => {
        setState(s)
        setDiscountText({ mtn: String(s.discounts.mtn), telecel: String(s.discounts.telecel), at: String(s.discounts.at) })
    }, [])

    useEffect(() => {
        let alive = true
        ;(async () => {
            try {
                const res = await fetch('/api/admin/standard-bundles/settings')
                const json = await res.json()
                if (!alive) return
                if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load settings')
                apply(json.data)
            } catch (e: any) {
                toast.error(e?.message || 'Failed to load settings')
            } finally {
                if (alive) setLoading(false)
            }
        })()
        return () => { alive = false }
    }, [apply])

    const save = async () => {
        if (!state) return
        const discounts: Record<string, number> = {}
        for (const { key, label } of DISC_NETS) {
            const n = parseDiscountInput(discountText[key])
            if (n === null) {
                toast.error(`${label} discount must be 0 to 50, up to 2 decimals`)
                return
            }
            discounts[key] = n
        }
        setSaving(true)
        try {
            const res = await fetch('/api/admin/standard-bundles/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: state.enabled, networks: state.networks, discounts }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to save settings')
            apply(json.data)
            toast.success('Settings saved')
        } catch (e: any) {
            toast.error(e?.message || 'Failed to save settings')
        } finally {
            setSaving(false)
        }
    }

    if (loading) {
        return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>
    }
    if (!state) return <p className="text-sm text-slate-500 py-8 text-center">Settings could not be loaded.</p>

    const exampleFor = (n: DiscNet) => {
        const pct = parseDiscountInput(discountText[n])
        if (pct === null) return 'Enter a discount from 0 to 50.'
        const price = Math.round(20 * (1 - pct / 100) * 100) / 100
        return `A GHS 20.00 bundle sells for GHS ${price.toFixed(2)} at ${pct}%.`
    }

    return (
        <div className="space-y-4 max-w-3xl">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-4">
                <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">Standard Bundles module</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Turn off to stop all new bundle purchases and dispatches.</p>
                </div>
                <Switch checked={state.enabled} onCheckedChange={(v) => setState({ ...state, enabled: v })} aria-label="Module enabled" />
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Networks</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {FLAG_NETS.map(({ key, label }) => (
                        <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
                            <span className="text-sm text-slate-700 dark:text-slate-200">{label}</span>
                            <Switch
                                checked={state.networks[key]}
                                onCheckedChange={(v) => setState({ ...state, networks: { ...state.networks, [key]: v } })}
                                aria-label={`${label} enabled`}
                            />
                        </div>
                    ))}
                </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">Customer discount</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        Percent off the supplier catalog price (0 to 50). Broadband is never discounted.
                    </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                    {DISC_NETS.map(({ key, label }) => {
                        const invalid = parseDiscountInput(discountText[key]) === null
                        return (
                            <div key={key} className="space-y-1">
                                <Label htmlFor={`disc-${key}`}>{label} discount (%)</Label>
                                <Input
                                    id={`disc-${key}`}
                                    inputMode="decimal"
                                    value={discountText[key]}
                                    onChange={(e) => setDiscountText({ ...discountText, [key]: e.target.value })}
                                    className={invalid ? 'border-red-400' : ''}
                                />
                                <p className={`text-xs ${invalid ? 'text-red-500' : 'text-slate-500 dark:text-slate-400'}`}>{exampleFor(key)}</p>
                            </div>
                        )
                    })}
                </div>
            </div>

            <Button onClick={save} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save settings
            </Button>
        </div>
    )
}
