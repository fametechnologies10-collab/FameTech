import * as React from 'react'
import { cn } from '@/lib/utils'

export interface NeuInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    leading?: React.ReactNode
    trailing?: React.ReactNode
    wrapperClassName?: string
}

export const NeuInput = React.forwardRef<HTMLInputElement, NeuInputProps>(
    ({ className, wrapperClassName, leading, trailing, ...props }, ref) => (
        <div
            className={cn(
                'ft-inset flex h-12 items-center gap-2 px-4 focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-[color:var(--ft-blue)] dark:focus-within:outline-[color:var(--ft-cyan)]',
                wrapperClassName
            )}
        >
            {leading ? <span className="flex shrink-0 items-center text-[color:var(--ft-muted)]">{leading}</span> : null}
            <input
                ref={ref}
                className={cn(
                    'h-full min-w-0 flex-1 bg-transparent text-base text-ft-ink placeholder:text-[color:var(--ft-muted)] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
                    className
                )}
                {...props}
            />
            {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
        </div>
    )
)
NeuInput.displayName = 'NeuInput'
