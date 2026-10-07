'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
    ArrowLeft,
    CheckCircle2,
    Clock,
    Copy,
    Download,
    Eye,
    EyeOff,
    GraduationCap,
    Loader2,
    Mail,
    MessageCircle,
    Phone,
    Search,
    ShieldCheck,
} from 'lucide-react'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { downloadResultsCheckerVouchers, type ResultsCheckerVoucher } from '@/lib/results-checker-utils'
import { cn, formatCurrency } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { CopyrightFooter } from '@/components/CopyrightFooter'

interface ShopRetrieveProps {
    shop: {
        shop_name: string
        shop_slug: string
        logo_url: string | null
        owner_phone: string
        owner_email: string | null
        whatsapp_number: string | null
        brand_color: string
    }
}

interface RetrievedOrder {
    id: string
    reference_code: string
    type_name: string
    quantity: number
    total_paid: number
    status: string
    payment_status: string
    created_at: string
    customer_phone: string | null
    customer_email: string | null
    inventory_ids: string[]
}

interface RetrievedPayload {
    order: RetrievedOrder
    vouchers: ResultsCheckerVoucher[]
}

function CopyAction({ value, label }: { value: string; label: string }) {
    const [copied, setCopied] = useState(false)

    return (
        <button
            onClick={() => {
                navigator.clipboard.writeText(value)
                setCopied(true)
                toast.success(`${label} copied`)
                window.setTimeout(() => setCopied(false), 1500)
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
            title={`Copy ${label}`}
        >
            {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </button>
    )
}

export default function ResultsCheckerRetrieveClient({ shop }: ShopRetrieveProps) {
    const searchParams = useSearchParams()
    const initialReference = searchParams.get('reference') || ''
    const [reference, setReference] = useState(initialReference)
    const [phone, setPhone] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [result, setResult] = useState<RetrievedPayload | null>(null)
    const [revealedPins, setRevealedPins] = useState<Set<string>>(new Set())
    const [isStorefront, setIsStorefront] = useState(false)
    const [canAutoLookup, setCanAutoLookup] = useState(false)
    const autoTriggered = useRef(false)
    const headerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (headerRef.current) {
            headerRef.current.style.setProperty('--brand-color', shop.brand_color || '#0f172a')
        }
    }, [shop.brand_color])

    // White-label toast notifications with the shop's own name on this storefront page.
    useEffect(() => {
        toast.setBrand(shop.shop_name)
        return () => toast.setBrand(null)
    }, [shop.shop_name])

    useEffect(() => {
        const hostname = window.location.hostname
        const isSubdomain = hostname.startsWith('shop.')
            || (hostname !== 'kingflexygh.com' && hostname !== 'www.kingflexygh.com' && !hostname.includes('localhost'))
        setIsStorefront(isSubdomain)

        try {
            const savedPhone = localStorage.getItem('shop_last_phone')
            if (savedPhone) {
                setPhone(savedPhone)
                setCanAutoLookup(true)
            }
        } catch {}
    }, [])

    const baseLinkPath = isStorefront ? '' : '/shop'
    const storefrontHref = `${baseLinkPath}/${shop.shop_slug}`
    const trackerHref = `${baseLinkPath}/status?shop=${shop.shop_slug}&name=${encodeURIComponent(shop.shop_name)}`

    const runRetrieve = async (nextReference: string, nextPhone: string) => {
        setLoading(true)
        setError(null)

        try {
            const res = await fetch('/api/results-checker/retrieve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reference: nextReference.trim(),
                    phone: nextPhone.trim(),
                }),
            })
            const data = await res.json()

            if (!res.ok) {
                setResult(null)
                setError(data.error || 'Unable to retrieve voucher details right now.')
                return
            }

            setResult(data)
            try {
                localStorage.setItem('shop_last_phone', nextPhone.trim())
            } catch {}
        } catch {
            setResult(null)
            setError('Network error while retrieving voucher details.')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (!initialReference || !phone || !canAutoLookup || autoTriggered.current) {
            return
        }

        autoTriggered.current = true
        void runRetrieve(initialReference, phone)
    }, [canAutoLookup, initialReference, phone])

    return (
        <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] dark:bg-[linear-gradient(180deg,#030712_0%,#111827_100%)]">
            <div
                ref={headerRef}
                className="border-b border-black/5 px-4 py-4 shadow-sm dark:border-white/10 bg-[var(--brand-color)]"
            >
                <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
                    <Link href={storefrontHref} className="inline-flex items-center gap-2 text-sm font-medium text-white/90">
                        <ArrowLeft className="h-4 w-4" />
                        Back to Store
                    </Link>
                    <div className="flex items-center gap-3 text-white">
                        {shop.logo_url ? (
                            <div className="relative h-10 w-10 overflow-hidden rounded-xl bg-white/15">
                                <Image src={shop.logo_url} alt={shop.shop_name} fill className="object-contain" />
                            </div>
                        ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
                                <GraduationCap className="h-5 w-5" />
                            </div>
                        )}
                        <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{shop.shop_name}</p>
                            <p className="text-xs text-white/80">Secure voucher retrieval</p>
                        </div>
                    </div>
                    <ThemeToggle brandName={shop.shop_name} />
                </div>
            </div>

            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:py-8">
                <section className="rounded-[28px] border border-white/70 bg-white/90 p-5 shadow-xl shadow-slate-200/60 backdrop-blur dark:border-white/10 dark:bg-slate-950/85 dark:shadow-black/20">
                    <div className="flex items-start justify-between gap-4">
                        <div className="space-y-2">
                            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                Verified retrieval
                            </div>
                            <h1 className="text-2xl font-black tracking-tight text-slate-950 dark:text-white leading-tight">
                                Retrieve Results Checker Vouchers
                            </h1>
                            <p className="max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                                Enter the reference code and buyer phone number used during checkout to view, reveal, and download completed vouchers again.
                            </p>
                        </div>
                    </div>

                    <form
                        onSubmit={(event) => {
                            event.preventDefault()
                            void runRetrieve(reference, phone)
                        }}
                        className="mt-6 grid gap-4 sm:grid-cols-[1fr_1fr_auto]"
                    >
                        <label className="space-y-2">
                            <span className="text-xs font-medium text-slate-500 dark:text-slate-300">Reference code</span>
                            <input
                                value={reference}
                                onChange={(event) => setReference(event.target.value)}
                                placeholder="RC-XXXXXXXX"
                                className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-900 outline-none transition focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                            />
                        </label>
                        <label className="space-y-2">
                            <span className="text-xs font-medium text-slate-500 dark:text-slate-300">Buyer phone number</span>
                            <input
                                value={phone}
                                onChange={(event) => setPhone(event.target.value)}
                                placeholder="0244123456"
                                className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-900 outline-none transition focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                            />
                        </label>
                        <button
                            type="submit"
                            disabled={loading || !reference.trim() || !phone.trim()}
                            className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-300 dark:text-slate-950 dark:hover:bg-emerald-200"
                        >
                            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                            Retrieve
                        </button>
                    </form>

                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                        <span className="inline-flex items-center gap-1.5">
                            <Clock className="h-3.5 w-3.5" />
                            Rate limited for security
                        </span>
                        <Link href={trackerHref} className="font-medium text-emerald-700 hover:underline dark:text-emerald-300">
                            Track other shop orders
                        </Link>
                    </div>
                </section>

                {error && (
                    <section className="rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-100">
                        {error}
                    </section>
                )}

                {result && (
                    <section className="rounded-[28px] border border-white/70 bg-white/95 p-5 shadow-xl shadow-slate-200/60 dark:border-white/10 dark:bg-slate-950/90 dark:shadow-black/20">
                        <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 dark:border-slate-800">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                                        {result.order.reference_code}
                                    </p>
                                    <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-white">
                                        {result.order.quantity}x {result.order.type_name}
                                    </h2>
                                </div>
                                <span className={cn(
                                    'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold',
                                    result.order.status === 'completed'
                                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200'
                                        : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200'
                                )}>
                                    {result.order.status === 'completed' ? 'Completed' : 'Processing'}
                                </span>
                            </div>
                            <div className="grid gap-3 text-sm sm:grid-cols-3">
                                <div className="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900">
                                    <p className="text-xs text-slate-500 dark:text-slate-400">Total paid</p>
                                    <p className="mt-1 font-semibold text-slate-900 dark:text-white">{formatCurrency(result.order.total_paid)}</p>
                                </div>
                                <div className="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900">
                                    <p className="text-xs text-slate-500 dark:text-slate-400">Buyer phone</p>
                                    <p className="mt-1 font-semibold text-slate-900 dark:text-white">{result.order.customer_phone || 'N/A'}</p>
                                </div>
                                <div className="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900">
                                    <p className="text-xs text-slate-500 dark:text-slate-400">Delivery email</p>
                                    <p className="mt-1 truncate font-semibold text-slate-900 dark:text-white">{result.order.customer_email || 'N/A'}</p>
                                </div>
                            </div>
                        </div>

                        {result.order.status === 'completed' && result.vouchers.length > 0 ? (
                            <div className="mt-5 space-y-4">
                                <div className="flex items-center justify-between gap-4">
                                    <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                                        Tap any PIN to reveal it, copy the details, or download the full receipt.
                                    </p>
                                    <button
                                        onClick={() => downloadResultsCheckerVouchers(
                                            result.order,
                                            result.vouchers,
                                            result.order.customer_phone || '',
                                            result.order.customer_email || '',
                                            shop.shop_name
                                        )}
                                        className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 dark:bg-emerald-300 dark:text-slate-950 dark:hover:bg-emerald-200"
                                    >
                                        <Download className="h-4 w-4" />
                                        Download
                                    </button>
                                </div>

                                <div className="grid gap-3">
                                    {result.vouchers.map((voucher, index) => {
                                        const pinKey = `${voucher.serial_number}-${index}`
                                        const isRevealed = revealedPins.has(pinKey)

                                        return (
                                            <div key={pinKey} className="rounded-[24px] border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div>
                                                        <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                                                            Voucher {index + 1}
                                                        </p>
                                                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Serial number</p>
                                                        <p className="font-mono text-sm font-semibold text-slate-900 dark:text-white">
                                                            {voucher.serial_number}
                                                        </p>
                                                    </div>
                                                    <CopyAction value={`Serial: ${voucher.serial_number}\nPIN: ${voucher.pin}`} label="voucher details" />
                                                </div>

                                                <div className="mt-4 flex items-center gap-2">
                                                    <button
                                                        onClick={() => {
                                                            const next = new Set(revealedPins)
                                                            if (next.has(pinKey)) {
                                                                next.delete(pinKey)
                                                            } else {
                                                                next.add(pinKey)
                                                            }
                                                            setRevealedPins(next)
                                                        }}
                                                        className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-emerald-400 dark:border-slate-700 dark:bg-slate-950"
                                                    >
                                                        <div>
                                                            <p className="text-xs text-slate-500 dark:text-slate-400">PIN</p>
                                                            <p className={cn(
                                                                'mt-1 font-mono text-sm font-semibold transition',
                                                                isRevealed ? 'text-slate-950 dark:text-white' : 'text-slate-300 blur-[4px] dark:text-slate-500'
                                                            )}>
                                                                {isRevealed ? voucher.pin : 'PIN HIDDEN'}
                                                            </p>
                                                        </div>
                                                        {isRevealed ? <EyeOff className="h-4 w-4 text-slate-400" /> : <Eye className="h-4 w-4 text-slate-400" />}
                                                    </button>
                                                    <CopyAction value={voucher.pin} label="PIN" />
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        ) : (
                            <div className="mt-5 rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-100">
                                Payment is recorded, but the voucher is not ready yet. Please check again shortly or contact the shop if the delay continues.
                            </div>
                        )}
                    </section>
                )}

                <section className="rounded-[24px] border border-white/70 bg-white/90 px-5 py-5 shadow-sm dark:border-white/10 dark:bg-slate-950/85">
                    <h3 className="text-sm font-semibold text-slate-950 dark:text-white">Need help?</h3>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        {shop.whatsapp_number && (
                            <a
                                href={`https://wa.me/${shop.whatsapp_number}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#1ebe5d]"
                            >
                                <MessageCircle className="h-4 w-4" />
                                WhatsApp
                            </a>
                        )}
                        <a
                            href={`tel:${shop.owner_phone}`}
                            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                        >
                            <Phone className="h-4 w-4" />
                            Call
                        </a>
                        {shop.owner_email && (
                            <a
                                href={`mailto:${shop.owner_email}`}
                                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                            >
                                <Mail className="h-4 w-4" />
                                Email
                            </a>
                        )}
                    </div>
                </section>
            </div>
            <CopyrightFooter
                variant="shop"
                shopName={shop.shop_name}
                className="border-t border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-950/50"
            />
        </div>
    )
}
