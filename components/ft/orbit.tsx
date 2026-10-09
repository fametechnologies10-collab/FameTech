import { cn } from '@/lib/utils'

export interface OrbitProps {
    className?: string
}

export function Orbit({ className }: OrbitProps) {
    return <div aria-hidden="true" className={cn('ft-orbit', className)} />
}
