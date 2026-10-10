"use client"

import * as React from "react"
import { Moon, Sun, Laptop, Check } from "lucide-react"
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
    const { theme, setTheme } = useTheme()
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

    const themes = [
        { id: "light", label: "Light", icon: Sun, color: "text-amber-500", bg: "bg-amber-50" },
        { id: "dark", label: "Dark", icon: Moon, color: "text-blue-500", bg: "bg-blue-50" },
        { id: "system", label: "System", icon: Laptop, color: "text-slate-500", bg: "bg-slate-50" },
    ]

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
                    <DialogTitle className="text-xl font-bold tracking-tight">Select Theme</DialogTitle>
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Choose your preferred appearance</p>
                </DialogHeader>
                <div className="p-4 grid gap-3">
                    {themes.map((t) => {
                        const Icon = t.icon
                        const isActive = theme === t.id
                        return (
                            <button
                                key={t.id}
                                onClick={() => {
                                    setTheme(t.id)
                                    setOpen(false)
                                }}
                                className={cn(
                                    "relative flex items-center justify-between p-4 rounded-xl border-2 transition-all duration-200 group overflow-hidden",
                                    isActive
                                        ? "border-primary ft-field scale-[1.02]"
                                        : "border-transparent bg-muted/30 hover:bg-muted/50 hover:border-muted-foreground/20 hover:scale-[1.01]"
                                )}
                            >
                                <div className="flex items-center gap-4">
                                    <div className={cn(
                                        "p-2.5 rounded-lg transition-colors",
                                        isActive ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground group-hover:text-primary"
                                    )}>
                                        <Icon className="h-5 w-5" />
                                    </div>
                                    <span className={cn(
                                        "font-bold text-sm tracking-tight transition-colors",
                                        isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                                    )}>
                                        {t.label}
                                    </span>
                                </div>
                                {isActive && (
                                    <div className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground shadow-sm animate-in zoom-in duration-300">
                                        <Check className="h-3.5 w-3.5 stroke-[3px]" />
                                    </div>
                                )}
                            </button>
                        )
                    })}
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
