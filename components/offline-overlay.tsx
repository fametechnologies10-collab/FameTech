'use client'

import { useEffect, useState } from 'react'

export function OfflineOverlay() {
    const [isOffline, setIsOffline] = useState(false)
    const [shopName, setShopName] = useState('KiNG FLEXY GH')

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setIsOffline(!navigator.onLine)

            const updateShopName = () => {
                const path = window.location.pathname
                if (path.includes('/shop/') || path.includes('/shop-domain/')) {
                    const title = document.title
                    if (title && title.includes('|')) {
                        setShopName(title.split('|')[0].trim())
                    } else if (title) {
                        setShopName(title)
                    }
                } else {
                    setShopName('KiNG FLEXY GH')
                }
            }

            updateShopName()

            const handleOnline = () => setIsOffline(false)
            const handleOffline = () => {
                updateShopName()
                setIsOffline(true)
            }

            window.addEventListener('online', handleOnline)
            window.addEventListener('offline', handleOffline)

            // Periodically verify browser online status as fallback
            const interval = setInterval(() => {
                if (!navigator.onLine && !isOffline) {
                    setIsOffline(true)
                }
            }, 3000)

            return () => {
                window.removeEventListener('online', handleOnline)
                window.removeEventListener('offline', handleOffline)
                clearInterval(interval)
            }
        }
    }, [isOffline])

    if (!isOffline) return null

    return (
        <div className="fixed inset-0 z-[99999] bg-[#090D14] flex items-center justify-center p-4 select-none animate-in fade-in duration-300">
            <div className="w-full max-w-[420px] rounded-3xl border border-slate-900 bg-[#0F131C] p-8 sm:p-10 shadow-2xl flex flex-col items-center text-center space-y-6">
                {/* Custom Satellite SVG Dish */}
                <div className="w-20 h-20 rounded-full bg-slate-900/50 flex items-center justify-center border border-slate-800">
                    <svg className="w-10 h-10 text-violet-500 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
                        <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
                        <circle cx="12" cy="12" r="2" />
                        <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
                        <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
                    </svg>
                </div>

                <div className="space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.25em] text-violet-500 block">
                        {shopName}
                    </span>
                    <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                        You&apos;re Offline
                    </h1>
                </div>

                <p className="text-sm text-slate-450 leading-relaxed font-medium">
                    No internet connection detected. Check your data or Wi-Fi and try again — your session is still safe.
                </p>

                <button
                    onClick={() => window.location.reload()}
                    className="w-full h-12 rounded-full bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm tracking-wide shadow-lg shadow-violet-500/20 active:scale-95 transition-all focus:outline-none"
                >
                    Try Again
                </button>

                <p className="text-[11px] text-slate-600 font-semibold leading-normal pt-2">
                    Your wallet balance and order history will load once you&apos;re back online.
                </p>
            </div>
        </div>
    )
}
