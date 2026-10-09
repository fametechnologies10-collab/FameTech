import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ft-blue)] dark:focus-visible:outline-[color:var(--ft-cyan)] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
    {
        variants: {
            variant: {
                default: "ft-clay-btn text-white hover:brightness-95",
                destructive: "ft-clay-btn text-white hover:brightness-95 [--ft-c1:#B71C1C] [--ft-c2:#D32F2F] [--ft-cglow:rgba(183,28,28,0.3)]",
                outline: "ft-soft hover:brightness-[0.97]",
                secondary: "ft-soft hover:brightness-[0.97]",
                ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
                link: "text-primary underline-offset-4 hover:underline",
                success: "ft-clay-btn text-white hover:brightness-95 [--ft-c1:#065F46] [--ft-c2:#047857] [--ft-cglow:rgba(4,120,87,0.3)]",
                warning: "ft-clay-btn text-[#451A03] hover:brightness-95 [--ft-c1:#FCD34D] [--ft-c2:#F59E0B] [--ft-cglow:rgba(245,158,11,0.35)]",
                mtn: "ft-clay-btn text-black hover:brightness-95 [--ft-c1:#FACC15] [--ft-c2:#EAB308] [--ft-cglow:rgba(234,179,8,0.35)]",
                telecel: "ft-clay-btn text-white hover:brightness-95 [--ft-c1:#C62828] [--ft-c2:#B71C1C] [--ft-cglow:rgba(198,40,40,0.3)]",
                gradient: "ft-clay-btn text-white hover:brightness-95 [--ft-c1:#0057FF] [--ft-c2:#3B2BD9]",
            },
            size: {
                default: "h-10 px-4 py-2",
                sm: "h-9 rounded-xl px-3",
                lg: "h-11 rounded-xl px-8",
                xl: "h-12 rounded-xl px-10 text-base",
                icon: "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button"
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        )
    }
)
Button.displayName = "Button"

export { Button, buttonVariants }
