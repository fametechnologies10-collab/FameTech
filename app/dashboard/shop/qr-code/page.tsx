'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { shopQrImageUrl, downloadShopQr } from '@/lib/shop-qr'
import { ArrowLeft, Printer, Download, Loader2, QrCode as QrCodeIcon } from 'lucide-react'

export default function ShopQrCodePage() {
    const { dbUser } = useAuth()
    const [shopSlug, setShopSlug] = useState('')
    const [shopName, setShopName] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        if (!dbUser) return
        ;(async () => {
            const { data: shop } = await (supabase as any)
                .from('shop_profiles')
                .select('shop_slug, shop_name')
                .eq('owner_id', dbUser.id)
                .maybeSingle()
            if (shop) { setShopSlug(shop.shop_slug); setShopName(shop.shop_name) }
            setLoading(false)
        })()
    }, [dbUser])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    const shopUrl = shopSlug ? `https://shop.fametechgh.com/${shopSlug}` : ''

    return (
        <div className="space-y-5 pb-20 md:pb-6">
            <div className="print:hidden">
                <Link href="/dashboard/shop">
                    <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600 transition-colors">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Shop Dashboard
                    </Button>
                </Link>
                <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                    <QrCodeIcon className="w-5 h-5 text-emerald-600" />
                    Shop QR code
                </h1>
                <p className="text-muted-foreground text-sm mt-0.5">
                    Print this and place it where your customers can scan it to order.
                </p>
            </div>

            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-6 sm:p-10 flex flex-col items-center text-center print:border-0 print:p-0">
                <img
                    src={shopQrImageUrl(shopUrl, 600)}
                    alt="Shop QR code"
                    width={320}
                    height={320}
                    className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white p-4 print:border-0"
                />
                <h2 className="text-lg font-bold mt-5 text-gray-900 dark:text-white">{shopName}</h2>
                <p className="text-sm font-mono text-muted-foreground mt-1 break-all">{shopUrl}</p>
                <p className="text-xs text-muted-foreground mt-3 max-w-xs">
                    Scan this code to shop data bundles, airtime and vouchers.
                </p>

                <div className="mt-6 flex flex-wrap justify-center gap-2 print:hidden">
                    <Button
                        onClick={async () => {
                            const ok = await downloadShopQr(shopUrl, shopSlug)
                            if (ok) toast.success('QR code downloaded')
                            else toast.error('Could not download the QR code. Try again.')
                        }}
                        className="gap-1.5"
                    >
                        <Download className="w-4 h-4" /> Download QR
                    </Button>
                    <Button onClick={() => window.print()} variant="outline" className="gap-1.5">
                        <Printer className="w-4 h-4" /> Print
                    </Button>
                </div>
            </div>
        </div>
    )
}
