"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { detectAutoLite } from "@/lib/ft-lite"

type PerfMode = "auto" | "lite" | "full"

export function ThemeToggle({ brandName }: { brandName?: string }) {
    const { theme, resolvedTheme, setTheme } = useTheme()
    const [open, setOpen] = React.useState(false)

    const [perf, setPerf] = React.useState<PerfMode>("auto")

    React.useEffect(() => {
        try {
            const v = localStorage.getItem("ft-lite")
            setPerf(v === "1" ? "lite" : v === "0" ? "full" : "auto")
        } catch {
            // storage unavailable: stay on auto
        }
    }, [])

    // One-time migration: users who previously picked a manual Light/Dark
    // theme are stuck on it since next-themes persists the choice — reset
    // them to "system" now that manual override has been removed.
    React.useEffect(() => {
        if (theme && theme !== "system") setTheme("system")
    }, [theme, setTheme])

    const perfModes: { id: PerfMode; label: string }[] = [
        { id: "auto", label: "Auto" },
        { id: "lite", label: "Lite" },
        { id: "full", label: "Full" },
    ]

    const choosePerf = (mode: PerfMode) => {
        setPerf(mode)
        try {
            if (mode === "auto") localStorage.removeItem("ft-lite")
            else localStorage.setItem("ft-lite", mode === "lite" ? "1" : "0")
        } catch {
            // storage unavailable: still apply for this page view
        }
        const on = mode === "lite" || (mode === "auto" && detectAutoLite())
        document.documentElement.classList.toggle("lite", on)
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="h-10 w-10 rounded-full transition-all hover:scale-105 active:scale-95">
                    <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                    <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    <span className="sr-only">Toggle theme</span>
                </Button>
            </DialogTrigger>
            <DialogContent aria-describedby={undefined} className="sm:max-w-[400px] p-0 overflow-hidden">
                <DialogHeader className="p-6 pb-2">
                    <DialogTitle className="text-xl font-bold tracking-tight">Display Settings</DialogTitle>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Theme follows your device automatically</p>
                </DialogHeader>
                <div className="p-4">
                    <div className="flex items-center gap-4 p-4 rounded-xl border-2 border-primary ft-field">
                        <div className="relative p-2.5 rounded-lg bg-primary text-primary-foreground">
                            <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 absolute" />
                            <Moon className="h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                        </div>
                        <div>
                            <p className="font-bold text-sm tracking-tight text-foreground">System ({resolvedTheme === "dark" ? "Dark" : "Light"})</p>
                            <p className="text-xs text-muted-foreground">Switches with your phone's light/dark setting</p>
                        </div>
                    </div>
                </div>
                <div className="px-4 pb-4">
                    <p className="px-1 pb-2 text-sm font-semibold">Performance</p>
                    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Performance mode">
                        {perfModes.map((m) => (
                            <button
                                key={m.id}
                                type="button"
                                aria-pressed={perf === m.id}
                                onClick={() => choosePerf(m.id)}
                                className={cn(
                                    "min-h-[40px] rounded-lg border px-3 text-sm font-medium transition-colors",
                                    perf === m.id
                                        ? "border-primary bg-primary/10 text-foreground"
                                        : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <p className="px-1 pt-2 text-xs text-muted-foreground">Lite turns off shadows and animations to run faster on older phones.</p>
                </div>
                <div className="bg-muted/30 p-4 text-[10px] text-center text-muted-foreground font-medium uppercase tracking-widest border-t">
                    {brandName || 'Fame Technologies'} • UI PRESET
                </div>
            </DialogContent>
        </Dialog>
    )
}
