"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
    React.ElementRef<typeof SwitchPrimitives.Root>,
    React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
    <SwitchPrimitives.Root
        className={cn(
            "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ft-field data-[state=checked]:border-[#0057FF] data-[state=checked]:bg-[#0057FF] data-[state=unchecked]:bg-[color:var(--ft-field-bg)]",
            className
        )}
        {...props}
        ref={ref}
    >
        <SwitchPrimitives.Thumb
            className={cn(
                "pointer-events-none block h-5 w-5 rounded-full shadow-[0_1px_2px_rgba(14,26,51,0.25)] ring-0 transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-white data-[state=unchecked]:translate-x-0.5 data-[state=unchecked]:bg-[color:var(--ft-muted)]"
            )}
        />
    </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
