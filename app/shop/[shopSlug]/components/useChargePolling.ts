'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

const PATIENT_POLLS = 6
// 'received' = payment confirmed but the product is NOT yet delivered (backorder, a
// transient fulfilment error the webhook will fix, or missing metadata). It is NON-terminal:
// we surface a "payment received, delivery pending" screen but keep polling, so if fulfilment
// completes moments later the outcome upgrades to 'paid'. Critically, 'received' must NOT fire
// onPaid — RC uses onPaid to REVEAL vouchers, which do not exist until truly fulfilled.
type Outcome = 'paid' | 'received' | 'pending' | 'terminal'

async function fetchWithTimeout(input: string, timeoutMs = 20_000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try { return await fetch(input, { signal: controller.signal, headers: { Accept: 'application/json' } }) }
    finally { clearTimeout(timer) }
}

export function useChargePolling(
    onPaid: () => void,
    onTerminal: () => void,
    statusUrl: string = '/api/shop/charge/status',
    onReceived?: () => void,
) {
    const [pollCount, setPollCount] = useState(0)
    const [checking, setChecking] = useState(false)
    const timerRef = useRef<NodeJS.Timeout | null>(null)
    const busyRef = useRef(false)

    const stop = useCallback(() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }, [])
    useEffect(() => () => stop(), [stop])

    // Fire the terminal callback (onPaid/onTerminal) at most once per charge attempt —
    // the background poll and a manual "I've paid" tap can otherwise both resolve and
    // double-invoke it. Reset per attempt in start().
    const settledRef = useRef(false)
    const settle = useCallback((cb: () => void) => {
        if (settledRef.current) return
        settledRef.current = true
        stop()
        cb()
    }, [stop])

    // 'received' is non-terminal: notify the UI once (so it shows the "delivery pending"
    // screen) but DO NOT stop polling — fulfilment may still complete and upgrade to 'paid'.
    const receivedRef = useRef(false)
    const markReceived = useCallback(() => {
        if (receivedRef.current) return
        receivedRef.current = true
        onReceived?.()
    }, [onReceived])

    const check = useCallback(async (ref: string): Promise<Outcome> => {
        try {
            const res = await fetchWithTimeout(`${statusUrl}?ref=${encodeURIComponent(ref)}`)
            const data = await res.json()
            // paid + explicitly-not-fulfilled → received (keep polling, never reveal).
            // A missing `fulfilled` field means the route does not distinguish (data/airtime) →
            // treat paid as success, preserving existing behaviour.
            if (data.paid && data.fulfilled === false) return 'received'
            if (data.paid) return 'paid'
            if (data.terminal) return 'terminal'
            return 'pending'
        } catch { return 'pending' }
    }, [statusUrl])

    const start = useCallback((ref: string) => {
        settledRef.current = false
        receivedRef.current = false
        setPollCount(0)
        const poll = async (count: number) => {
            const outcome = await check(ref)
            if (outcome === 'paid') { settle(onPaid); return }
            if (outcome === 'terminal') { settle(onTerminal); return }
            if (outcome === 'received') markReceived()   // show "delivery pending", keep polling
            setPollCount(count + 1)
            timerRef.current = setTimeout(() => poll(count + 1), count < PATIENT_POLLS ? 6_000 : 12_000)
        }
        timerRef.current = setTimeout(() => poll(0), 6_000)
    }, [check, onPaid, onTerminal, settle, markReceived])

    const iHavePaid = useCallback(async (ref: string): Promise<Outcome> => {
        if (busyRef.current) return 'pending'
        busyRef.current = true; setChecking(true)
        const outcome = await check(ref)
        if (outcome === 'paid') settle(onPaid)
        else if (outcome === 'terminal') settle(onTerminal)
        else if (outcome === 'received') markReceived()
        busyRef.current = false; setChecking(false)
        return outcome
    }, [check, onPaid, onTerminal, settle, markReceived])

    return { start, stop, iHavePaid, pollCount, checking, PATIENT_POLLS }
}
