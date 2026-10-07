'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { PinLockScreen } from '@/components/pin-lock-screen'
import { useRouter, usePathname } from 'next/navigation'
import { saveTrustedDevice } from '@/lib/pin-crypto'

interface PinContextType {
    isPinVerified: boolean
    isPinEnabled: boolean
    isPinSet: boolean
    showPinSetup: (password?: string) => void
}

const PinContext = createContext<PinContextType>({
    isPinVerified: false,
    isPinEnabled: false,
    isPinSet: false,
    showPinSetup: () => {},
})

const PIN_SESSION_DURATION = 4 * 60 * 60 * 1000

const PIN_EXCLUDED_PATHS = [
    '/auth',
    '/shop/',
    '/shop-domain/',
    '/download',
    '/terms',
    '/api/',
    '/',
]

function isExcludedPath(pathname: string): boolean {
    if (pathname === '/') return true
    return PIN_EXCLUDED_PATHS.some(p => p !== '/' && pathname.startsWith(p))
}

export function PinProvider({ children }: { children: ReactNode }) {
    const { user, dbUser, isLoading, getPendingCredentials, clearPendingCredentials } = useAuth()
    const router = useRouter()
    const pathname = usePathname()

    const [pinStatus, setPinStatus] = useState<'loading' | 'none' | 'locked' | 'verified'>('loading')
    const [hasCheckedPin, setHasCheckedPin] = useState(false)
    const [serverHasPin, setServerHasPin] = useState(false)

    // Check PIN status when user / pathname changes
    useEffect(() => {
        if (isLoading || !user) {
            setPinStatus('loading')
            setHasCheckedPin(false)
            return
        }

        if (isExcludedPath(pathname)) {
            setPinStatus('verified')
            setHasCheckedPin(true)
            return
        }

        // Honor recently-verified PIN session
        try {
            const verified = localStorage.getItem('kfg_pin_verified')
            const verifiedAt = localStorage.getItem('kfg_pin_verified_at')
            if (verified === 'true' && verifiedAt) {
                const elapsed = Date.now() - parseInt(verifiedAt, 10)
                if (elapsed < PIN_SESSION_DURATION) {
                    setPinStatus('verified')
                    setHasCheckedPin(true)
                    // Pick up "just-set" flag so isPinSet stays accurate
                    try {
                        const justSet = sessionStorage.getItem('kfg_pin_just_set')
                        if (justSet) { sessionStorage.removeItem('kfg_pin_just_set'); setServerHasPin(true) }
                    } catch {}
                    return
                }
            }
        } catch {}

        const checkPinStatus = async () => {
            try {
                const res = await fetch('/api/auth/pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'status' }),
                })
                if (!res.ok) { setPinStatus('verified'); setHasCheckedPin(true); return }
                const data = await res.json()
                if (data.hasPin) {
                    setServerHasPin(true)
                    setPinStatus('locked')
                } else {
                    setServerHasPin(false)
                    setPinStatus('verified')
                }
            } catch {
                setPinStatus('verified')
            }
            setHasCheckedPin(true)
        }

        checkPinStatus()
    }, [user, isLoading, pathname])

    const handlePinVerified = useCallback(async (pin: string) => {
        // Silently upgrade: if pending login credentials exist, save trusted device
        const creds = getPendingCredentials()
        if (creds) {
            try {
                const existing = localStorage.getItem('kfg_trusted_device_v2')
                if (!existing) await saveTrustedDevice(creds.email, creds.password, pin)
            } catch {
                console.warn('[PinContext] Failed silent upgrade of trusted device')
            }
            clearPendingCredentials()
        }
        setPinStatus('verified')
    }, [getPendingCredentials, clearPendingCredentials])

    // Called by the lock screen after a successful password-verified recovery
    // (the user either set a NEW PIN or disabled it). Unlocks in place — no more
    // bouncing to /auth/login, which middleware only redirected back to /dashboard,
    // creating the permanent lock loop.
    const handleRecovered = useCallback((pinStillSet: boolean) => {
        setServerHasPin(pinStillSet)
        try {
            localStorage.setItem('kfg_pin_verified', 'true')
            localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
        } catch {}
        setPinStatus('verified')
    }, [])

    // Navigate to the dedicated PIN setup page (stores password for trusted device saving)
    const showPinSetup = useCallback((password?: string) => {
        if (password) {
            try { sessionStorage.setItem('kfg_setup_pw', password) } catch {}
        }
        const safeNext = !isExcludedPath(pathname) ? pathname : '/dashboard'
        router.push(`/auth/setup-pin?next=${encodeURIComponent(safeNext)}`)
    }, [router, pathname])

    if (isLoading || !hasCheckedPin || isExcludedPath(pathname)) {
        return (
            <PinContext.Provider value={{ isPinVerified: true, isPinEnabled: false, isPinSet: serverHasPin, showPinSetup }}>
                {children}
            </PinContext.Provider>
        )
    }

    if (!user) {
        return (
            <PinContext.Provider value={{ isPinVerified: true, isPinEnabled: false, isPinSet: false, showPinSetup }}>
                {children}
            </PinContext.Provider>
        )
    }

    // Show PIN Lock Screen (session expired mid-use)
    if (pinStatus === 'locked') {
        return (
            <PinContext.Provider value={{ isPinVerified: false, isPinEnabled: true, isPinSet: true, showPinSetup }}>
                <PinLockScreen
                    userName={dbUser?.first_name || undefined}
                    email={dbUser?.email || undefined}
                    onVerified={handlePinVerified}
                    onRecovered={handleRecovered}
                />
            </PinContext.Provider>
        )
    }

    // Verified — normal content
    return (
        <PinContext.Provider value={{ isPinVerified: true, isPinEnabled: serverHasPin, isPinSet: serverHasPin, showPinSetup }}>
            {children}
        </PinContext.Provider>
    )
}

export function usePin() {
    return useContext(PinContext)
}
