/* FameTech FT palette ramps (hex) + colour math used by the palette guard test and tailwind.config.ts */

export type FtRamp = Record<'50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950', string>

export const FT_SLATE: FtRamp = {
    '50': '#E6ECF5',
    '100': '#DCE4F0',
    '200': '#CBD5E6',
    '300': '#B3C0D6',
    '400': '#8190AE',
    '500': '#566688',
    '600': '#3E4C71',
    '700': '#2B3959',
    '800': '#1B2745',
    '900': '#0F1626',
    '950': '#0A0F1C',
}

export const FT_BLUE: FtRamp = {
    '50': '#EAF1FF',
    '100': '#D6E4FF',
    '200': '#ADC9FF',
    '300': '#7AA6FF',
    '400': '#3F7DFF',
    '500': '#1A66FF',
    '600': '#0057FF',
    '700': '#0046CC',
    '800': '#003599',
    '900': '#002566',
    '950': '#00153D',
}

export const FT_INDIGO: FtRamp = {
    '50': '#EEF0FF',
    '100': '#DDE1FF',
    '200': '#BBC3FF',
    '300': '#919EFF',
    '400': '#6577F7',
    '500': '#3C44D0',
    '600': '#3140D1',
    '700': '#2631A8',
    '800': '#1F2882',
    '900': '#1A2063',
    '950': '#0E1238',
}

export const FT_IRIS: FtRamp = {
    '50': '#F3F1FF',
    '100': '#E7E3FF',
    '200': '#CFC8FF',
    '300': '#B0A5FF',
    '400': '#8C7DFB',
    '500': '#8064F8',
    '600': '#5B49DC',
    '700': '#4A3AB8',
    '800': '#3C3092',
    '900': '#2F2772',
    '950': '#1A1542',
}

export const FT_CYAN: FtRamp = {
    '50': '#E6FAFF',
    '100': '#BFF2FF',
    '200': '#80E4FF',
    '300': '#40D6FF',
    '400': '#1ACCFF',
    '500': '#00C8FF',
    '600': '#00A3D1',
    '700': '#007EA3',
    '800': '#005A75',
    '900': '#003A4D',
    '950': '#00222E',
}

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function linearize(channel: number): number {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map(linearize)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio between two hex colours (order independent). */
export function contrastRatio(fg: string, bg: string): number {
    const a = luminance(fg)
    const b = luminance(bg)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function toLab(hex: string): [number, number, number] {
    const [r, g, b] = hexToRgb(hex).map(linearize)
    // sRGB -> XYZ (D65), normalised to the D65 white point
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
    const fx = f(x)
    const fy = f(y)
    const fz = f(z)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 delta-E between two hex colours. */
export function colorDistance(a: string, b: string): number {
    const [l1, a1, b1] = toLab(a)
    const [l2, a2, b2] = toLab(b)
    return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
}
