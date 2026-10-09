import { Sora, Figtree } from 'next/font/google'

export const ftDisplay = Sora({
    subsets: ['latin'],
    weight: ['600', '800'],
    display: 'swap',
    variable: '--font-ft-display',
})

export const ftBody = Figtree({
    subsets: ['latin'],
    weight: ['400', '600'],
    display: 'swap',
    variable: '--font-ft-body',
})

// Apply to .ft wrappers only: both CSS variables plus the body font class.
export const ftFonts = {
    className: ftBody.className,
    variable: `${ftDisplay.variable} ${ftBody.variable}`,
}
