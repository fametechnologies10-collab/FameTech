import { Sora, Figtree } from 'next/font/google'

export const ftDisplay = Sora({
    subsets: ['latin'],
    display: 'swap',
    variable: '--font-ft-display',
})

export const ftBody = Figtree({
    subsets: ['latin'],
    display: 'swap',
    variable: '--font-ft-body',
})

// Variable fonts, applied at the root <body> (and harmlessly on .ft wrappers): both CSS variables plus the body font class.
export const ftFonts = {
    className: ftBody.className,
    variable: `${ftDisplay.variable} ${ftBody.variable}`,
}
