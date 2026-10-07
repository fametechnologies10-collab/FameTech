'use client'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'
import { NetworkIcon } from '@/components/network-icon'

export const NETWORK_STYLE: Record<string, { selectedBorder: string; cardBg: string; isMTN: boolean }> = {
    MTN: { selectedBorder: 'border-amber-400', cardBg: 'bg-amber-400', isMTN: true },
    Telecel: { selectedBorder: 'border-red-600', cardBg: 'bg-red-600', isMTN: false },
    'AT-iShare': { selectedBorder: 'border-blue-600', cardBg: 'bg-blue-600', isMTN: false },
    'AT-BigTime': { selectedBorder: 'border-violet-600', cardBg: 'bg-violet-600', isMTN: false },
    AT: { selectedBorder: 'border-orange-500', cardBg: 'bg-orange-500', isMTN: false },
}
export const styleFor = (network: string) => NETWORK_STYLE[network] ?? NETWORK_STYLE.MTN

const LABELS: Record<string, string> = { 'AT-iShare': 'AT iShare', 'AT-BigTime': 'AT BigTime' }

export function NetworkSelectorCard({ network, selected, onClick }: { network: string; selected: boolean; onClick: () => void }) {
    const style = styleFor(network)
    return (
        <button
            onClick={onClick}
            aria-pressed={selected}
            className={cn(
                'relative flex flex-col items-center gap-1.5 p-2.5 sm:p-3 rounded-2xl border-2 bg-white dark:bg-zinc-900 transition-all duration-200 w-full',
                selected ? `${style.selectedBorder} shadow-sm` : 'border-gray-100 dark:border-zinc-800 hover:border-gray-200 dark:hover:border-zinc-700'
            )}
        >
            {selected && (
                <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
                    <Check className="w-2.5 h-2.5 text-white" />
                </span>
            )}
            <NetworkIcon network={network} size={34} />
            <span className="text-xs sm:text-sm font-semibold text-gray-800 dark:text-gray-200 leading-tight text-center">
                {LABELS[network] ?? network}
            </span>
            <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-[10px] sm:text-xs text-green-600 font-medium">Live</span>
            </div>
        </button>
    )
}
