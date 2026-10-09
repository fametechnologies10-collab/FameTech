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
                    alt="FameTech Logo"
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
            alt="FameTech Logo"
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
                <span className="text-[color:var(--ft-ink)]">Fame</span>
                <span className="text-[color:var(--ft-blue)] dark:text-[color:var(--ft-cyan)]">Tech</span>
            </span>
        )
    }

    return (
        <span className={cn("font-black tracking-tight", className)}>
            <span className="text-[color:var(--ft-ink)]">Fame</span>
            <span className="text-[color:var(--ft-blue)] dark:text-[color:var(--ft-cyan)]">Tech</span>
        </span>
    )
}
