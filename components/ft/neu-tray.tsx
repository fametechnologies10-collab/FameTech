import * as React from 'react'
import { cn } from '@/lib/utils'

export type NeuTrayProps = React.HTMLAttributes<HTMLDivElement>

export const NeuTray = React.forwardRef<HTMLDivElement, NeuTrayProps>(
    ({ className, ...props }, ref) => <div ref={ref} className={cn('ft-inset p-1.5', className)} {...props} />
)
NeuTray.displayName = 'NeuTray'
