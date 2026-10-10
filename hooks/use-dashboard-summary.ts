'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'
import {
    fetchDashboardSummary,
    shouldPoll,
    POLL_INTERVAL_MS,
    type DashboardSummary,
} from '@/lib/dashboard-summary'

// The generated Database types don't know the get_dashboard_summary RPC yet,
// so narrow the client to the one method the fetcher needs.
const rpcClient = supabase as unknown as Pick<SupabaseClient, 'rpc'>

export function useDashboardSummary(): {
    summary: DashboardSummary | null
    isLoading: boolean
    error: Error | null
    refresh: () => Promise<void>
} {
    const { dbUser } = useAuth()
    const userId = dbUser?.id ?? null

    const [summary, setSummary] = useState<DashboardSummary | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const [hidden, setHidden] = useState(false)

    const mountedRef = useRef(true)
    const inFlightRef = useRef(false)
    const summaryRef = useRef<DashboardSummary | null>(null)

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const refresh = useCallback(async (): Promise<void> => {
        if (inFlightRef.current) return
        inFlightRef.current = true
        try {
            const next = await fetchDashboardSummary(rpcClient)
            if (!mountedRef.current) return
            summaryRef.current = next
            setSummary(next)
            setError(null)
        } catch (e) {
            if (!mountedRef.current) return
            // Keep the previous summary on a failed poll; only surface the
            // error when there is nothing to show yet.
            if (!summaryRef.current) {
                setError(e instanceof Error ? e : new Error('Failed to load dashboard summary'))
            }
        } finally {
            inFlightRef.current = false
            if (mountedRef.current) setIsLoading(false)
        }
    }, [])

    // Initial load once the user is known.
    useEffect(() => {
        if (!userId) return
        void refresh()
    }, [userId, refresh])

    // Track tab visibility; refetch when it becomes visible and polling applies.
    useEffect(() => {
        const onVisibility = () => {
            const isHidden = document.hidden
            setHidden(isHidden)
            if (!isHidden && userId && shouldPoll(summaryRef.current, false)) {
                void refresh()
            }
        }
        onVisibility()
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [userId, refresh])

    const polling = !!userId && shouldPoll(summary, hidden)

    useEffect(() => {
        if (!polling) return
        const id = setInterval(() => {
            void refresh()
        }, POLL_INTERVAL_MS)
        return () => clearInterval(id)
    }, [polling, refresh])

    return { summary, isLoading, error, refresh }
}
