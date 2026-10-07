'use client'
import { cn, formatCurrency } from '@/lib/utils'
import { ShoppingCart } from 'lucide-react'
import { NetworkIcon } from '@/components/network-icon'
import { styleFor } from './NetworkSelectorCard'

export interface StorefrontPackage { id: string; network: string; size: string; description: string | null; selling_price: number }

const SHORT: Record<string, string> = { 'AT-iShare': 'AT-iS', 'AT-BigTime': 'AT-BT' }

export function PackageCard({ pkg, view, onClick }: { pkg: StorefrontPackage; view: 'grid' | 'list'; onClick: () => void }) {
    const style = styleFor(pkg.network)
    if (view === 'grid') {
        return (
            <button
                onClick={onClick}
                className={cn('relative flex flex-col items-center rounded-2xl overflow-hidden transition-all duration-150 shadow-md hover:shadow-xl hover:-translate-y-0.5 active:scale-[0.94] active:shadow-sm cursor-pointer select-none text-left', style.cardBg)}
            >
                <div className="flex items-center justify-between w-full px-3 pt-3 pb-1">
                    <div className="p-1.5 bg-white/20 rounded-full">
                        <NetworkIcon network={pkg.network} size={20} variant="card" />
                    </div>
                    <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white')}>
                        {SHORT[pkg.network] ?? pkg.network}
                    </span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center px-2 py-3 gap-0.5">
                    <span className={cn('text-2xl font-black tracking-tight', style.isMTN ? 'text-black' : 'text-white')}>{pkg.size}</span>
                    <span className={cn('text-sm font-bold', style.isMTN ? 'text-black/80' : 'text-white/90')}>{formatCurrency(pkg.selling_price)}</span>
                    {pkg.description && pkg.description !== 'Instant Delivery' && (
                        <span className={cn('text-[10px] mt-0.5 px-1 text-center line-clamp-1 opacity-80', style.isMTN ? 'text-black' : 'text-white')}>{pkg.description}</span>
                    )}
                </div>
                <div className={cn('w-full py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5', style.isMTN ? 'bg-black/10 text-black' : 'bg-black/20 text-white')}>
                    <ShoppingCart className="w-3 h-3" /> Buy Now
                </div>
            </button>
        )
    }
    return (
        <button
            onClick={onClick}
            className={cn('w-full flex items-center justify-between p-3.5 rounded-2xl transition-all duration-150 shadow-sm hover:shadow-md active:scale-[0.97] active:brightness-95 cursor-pointer select-none', style.cardBg)}
        >
            <div className="flex items-center gap-3">
                <div className="p-2 bg-white/20 rounded-xl"><NetworkIcon network={pkg.network} size={30} /></div>
                <div className="text-left">
                    <p className={cn('font-bold text-sm leading-tight', style.isMTN ? 'text-black' : 'text-white')}>{pkg.size}</p>
                    <p className={cn('text-[11px] mt-0.5', style.isMTN ? 'text-black/70' : 'text-white/70')}>{pkg.description || 'Data Bundle'}</p>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <span className={cn('text-base font-black', style.isMTN ? 'text-black' : 'text-white')}>{formatCurrency(pkg.selling_price)}</span>
                <div className={cn('px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5', style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white')}>
                    <ShoppingCart className="w-3 h-3" /> Buy
                </div>
            </div>
        </button>
    )
}
