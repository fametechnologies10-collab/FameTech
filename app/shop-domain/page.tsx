'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { BrandLogo } from '@/components/ui/brand'
import { TermsSectionsLive } from '@/components/terms/terms-sections-live'
import {
    Search,
    Loader2,
    Zap,
    Lock,
    Clock,
    ShieldCheck,
    AlertTriangle,
    CheckCircle2,
    PhoneCall,
    Ban,
    Info,
} from 'lucide-react'

interface ShopSearchResult {
    shop_slug: string
    shop_name: string
    description: string | null
    logo_url: string | null
    owner_phone: string
}

// How many failed searches before the user is locked out
const MAX_ATTEMPTS = 5
// Cooldown between individual searches (seconds)
const SEARCH_COOLDOWN_SEC = 10
// Lock-out duration after MAX_ATTEMPTS reached (seconds)
const LOCKOUT_DURATION_SEC = 120

export default function ShopDomainDiscoveryPage() {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<ShopSearchResult[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [hasSearched, setHasSearched] = useState(false)
    const [error, setError] = useState(false)

    // Rate-limiting state
    const [cooldownSec, setCooldownSec] = useState(0)       // seconds remaining on per-search cooldown
    const [attempts, setAttempts] = useState(0)             // consecutive failed/empty searches
    const [lockoutSec, setLockoutSec] = useState(0)         // seconds remaining on lockout
    const [adminContact, setAdminContact] = useState<string | null>(null) // fetched after lockout

    const [termsExpanded, setTermsExpanded] = useState(false)
    const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null)
    const lockoutTimer = useRef<ReturnType<typeof setInterval> | null>(null)

    const isLockedOut = lockoutSec > 0
    const isCooling = cooldownSec > 0

    // Fetch admin support contact once when locked out
    useEffect(() => {
        if (isLockedOut && !adminContact) {
            fetch('/api/admin-settings?keys=guest_storefront_url')
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                    if (d?.guest_storefront_url) {
                        setAdminContact(d.guest_storefront_url)
                    }
                })
                .catch(() => null)
        }
    }, [isLockedOut, adminContact])

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            if (cooldownTimer.current) clearInterval(cooldownTimer.current)
            if (lockoutTimer.current) clearInterval(lockoutTimer.current)
        }
    }, [])

    const startCooldown = () => {
        setCooldownSec(SEARCH_COOLDOWN_SEC)
        if (cooldownTimer.current) clearInterval(cooldownTimer.current)
        cooldownTimer.current = setInterval(() => {
            setCooldownSec(prev => {
                if (prev <= 1) {
                    clearInterval(cooldownTimer.current!)
                    return 0
                }
                return prev - 1
            })
        }, 1000)
    }

    const startLockout = () => {
        setLockoutSec(LOCKOUT_DURATION_SEC)
        if (lockoutTimer.current) clearInterval(lockoutTimer.current)
        lockoutTimer.current = setInterval(() => {
            setLockoutSec(prev => {
                if (prev <= 1) {
                    clearInterval(lockoutTimer.current!)
                    setAttempts(0)
                    return 0
                }
                return prev - 1
            })
        }, 1000)
    }

    const performSearch = async () => {
        const trimmed = query.trim()
        if (trimmed.length < 2) return

        setIsLoading(true)
        setError(false)
        setHasSearched(true)
        setResults([])

        try {
            const res = await fetch(`/api/shop-domain/search?q=${encodeURIComponent(trimmed)}`)
            if (!res.ok) throw new Error('Search failed')
            const data: ShopSearchResult[] = await res.json()
            setResults(data || [])

            if (!data || data.length === 0) {
                // Count this as a failed attempt
                const newAttempts = attempts + 1
                setAttempts(newAttempts)
                if (newAttempts >= MAX_ATTEMPTS) {
                    startLockout()
                } else {
                    startCooldown()
                }
            } else {
                // Successful match — reset attempts, still apply cooldown
                setAttempts(0)
                startCooldown()
            }
        } catch (err) {
            console.error(err)
            setError(true)
            const newAttempts = attempts + 1
            setAttempts(newAttempts)
            if (newAttempts >= MAX_ATTEMPTS) {
                startLockout()
            } else {
                startCooldown()
            }
        } finally {
            setIsLoading(false)
        }
    }

    const handleSearch = () => {
        if (!query.trim() || query.trim().length < 2) return
        if (isLockedOut || isCooling || isLoading) return
        performSearch()
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            handleSearch()
        }
    }

    const attemptsLeft = MAX_ATTEMPTS - attempts

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col font-sans transition-colors duration-300">

            {/* ── Header/Hero ── */}
            <header className="w-full bg-[#0a1628] pt-12 pb-10 px-4 text-center border-b border-gray-800">
                <div className="max-w-4xl mx-auto flex flex-col items-center">
                    <div className="w-28 h-28 rounded-full overflow-hidden mb-6 flex items-center justify-center">
                        <BrandLogo width={112} height={112} priority />
                    </div>
                    <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-wide mb-3 uppercase text-white">
                        Welcome to <span>KiNG</span> <span className="text-[#FFCC00]">FLEXY GH</span> Stores
                    </h1>
                    <p className="text-sm sm:text-base text-gray-300 font-medium mb-1">
                        Powering Digital Services in Ghana
                    </p>
                    <p className="text-xs text-gray-500 tracking-widest uppercase font-bold">
                        By KiNG <span className="text-[#FFCC00]">FLEXY GH</span> Technologies
                    </p>
                </div>
            </header>

            <div className="w-full h-1 bg-gradient-to-r from-transparent via-[#0056B3]/30 to-transparent opacity-50" />

            {/* ── Search Area ── */}
            <section className="w-full bg-white dark:bg-slate-900 py-12 px-4 shadow-sm border-b border-gray-100 dark:border-slate-800 transition-colors">
                <div className="max-w-2xl mx-auto">
                    <div className="text-center mb-8">
                        <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white tracking-wide uppercase mb-2">
                            Find Your Favorite Shop
                        </h2>
                        <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">
                            Search by shop name, shop link, owner 10-digit contact number, or 4-digit shop code
                        </p>
                    </div>

                    {/* Search hint */}
                    <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50 rounded-xl flex items-start gap-2">
                        <Info className="w-4 h-4 text-blue-500 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-blue-700 dark:text-blue-300 font-medium leading-relaxed">
                            <strong>Exact match required.</strong> Enter the complete shop name, the full shop link, the owner&apos;s full 10-digit phone number e.g. 024XXXXXXX, or the shop&apos;s 4-digit code. Partial entries will not return results.
                        </p>
                    </div>

                    {/* USSD shop-code note */}
                    <p className="text-xs text-gray-400 dark:text-slate-500 font-medium text-center mb-5">
                        Know your shop&apos;s 4-digit USSD code (e.g. from *713*9939#)? Enter it above to go straight to that shop.
                    </p>

                    {/* Locked-out state */}
                    {isLockedOut ? (
                        <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-6 text-center space-y-4">
                            <div className="flex justify-center">
                                <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center">
                                    <Ban className="w-7 h-7 text-red-500" />
                                </div>
                            </div>
                            <h3 className="text-lg font-black text-red-700">Search Temporarily Locked</h3>
                            <p className="text-sm text-red-600 dark:text-red-400 font-medium leading-relaxed">
                                You have made {MAX_ATTEMPTS} unsuccessful searches in a short period. To protect our platform
                                from abuse, further searches are paused for{' '}
                                <span className="font-black text-red-800 dark:text-red-200 tabular-nums">{lockoutSec}s</span>.
                            </p>

                            {/* Admin contact fallback */}
                            <div className="mt-4 p-4 bg-white dark:bg-slate-900 rounded-xl border border-red-100 dark:border-red-900/30 space-y-2">
                                <p className="text-xs font-bold text-gray-600 dark:text-slate-400 uppercase tracking-wider">
                                    Can&apos;t find the shop you&apos;re looking for?
                                </p>
                                <p className="text-sm text-gray-500 dark:text-slate-300 font-medium">
                                    Visit our official guest storefront directly instead.
                                </p>
                                {adminContact ? (
                                    <a
                                        href={adminContact}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-2 mt-2 px-5 py-2.5 bg-[#0056B3] text-white rounded-xl font-bold text-sm hover:opacity-90 transition-opacity"
                                    >
                                        Visit Official Storefront →
                                    </a>
                                ) : (
                                    <a
                                        href="https://kingflexygh.com"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-2 mt-2 px-5 py-2.5 bg-[#0056B3] text-white rounded-xl font-bold text-sm hover:opacity-90 transition-opacity"
                                    >
                                        Visit Main Platform →
                                    </a>
                                )}
                            </div>

                            <p className="text-xs text-gray-400 font-medium">
                                Search will unlock automatically in {lockoutSec} second{lockoutSec !== 1 ? 's' : ''}.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="relative flex flex-col md:flex-row gap-4 mb-4">
                                <input
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    disabled={isCooling || isLoading}
                                    className="flex-1 w-full px-5 py-4 bg-gray-50 dark:bg-slate-800 border-2 border-gray-200 dark:border-slate-700 rounded-2xl text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-4 focus:ring-[#0056B3]/20 focus:border-[#0056B3] transition-all font-semibold text-base sm:text-lg disabled:opacity-60 disabled:cursor-not-allowed"
                                    placeholder="Shop name, shop link, 10-digit phone, or 4-digit code..."
                                    autoComplete="off"
                                />
                                <button
                                    onClick={handleSearch}
                                    disabled={isLoading || isCooling}
                                    className="w-full md:w-auto px-8 py-4 bg-[#0056B3] hover:bg-[#004494] active:bg-[#003875] text-white rounded-2xl font-bold text-base transition-colors flex items-center justify-center gap-2 shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isLoading ? (
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                    ) : (
                                        <Search className="w-5 h-5" />
                                    )}
                                    <span>{isCooling ? `Wait ${cooldownSec}s` : 'Search Shops'}</span>
                                </button>
                            </div>

                            {/* Cooldown / attempts warning */}
                            {(isCooling || (attempts > 0 && !isLockedOut)) && (
                                <div className={`mb-4 p-3 rounded-xl border text-sm font-medium flex items-center gap-2 transition-all ${isCooling ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400' : 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400'}`}>
                                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                                    <span>
                                        {isCooling
                                            ? `Please wait ${cooldownSec} second${cooldownSec !== 1 ? 's' : ''} before searching again.`
                                            : null
                                        }
                                        {attempts > 0 && !isLockedOut && !isCooling
                                            ? `${attemptsLeft} search attempt${attemptsLeft !== 1 ? 's' : ''} remaining before temporary lockout.`
                                            : null
                                        }
                                        {isCooling && attempts > 0
                                            ? ` (${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} remaining)`
                                            : null
                                        }
                                    </span>
                                </div>
                            )}

                            {/* Search Results */}
                            <div className="mt-8">
                                {!hasSearched && !isLoading && (
                                    <div className="py-8 text-center text-gray-400 dark:text-slate-500 font-medium text-sm">
                                        Enter your search details above and click Search.
                                    </div>
                                )}

                                {error && (
                                    <div className="p-6 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400 rounded-2xl border border-red-100 dark:border-red-900/30 text-center font-medium">
                                        Something went wrong — please try again
                                    </div>
                                )}

                                {!isLoading && !error && hasSearched && results.length === 0 && (
                                    <div className="py-10 text-center space-y-2 border-2 border-dashed border-gray-200 dark:border-slate-800 rounded-3xl bg-gray-50 dark:bg-slate-900/50">
                                        <p className="text-gray-600 dark:text-slate-300 font-bold">No shops found</p>
                                        <p className="text-sm text-gray-400 dark:text-slate-500 font-medium max-w-xs mx-auto">
                                            Make sure you&apos;ve entered the <strong>complete</strong> shop name, link, 10-digit phone number, or 4-digit shop code.
                                        </p>
                                    </div>
                                )}

                                {results.length > 0 && !isLoading && (
                                    <div className="transition-opacity duration-500 opacity-100 starting:opacity-0">
                                        <p className="text-sm font-bold text-gray-400 dark:text-slate-500 mb-4 px-1 uppercase tracking-wider">
                                            {results.length} shop{results.length !== 1 ? 's' : ''} found
                                        </p>
                                        <div className="grid gap-4">
                                            {results.map((shop) => (
                                                <div key={shop.shop_slug} className="flex flex-col sm:flex-row sm:items-center gap-4 p-5 bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-800 shadow-sm hover:border-[#0056B3] hover:shadow-md transition-all group">
                                                    <div className="flex-shrink-0 flex items-center gap-4 sm:gap-0">
                                                        {shop.logo_url ? (
                                                            <div className="w-20 h-20 relative rounded-full overflow-hidden">
                                                                <Image src={shop.logo_url} alt={shop.shop_name} fill className="object-cover" sizes="80px" />
                                                            </div>
                                                        ) : (
                                                            <div className="w-20 h-20 rounded-full bg-[#0056B3]/10 dark:bg-[#0056B3]/20 flex items-center justify-center text-[#0056B3] dark:text-[#4da6ff] text-3xl font-black border border-[#0056B3]/20 dark:border-[#0056B3]/40">
                                                                {shop.shop_name.charAt(0).toUpperCase()}
                                                            </div>
                                                        )}
                                                        <div className="sm:hidden flex-1">
                                                            <h3 className="text-lg font-bold text-gray-900 dark:text-white capitalize">{shop.shop_name}</h3>
                                                        </div>
                                                    </div>

                                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                        <h3 className="hidden sm:block text-lg font-bold text-gray-900 dark:text-white capitalize truncate group-hover:text-[#0056B3] dark:group-hover:text-[#4da6ff] transition-colors">{shop.shop_name}</h3>
                                                        {shop.description && (
                                                            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1 line-clamp-2">
                                                                {shop.description.length > 80 ? `${shop.description.substring(0, 80)}...` : shop.description}
                                                            </p>
                                                        )}
                                                    </div>

                                                    <div className="flex-shrink-0 mt-2 sm:mt-0">
                                                        <Link
                                                            href={`/${shop.shop_slug}`}
                                                            className="inline-flex items-center justify-center w-full sm:w-auto px-6 py-2.5 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-[#0056B3] dark:text-[#4da6ff] font-bold text-sm rounded-xl transition-colors group-hover:bg-[#0056B3] group-hover:text-white"
                                                        >
                                                            View Shop →
                                                        </Link>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </section>

            {/* ── Features Strip ── */}
            <section className="w-full bg-gray-50 dark:bg-slate-950 py-16 px-4 border-b border-gray-200 dark:border-slate-800 transition-colors">
                <div className="max-w-5xl mx-auto">
                    <div className="grid md:grid-cols-3 gap-6">
                        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 flex flex-col items-center text-center hover:-translate-y-1 transition-transform">
                            <div className="w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-900/30 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center mb-4">
                                <Zap className="w-6 h-6" />
                            </div>
                            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Ultra Fast Delivery</h3>
                            <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">Data bundles delivered in seconds after payment</p>
                        </div>

                        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 flex flex-col items-center text-center hover:-translate-y-1 transition-transform">
                            <div className="w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-900/30 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center mb-4">
                                <Lock className="w-6 h-6" />
                            </div>
                            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Secure Payments</h3>
                            <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">Pay safely via Paystack — Ghana&apos;s trusted payment platform</p>
                        </div>

                        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 flex flex-col items-center text-center hover:-translate-y-1 transition-transform">
                            <div className="w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-900/30 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center mb-4">
                                <Clock className="w-6 h-6" />
                            </div>
                            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Always Available</h3>
                            <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">Shop anytime, 24 hours a day, 7 days a week</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── Terms and Conditions ── */}
            <section className="w-full bg-white dark:bg-slate-900 py-16 px-4 flex-1 transition-colors">
                <div className="max-w-3xl mx-auto">
                    <div className="text-center mb-8">
                        <h2 id="terms" className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Terms &amp; Conditions</h2>
                        <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">Please read before making any purchase</p>
                    </div>

                    <div className="bg-gray-50 dark:bg-slate-950 rounded-2xl border border-gray-200 dark:border-slate-800 overflow-hidden">
                        <button
                            onClick={() => setTermsExpanded(!termsExpanded)}
                            className="w-full flex items-center justify-between p-5 bg-white dark:bg-slate-900 text-gray-900 dark:text-white font-bold hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors focus:outline-none"
                        >
                            <span className="text-sm sm:text-base">{termsExpanded ? 'Hide Terms ▲' : 'Read Terms & Conditions ▼'}</span>
                        </button>

                        <div className={`transition-all duration-300 ease-in-out overflow-hidden ${termsExpanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}`}>
                            <div className="p-6 sm:p-8 border-t border-gray-200 dark:border-slate-800">
                                <TermsSectionsLive className="space-y-6" />
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── Footer ── */}
            <footer className="w-full bg-[#0a1628] py-12 px-4 text-center border-t border-gray-800">
                <div className="max-w-4xl mx-auto flex flex-col items-center">
                    <div className="w-12 h-12 rounded-full overflow-hidden mb-4 flex items-center justify-center">
                        <BrandLogo width={48} height={48} />
                    </div>
                    <p className="text-sm text-gray-400 font-medium mb-4">
                        © 2026 KiNG FLEXY TECHNOLOGIES LTD. All rights reserved.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mb-6">
                        <a href="#terms" className="text-sm text-gray-300 hover:text-white transition-colors font-medium">
                            Terms &amp; Conditions
                        </a>
                    </div>
                    <p className="text-xs text-gray-600 font-medium max-w-sm mx-auto">
                        This is an official KiNG <span className="text-[#FFCC00]">FLEXY GH</span> storefront directory
                    </p>
                </div>
            </footer>
        </div>
    )
}
