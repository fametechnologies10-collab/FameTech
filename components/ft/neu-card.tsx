import * as React from 'react'
import { cn } from '@/lib/utils'

export interface NeuCardProps extends React.HTMLAttributes<HTMLDivElement> {
    pressed?: boolean
}

export const NeuCard = React.forwardRef<HTMLDivElement, NeuCardProps>(
    // `pressed` is a purely decorative flat-bordered surface, not a form field, so it must
    // not use `.ft-inset` (which now carries focus-within/aria-invalid field styling). Both
    // variants share the same flat bordered treatment per the flat design spec.
    ({ className, pressed: _pressed = false, ...props }, ref) => (
        <div ref={ref} className={cn('ft-raised', 'p-5', className)} {...props} />
    )
)
NeuCard.displayName = 'NeuCard'
