// Styles are defined once in globals.css — no per-instance injection needed

type BrandLoaderProps = {
    /** true = fixed full-screen overlay (route/page transitions). false = inline, no bg. */
    fullScreen?: boolean
    /** Size of the pulse widget. Default 'lg' for full-screen, 'md' for inline. */
    size?: 'sm' | 'md' | 'lg'
    className?: string
}

const SIZE_CLASSES = {
    sm: { wrap: 'w-12 h-12',          core: 'w-1.5 h-1.5', ring: 'w-2 h-2'   },
    md: { wrap: 'w-[72px] h-[72px]',  core: 'w-2 h-2',     ring: 'w-3 h-3'   },
    lg: { wrap: 'w-[100px] h-[100px]',core: 'w-2.5 h-2.5', ring: 'w-4 h-4'   },
}

export function BrandLoader({ fullScreen = true, size, className = '' }: BrandLoaderProps) {
    const s = SIZE_CLASSES[size ?? (fullScreen ? 'lg' : 'md')]

    const pulse = (
        <div className={`kfg-pulse-wrap ${s.wrap} ${className}`}>
            {[0, 1, 2, 3].map(i => (
                <div key={i} className={`kfg-ring ${s.ring}`} />
            ))}
            <div className={`kfg-core ${s.core}`} />
        </div>
    )

    // fullScreen=true: renders its own fixed inset-0 overlay (used by loading.tsx files).
    // fullScreen=false: returns the pulse widget only — caller is responsible for positioning.
    if (fullScreen) {
        return (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#f8fafc] dark:bg-[#020817] animate-[kfg-fade-in_0.2s_ease]">
                {pulse}
            </div>
        )
    }

    return pulse
}
