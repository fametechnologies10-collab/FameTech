'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import type { WithdrawalRow } from './types'

export function useAdminWithdrawals() {
    const [rows, setRows] = useState<WithdrawalRow[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [filters, setFilters] = useState({ view: 'queue', status: 'all', provider: 'all', shopOwnerId: 'all', search: '', page: 1, pageSize: 25 })
    const inFlightRef = useRef<Set<string>>(new Set())
    const [inFlight, setInFlight] = useState<string[]>([])

    const refresh = useCallback(async () => {
        setLoading(true); setError(null)
        try {
            const p = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]))
            const res = await fetch(`/api/admin/withdrawals?${p}`)
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to load')
            setRows(json.data.rows); setTotal(json.data.total)
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Unknown error'
            setError(msg); toast.error(msg)
        } finally { setLoading(false) }
    }, [filters])

    useEffect(() => { refresh() }, [refresh])

    const markFlight = (ids: string[], on: boolean) => {
        ids.forEach(id => on ? inFlightRef.current.add(id) : inFlightRef.current.delete(id))
        setInFlight([...inFlightRef.current])
    }

    const processOne = useCallback(async (transactionId: string, action: 'paystack' | 'manual' | 'refund', adminNote?: string) => {
        // CLIENT-SIDE DOUBLE-CHARGE GUARD: refuse a second submit for an in-flight row.
        if (inFlightRef.current.has(transactionId)) return { skipped: true }
        markFlight([transactionId], true)
        try {
            const res = await fetch('/api/admin/process-withdrawal', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactionId, action, adminNote }),
            })
            const json = await res.json()
            if (!res.ok || json.success === false) throw new Error(json.error || 'Failed')
            return json
        } finally { markFlight([transactionId], false); refresh() }
    }, [refresh])

    const processBulk = useCallback(async (transactionIds: string[], action: 'paystack' | 'manual', adminNote?: string) => {
        const fresh = transactionIds.filter(id => !inFlightRef.current.has(id))
        if (fresh.length === 0) return { skipped: true }
        markFlight(fresh, true)
        try {
            const res = await fetch('/api/admin/process-withdrawal', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactionIds: fresh, action, adminNote }),
            })
            const json = await res.json()
            if (!res.ok || json.success === false) throw new Error(json.error || 'Bulk failed')
            return json
        } finally { markFlight(fresh, false); refresh() }
    }, [refresh])

    return { rows, total, loading, error, filters, setFilters, refresh, processOne, processBulk, inFlight }
}
