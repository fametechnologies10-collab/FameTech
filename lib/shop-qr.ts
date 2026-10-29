// Shop QR helpers: image URL + "save as PNG file" so shop owners can share the code.
// api.qrserver.com sends `Access-Control-Allow-Origin: *`; it is allow-listed in
// next.config.ts (img-src for display, connect-src for the download fetch).

export function shopQrImageUrl(shopUrl: string, size = 600, margin = 10): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=${margin}&format=png&data=${encodeURIComponent(shopUrl)}`
}

/** Downloads the shop's QR code as a PNG file. Returns false if the browser could not fetch it. */
export async function downloadShopQr(shopUrl: string, shopSlug: string): Promise<boolean> {
    try {
        const res = await fetch(shopQrImageUrl(shopUrl, 1000, 20))
        if (!res.ok) return false
        const blob = await res.blob()
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = `${shopSlug || 'shop'}-qr-code.png`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
        return true
    } catch {
        return false
    }
}
