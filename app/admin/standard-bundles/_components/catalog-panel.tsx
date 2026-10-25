'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'

const NETS = ['MTN', 'Telecel', 'AT'] as const

interface CatalogRow {
    value: string | null
    pack_id: string | null
    size: string
    family_label: string
    catalogPrice: number
    customerPrice: number
    kind: 'standard' | 'special'
}
interface CatalogData {
    network: string
    stale: boolean
    enabled: boolean
    discountPct: number
    bundles: CatalogRow[]
    broadband: { enabled: boolean; min: number; max: number } | null
}

export function CatalogPanel() {
    const [network, setNetwork] = useState<(typeof NETS)[number]>('MTN')
    const [data, setData] = useState<CatalogData | null>(null)
    const [loading, setLoading] = useState(false)

    const load = useCallback(async (net: string) => {
        setLoading(true)
        setData(null)
        try {
            const res = await fetch(`/api/admin/standard-bundles/orders?catalog=${encodeURIComponent(net)}`)
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load catalog')
            setData(json.data)
        } catch (e: any) {
            toast.error(e?.message || 'Failed to load catalog')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load(network) }, [network, load])

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                {NETS.map((n) => (
                    <button
                        key={n}
                        onClick={() => setNetwork(n)}
                        className={cn(
                            'px-3 h-8 rounded-lg text-xs font-medium border transition-colors',
                            network === n
                                ? 'bg-slate-900 border-slate-900 text-white dark:bg-white dark:text-slate-900 dark:border-white'
                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500',
                        )}
                    >{n}</button>
                ))}
                <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => load(network)} disabled={loading}>
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /> Refresh
                </Button>
            </div>

            {loading && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>}

            {data && (
                <>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        Discount {data.discountPct}%{data.stale ? ' (catalog may be out of date; supplier unreachable)' : ''}
                        {!data.enabled ? ' (supplier reports this network as disabled)' : ''}
                    </p>
                    {data.broadband && (
                        <p className="text-xs text-slate-600 dark:text-slate-300">
                            Broadband: GHS {data.broadband.min.toFixed(2)} to GHS {data.broadband.max.toFixed(2)} ({data.broadband.enabled ? 'enabled' : 'disabled'} at supplier, never discounted).
                        </p>
                    )}
                    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 dark:bg-slate-900 text-left text-xs text-slate-500">
                                <tr>
                                    <th className="px-3 py-2 font-medium">Bundle</th>
                                    <th className="px-3 py-2 font-medium">Type</th>
                                    <th className="px-3 py-2 font-medium">Catalog code</th>
                                    <th className="px-3 py-2 font-medium text-right">Supplier price</th>
                                    <th className="px-3 py-2 font-medium text-right">Customer pays</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {data.bundles.length === 0 && (
                                    <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">No bundles in the catalog.</td></tr>
                                )}
                                {data.bundles.map((b) => (
                                    <tr key={b.pack_id || b.value || b.size}>
                                        <td className="px-3 py-2 text-slate-900 dark:text-white">{b.size || '-'} <span className="text-xs text-slate-500">{b.family_label}</span></td>
                                        <td className="px-3 py-2 capitalize text-slate-600 dark:text-slate-300">{b.kind}</td>
                                        <td className="px-3 py-2 font-mono text-xs text-slate-500">{b.pack_id || b.value}</td>
                                        <td className="px-3 py-2 text-right tabular-nums">GHS {b.catalogPrice.toFixed(2)}</td>
                                        <td className="px-3 py-2 text-right tabular-nums font-medium">GHS {b.customerPrice.toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    )
}
