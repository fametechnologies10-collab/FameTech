import Image from 'next/image'
import { cn } from '@/lib/utils'

interface BrandLogoProps {
    width?: number
    height?: number
    fill?: boolean
    className?: string
    priority?: boolean
}

export function BrandLogo({ width = 48, height = 48, fill = false, className, priority = true }: BrandLogoProps) {
    if (fill) {
        return (
            <div className={cn("relative rounded-full overflow-hidden", className)}>
                <Image
                    src="/logo.png"
                    alt="KiNG FLEXY GH Logo"
                    fill
                    className="object-cover rounded-full"
                    priority={priority}
                    sizes="(max-width: 640px) 48px, 96px"
                />
            </div>
        )
    }
    return (
        <Image
            src="/logo.png"
            alt="KiNG FLEXY GH Logo"
            width={width}
            height={height}
            className={cn("rounded-full flex-shrink-0 object-cover", className)}
            priority={priority}
        />
    )
}

interface BrandTitleProps {
    className?: string
    variant?: 'default' | 'hero'
}

export function BrandTitle({ className, variant = 'default' }: BrandTitleProps) {
    if (variant === 'hero') {
        return (
            <span className={cn("font-black tracking-tight", className)}>
                <span className="text-slate-900 dark:text-white">KiNG </span>
                <span className="text-[#FFCC00]">FLEXY GH</span>
            </span>
        )
    }

    return (
        <span className={cn("font-black tracking-tight", className)}>
            <span className="text-black dark:text-white">KiNG </span>
            <span className="text-[#FFCC00]">FLEXY GH</span>
        </span>
    )
}
