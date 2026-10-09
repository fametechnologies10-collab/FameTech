import * as React from 'react'
import { cn } from '@/lib/utils'

export interface NeuCardProps extends React.HTMLAttributes<HTMLDivElement> {
    pressed?: boolean
}

export const NeuCard = React.forwardRef<HTMLDivElement, NeuCardProps>(
    ({ className, pressed = false, ...props }, ref) => (
        <div ref={ref} className={cn(pressed ? 'ft-inset' : 'ft-raised', 'p-5', className)} {...props} />
    )
)
NeuCard.displayName = 'NeuCard'
