import * as React from 'react'
import { cn } from '@/lib/utils'

export type NeuTrayProps = React.HTMLAttributes<HTMLDivElement>

export const NeuTray = React.forwardRef<HTMLDivElement, NeuTrayProps>(
    ({ className, ...props }, ref) => <div ref={ref} className={cn('rounded-xl border border-[color:var(--ft-edge)] bg-[color:var(--ft-surface)] p-1.5', className)} {...props} />
)
NeuTray.displayName = 'NeuTray'
