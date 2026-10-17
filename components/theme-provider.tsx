"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

/**
 * next-themes only updates "system" via the matchMedia 'change' event.
 * Mobile browsers suspend JS while backgrounded, so a device theme switch
 * made while the app isn't in the foreground never fires that event — the
 * app stays on the stale theme until a full reload. Re-check on every
 * return to the foreground and nudge next-themes to recompute.
 */
function SystemThemeSync() {
    const { theme, setTheme } = useTheme()

    React.useEffect(() => {
        if (theme !== "system") return

        const resync = () => {
            if (document.visibilityState === "hidden") return
            setTheme("light")
            setTheme("system")
        }

        document.addEventListener("visibilitychange", resync)
        window.addEventListener("focus", resync)
        window.addEventListener("pageshow", resync)
        return () => {
            document.removeEventListener("visibilitychange", resync)
            window.removeEventListener("focus", resync)
            window.removeEventListener("pageshow", resync)
        }
    }, [theme, setTheme])

    return null
}

export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
    return (
        <NextThemesProvider {...props}>
            <SystemThemeSync />
            {children}
        </NextThemesProvider>
    )
}
