'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { getTrustedDeviceInfo, clearTrustedDevice, getUserDisplayHint } from '@/lib/pin-crypto'
import { ClayButton, SegmentedControl } from '@/components/ft'
import { Loader2, Smartphone, ShoppingBag, ArrowUpRight } from 'lucide-react'
import { AuthShell } from './_components/auth-shell'
import { AuthAlert } from './_components/shared'
import { PinFirstScreen } from './_components/pin-first-screen'
import { SignInForm } from './_components/sign-in-form'
import { SignUpForm } from './_components/sign-up-form'

// ─── Main auth page ───────────────────────────────────────────────────────────
export default function AuthPage() {
    const searchParams = useSearchParams()
    const tabParam = searchParams.get('tab')
    const oauthError = searchParams.get('error')
    const reason = searchParams.get('reason')

    // A single notice for redirect-driven states so the user always knows WHY
    // they landed here (previously ?reason=session_expired was silently ignored).
    const authNotice: { kind: 'info' | 'error'; text: string } | null =
        reason === 'session_expired'
            ? { kind: 'info', text: 'You were signed out for your security. Please sign in again.' }
        : oauthError === 'access_denied'
            ? { kind: 'error', text: 'Google sign-in was cancelled. Please try again.' }
        : oauthError === 'rate_limited'
            ? { kind: 'error', text: 'Too many attempts from your network. Please wait a moment and try again.' }
        : oauthError === 'email_exists'
            ? { kind: 'error', text: 'This email is already registered. Please sign in with your password below.' }
        : oauthError
            ? { kind: 'error', text: 'Google sign-in failed. Please try again or use email & password.' }
        : null

    const [mode, setMode] = useState<'initializing' | 'pin-first' | 'tabs'>('initializing')
    const [activeTab, setActiveTab] = useState<'signin' | 'signup'>(tabParam === 'signup' ? 'signup' : 'signin')
    const [emailHint, setEmailHint] = useState('')
    const [firstName, setFirstName] = useState('')
    const [googleLoading, setGoogleLoading] = useState(false)

    useEffect(() => {
        const init = async () => {
            const displayHint = getUserDisplayHint()
            const info = getTrustedDeviceInfo()
            if (info) {
                setEmailHint(info.emailHint)
                if (displayHint?.firstName) setFirstName(displayHint.firstName)
                setMode('pin-first')
            } else {
                setMode('tabs')
            }
        }
        init()
    }, [])

    const handleSwitchAccount = useCallback(() => {
        clearTrustedDevice()
        setMode('tabs')
    }, [])

    const handleUsePassword = useCallback(() => {
        setMode('tabs')
        setActiveTab('signin')
    }, [])

    const handleTabChange = (tab: 'signin' | 'signup') => {
        setActiveTab(tab)
        window.history.replaceState(null, '', tab === 'signup' ? '/auth?tab=signup' : '/auth')
    }

    // ── Initialising ──────────────────────────────────────────────────────────
    if (mode === 'initializing') {
        return (
            <div className="relative min-h-screen w-full flex items-center justify-center" role="status" aria-label="Loading">
                <Loader2 className="w-7 h-7 animate-spin text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
            </div>
        )
    }

    // ── PIN-first screen ──────────────────────────────────────────────────────
    if (mode === 'pin-first') {
        return (
            <AuthShell
                showBrandPanel={false}
                title={firstName ? `Hi, ${firstName}` : 'Welcome back'}
                subtitle="Use your PIN to jump straight in."
            >
                <PinFirstScreen
                    emailHint={emailHint}
                    onSwitchAccount={handleSwitchAccount}
                    onUsePassword={handleUsePassword}
                />
            </AuthShell>
        )
    }

    // ── Tab view — desktop split layout ───────────────────────────────────────
    return (
        <AuthShell
            title={activeTab === 'signin' ? 'Welcome back' : 'Create your FameTech account'}
            subtitle={activeTab === 'signin' ? 'Sign in to buy data, airtime and more.' : 'Create your account in about a minute.'}
            footer={
                <div className="mt-4 w-full grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
                    <ClayButton asChild variant="soft" className="px-4 text-sm">
                        <Link href="/download">
                            <Smartphone className="w-4 h-4" aria-hidden="true" />Get the app
                        </Link>
                    </ClayButton>
                    <ClayButton asChild variant="soft" className="px-4 text-sm">
                        <a
                            href="https://fametechgh.com/shop/felix-s-shop"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                            Browse as a guest
                            <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
                        </a>
                    </ClayButton>
                </div>
            }
        >
            <div className="space-y-4">
                {authNotice && (
                    <AuthAlert tone={authNotice.kind === 'info' ? 'info' : 'error'}>{authNotice.text}</AuthAlert>
                )}

                <SegmentedControl
                    ariaLabel="Sign in or create an account"
                    value={activeTab}
                    onChange={handleTabChange}
                    options={[
                        { value: 'signin', label: 'Sign in' },
                        { value: 'signup', label: 'Create account' },
                    ]}
                />

                {activeTab === 'signin' ? (
                    <SignInForm
                        onGoogleLoading={setGoogleLoading}
                        googleLoading={googleLoading}
                    />
                ) : (
                    <SignUpForm
                        onGoogleLoading={setGoogleLoading}
                        googleLoading={googleLoading}
                    />
                )}
            </div>
        </AuthShell>
    )
}
