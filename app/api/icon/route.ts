import { NextResponse } from 'next/server'

/**
 * Dynamic Fallback Icon Generator
 * Generates a beautiful letter-based app icon for shops without logos.
 * Uses the first letter of the shop name over a background matching their brand color.
 * 
 * Usage: /api/icon?name=Felix%20Shop&color=%230056B3&size=512
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const name = searchParams.get('name') || 'S'
    const color = searchParams.get('color') || '#0056B3'
    const size = parseInt(searchParams.get('size') || '512', 10)

    const letter = name.charAt(0).toUpperCase()
    const fontSize = Math.round(size * 0.45)
    const padding = Math.round(size * 0.08)

    // Generate a visually pleasing SVG icon
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${color};stop-opacity:1" />
      <stop offset="100%" style="stop-color:${adjustColor(color, -30)};stop-opacity:1" />
    </linearGradient>
    <linearGradient id="shine" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:rgba(255,255,255,0.15);stop-opacity:1" />
      <stop offset="50%" style="stop-color:rgba(255,255,255,0);stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${padding}" fill="url(#bg)" />
  <rect width="${size}" height="${size}" rx="${padding}" fill="url(#shine)" />
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" 
        font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" 
        font-size="${fontSize}" font-weight="900" fill="white" letter-spacing="-2">
    ${letter}
  </text>
</svg>`.trim()

    return new NextResponse(svg, {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        },
    })
}

/**
 * Darkens or lightens a hex color by the given amount.
 */
function adjustColor(hex: string, amount: number): string {
    try {
        let color = hex.replace('#', '')
        if (color.length === 3) {
            color = color.split('').map(c => c + c).join('')
        }
        const num = parseInt(color, 16)
        const r = Math.min(255, Math.max(0, ((num >> 16) & 0xff) + amount))
        const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount))
        const b = Math.min(255, Math.max(0, (num & 0xff) + amount))
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
    } catch {
        return hex
    }
}
