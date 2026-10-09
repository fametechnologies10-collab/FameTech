"use client"

import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
    return (
        <Sonner
            className="toaster"
            style={{
                "--normal-bg": "var(--ft-raised-bg)",
                "--normal-text": "var(--ft-ink)",
                "--normal-border": "var(--ft-lo)",
            } as React.CSSProperties}
            {...props}
        />
    )
}

export { Toaster }
