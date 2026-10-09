import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ClayButtonVariant = 'primary' | 'soft' | 'ghost'

export interface ClayButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ClayButtonVariant
    loading?: boolean
    asChild?: boolean
}

const VARIANTS: Record<ClayButtonVariant, string> = {
    primary: 'ft-clay',
    soft: 'ft-raised text-ft-ink',
    ghost: 'bg-transparent text-ft-ink hover:shadow-neu-raised',
}

export const ClayButton = React.forwardRef<HTMLButtonElement, ClayButtonProps>(
    ({ className, variant = 'primary', loading = false, asChild = false, disabled, children, type, onClick, ...props }, ref) => {
        const classes = cn(
            'inline-flex min-h-12 h-auto items-center justify-center gap-2 rounded-[1.25rem] px-6 py-2 text-center text-base font-semibold leading-snug transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60',
            VARIANTS[variant],
            className
        )

        if (asChild) {
            const inert = loading || Boolean(disabled)
            return (
                <Slot
                    ref={ref}
                    className={cn(classes, inert && 'pointer-events-none')}
                    aria-busy={loading || undefined}
                    aria-disabled={inert || undefined}
                    tabIndex={inert ? -1 : undefined}
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                        if (inert) {
                            e.preventDefault()
                            return
                        }
                        onClick?.(e)
                    }}
                    {...props}
                >
                    {children}
                </Slot>
            )
        }

        return (
            <button
                ref={ref}
                type={type ?? 'button'}
                className={classes}
                disabled={disabled || loading}
                aria-busy={loading || undefined}
                onClick={onClick}
                {...props}
            >
                {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
                {children}
            </button>
        )
    }
)
ClayButton.displayName = 'ClayButton'
