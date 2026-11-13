'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import type { GatewayNetwork } from '@/lib/gateway-health'

export interface GatewayStatusData {
    generatedAt: string
    networks: GatewayNetwork[]
}

const POLL_MS = 60_000
const ENDPOINT = '/api/dashboard/gateway-status'

async function fetchGatewayStatus(): Promise<GatewayStatusData> {
    const res = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) throw new Error(`Gateway status request failed (${res.status})`)
    const body = (await res.json()) as {
        success?: boolean
        data?: { generatedAt?: unknown; networks?: unknown }
    } | null
    if (!body || body.success !== true || !body.data || !Array.isArray(body.data.networks)) {
        throw new Error('Malformed gateway status response')
    }
    return {
        generatedAt: typeof body.data.generatedAt === 'string' ? body.data.generatedAt : '',
        networks: body.data.networks as GatewayNetwork[],
    }
}

export function useGatewayStatus(): {
    data: GatewayStatusData | null
    isLoading: boolean
    error: Error | null
    refresh: () => Promise<void>
} {
    const { dbUser } = useAuth()
    const userId = dbUser?.id ?? null

    const [data, setData] = useState<GatewayStatusData | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)

    const mountedRef = useRef(true)
    const inFlightRef = useRef(false)
    const dataRef = useRef<GatewayStatusData | null>(null)
    // Bumped when the signed-in user changes; stale results are discarded.
    const genRef = useRef(0)

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const refresh = useCallback(async (): Promise<void> => {
        if (inFlightRef.current) return
        inFlightRef.current = true
        const gen = genRef.current
        try {
            const next = await fetchGatewayStatus()
            if (!mountedRef.current || gen !== genRef.current) return
            dataRef.current = next
            setData(next)
            setError(null)
        } catch (e) {
            if (!mountedRef.current || gen !== genRef.current) return
            // Keep the previous data on a failed poll; only surface the error
            // when there is nothing to show yet.
            if (!dataRef.current) {
                setError(e instanceof Error ? e : new Error('Failed to load delivery status'))
            }
        } finally {
            if (gen === genRef.current) {
                inFlightRef.current = false
                if (mountedRef.current) setIsLoading(false)
            }
        }
    }, [])

    // On user change: drop the previous user's data, invalidate in-flight fetches, reload.
    useEffect(() => {
        genRef.current += 1
        inFlightRef.current = false
        dataRef.current = null
        setData(null)
        setError(null)
        setIsLoading(true)
        if (!userId) return
        void refresh()
    }, [userId, refresh])

    // Poll every 60s only while the tab is visible; refetch when it becomes visible again.
    useEffect(() => {
        if (!userId) return
        let id: ReturnType<typeof setInterval> | null = null
        const stop = () => {
            if (id !== null) {
                clearInterval(id)
                id = null
            }
        }
        const start = () => {
            if (id === null) id = setInterval(() => void refresh(), POLL_MS)
        }
        const onVisibility = () => {
            if (document.hidden) {
                stop()
            } else {
                void refresh()
                start()
            }
        }
        if (!document.hidden) start()
        document.addEventListener('visibilitychange', onVisibility)
        const onAppRefresh = () => void refresh()
        window.addEventListener('app-refresh', onAppRefresh)
        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('app-refresh', onAppRefresh)
        }
    }, [userId, refresh])

    return { data, isLoading, error, refresh }
}
