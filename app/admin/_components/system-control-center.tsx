'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { SlidersHorizontal, ExternalLink, ShieldAlert, AlertTriangle } from 'lucide-react'
import { cardSurface, mutedSurface, sectionLabel, accent } from './dashboard-tokens'
import { CRITICAL_TOGGLE_KEYS, MONEY_CONFIG_KEYS, TOGGLE_META, type ToggleKey } from '@/lib/admin-settings'

// Per-key default when the setting row is absent (mirrors /admin/settings parsing).
const DEFAULT_ON: Record<ToggleKey, boolean> = {
    auto_fulfillment_enabled: false,
    ussd_enabled: true,
    phone_verification_enabled: false,
    page_access_storefront: true,
    mtn_express_delivery_enabled: false,
    number_registration_gate_enabled: false,
    mtn_agentportal_whitelist_gate_enabled: false,
    mtn_bundleportal_whitelist_gate_enabled: false,
}

const MONEY_LABELS: Record<string, { label: string; prefix?: string; suffix?: string }> = {
    paystack_fee_percent: { label: 'Customer Fee', suffix: '%' },
    agent_paystack_fee_percent: { label: 'Agent Fee', suffix: '%' },
    dealer_paystack_fee_percent: { label: 'Dealer Fee', suffix: '%' },
    paystack_min_topup: { label: 'Min Top-up', prefix: '₵' },
    paystack_max_topup: { label: 'Max Top-up', prefix: '₵' },
    mtn_price_adjustment: { label: 'MTN Adj.', prefix: '₵' },
}

export function SystemControlCenter() {
    const { isAdmin } = useAuth()
    const [settings, setSettings] = useState<Record<string, string>>({})
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)

    useEffect(() => {
        let active = true
        const keys = [...CRITICAL_TOGGLE_KEYS, ...MONEY_CONFIG_KEYS]
        ;(supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', keys)
            .then(({ data }: { data: { key: string; value: string }[] | null }) => {
                if (!active) return
                const map: Record<string, string> = {}
                ;(data || []).forEach(r => { map[r.key] = r.value })
                setSettings(map)
                setLoading(false)
            })
        return () => { active = false }
    }, [])

    const isOn = (key: ToggleKey): boolean => {
        const v = settings[key]
        if (v === undefined) return DEFAULT_ON[key]
        return DEFAULT_ON[key] ? v !== 'false' : v === 'true'
    }

    const handleToggle = async (key: ToggleKey, next: boolean) => {
        if (!isAdmin) return
        setBusy(key)
        const prev = settings[key]
        setSettings(s => ({ ...s, [key]: next ? 'true' : 'false' })) // optimistic
        try {
            const res = await fetch('/api/admin/settings/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value: next }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.error || 'Failed to update')
            }
            // Reconcile from the server's canonical value rather than the optimistic guess.
            const body = await res.json().catch(() => ({}))
            if (body?.value === 'true' || body?.value === 'false') {
                setSettings(s => ({ ...s, [key]: body.value }))
            }
            toast.success(`${TOGGLE_META[key].label} ${next ? 'enabled' : 'disabled'}`)
        } catch (e: any) {
            setSettings(s => ({ ...s, [key]: prev })) // revert
            toast.error(e.message || 'Failed to update setting')
        } finally {
            setBusy(null)
        }
    }

    const paymentMaintenance = process.env.NEXT_PUBLIC_PAYMENT_MAINTENANCE_MODE === 'true'

    return (
        <div className={cn(cardSurface, 'p-5')}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4" style={{ color: accent.red }} />
                    <p className={sectionLabel}>System Controls</p>
                </div>
                <Link href="/admin/settings" className="inline-flex items-center gap-1 text-[11px] font-bold text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white">
                    Manage in Settings <ExternalLink className="w-3 h-3" />
                </Link>
            </div>

            {!isAdmin && (
                <div className="flex items-center gap-2 mb-3 text-[11px] text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="w-3.5 h-3.5" /> Read-only — admin role required to change controls.
                </div>
            )}

            {/* Kill-switches */}
            <div className="space-y-2">
                {CRITICAL_TOGGLE_KEYS.map(key => {
                    const on = isOn(key)
                    return (
                        <div key={key} className={cn(mutedSurface, 'p-3 flex items-center justify-between gap-3')}>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-zinc-900 dark:text-white">{TOGGLE_META[key].label}</p>
                                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{TOGGLE_META[key].description}</p>
                            </div>
                            <Switch
                                checked={on}
                                disabled={!isAdmin || busy === key || loading}
                                onCheckedChange={(v) => handleToggle(key, v)}
                                className="flex-shrink-0"
                            />
                        </div>
                    )
                })}

                {/* Payment maintenance — env-controlled, read-only */}
                <div className={cn(mutedSurface, 'p-3 flex items-center justify-between gap-3')}>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-1.5">
                            Payment Maintenance
                            {paymentMaintenance && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                        </p>
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Set via environment — redeploy to change</p>
                    </div>
                    <span className={cn('text-[11px] font-bold px-2 py-1 rounded-full whitespace-nowrap', paymentMaintenance ? 'text-amber-600 bg-amber-50 dark:bg-amber-500/10' : 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10')}>
                        {paymentMaintenance ? 'ON' : 'OFF'}
                    </span>
                </div>
            </div>

            {/* Read-only money config */}
            <p className={cn(sectionLabel, 'mt-5 mb-2')}>Money Config</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {MONEY_CONFIG_KEYS.map(key => {
                    const meta = MONEY_LABELS[key]
                    const raw = settings[key]
                    const display = raw && raw.trim() !== '' ? `${meta.prefix || ''}${raw}${meta.suffix || ''}` : '—'
                    return (
                        <div key={key} className={cn(mutedSurface, 'p-2.5')}>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 truncate">{meta.label}</p>
                            <p className="text-sm font-bold text-zinc-900 dark:text-white">{loading ? '…' : display}</p>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
