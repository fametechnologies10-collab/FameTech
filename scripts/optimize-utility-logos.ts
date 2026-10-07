/**
 * One-off (re-runnable) prep pass for the storefront/admin utility-biller logos
 * (components/utility-biller-logo.tsx, public/images/utilities/). Logos are supplied
 * ad hoc (dropped in at whatever size/format the source site had them), so before they
 * ship this trims each one down the same way scripts/compress-shop-logos.ts already
 * does for shop logos:
 *   - autocrop any uniform (transparent or flat-color) border, so a logo whose real
 *     content only fills the middle band of its canvas (e.g. a wide wordmark on a
 *     square canvas) actually fills the small tile it's rendered in instead of getting
 *     shrunk into a tiny letterboxed strip by object-contain.
 *   - downscale to MAX_DIM (logos render at <=40px in the UI; 512 leaves headroom for
 *     a future larger use without the current ~250-500KB-per-file bloat).
 *   - re-encode uniformly as PNG (keeps transparency where present; for a source like
 *     ECG's flat-color JPG, PNG compresses a handful-of-colors image far smaller than
 *     re-encoding as JPEG would anyway).
 *
 * Originals are backed up to scripts/.logo-backups/utilities/ before being overwritten,
 * matching the shop-logo script's safety convention.
 *
 * Run from project root:
 *   npx tsx scripts/optimize-utility-logos.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import Jimp from 'jimp'

const JPEG = require('jpeg-js')
;(Jimp as any).decoders['image/jpeg'] = (data: Buffer) =>
    JPEG.decode(data, { maxMemoryUsageInMB: 512 })

const OUT_DIR = join('public', 'images', 'utilities')
const BACKUP_DIR = join('scripts', '.logo-backups', 'utilities')
const MAX_DIM = 512
// A tight autocrop can leave content touching the frame edge (seen on Ghana Water's
// circular emblem) — pad the square canvas out by this fraction beyond the cropped
// content's longest side so every logo gets a small, consistent breathing margin.
const MARGIN_RATIO = 0.12

// One entry per biller: the raw source file as it was dropped in, and the canonical
// output name the app actually requests (see UtilityBillerLogo's CANDIDATE_EXTS —
// .png is tried first, so standardizing on .png here means every biller resolves on
// its first request instead of burning an onError round-trip).
const SOURCES: Array<{ src: string; out: string }> = [
    { src: join(OUT_DIR, 'ECG-Logo.jpg'), out: join(OUT_DIR, 'ecg.png') },
    { src: join(OUT_DIR, 'Ghana-Water.png'), out: join(OUT_DIR, 'ghana_water.png') },
    { src: join(OUT_DIR, 'dstv-logo.png'), out: join(OUT_DIR, 'dstv.png') },
    { src: join(OUT_DIR, 'gotv-logo.png'), out: join(OUT_DIR, 'gotv.png') },
    { src: join(OUT_DIR, 'startimes-logo.png'), out: join(OUT_DIR, 'startimes.png') },
]

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

async function main() {
    mkdirSync(BACKUP_DIR, { recursive: true })

    for (const { src, out } of SOURCES) {
        if (!existsSync(src)) {
            console.log(`skip (not found): ${src}`)
            continue
        }
        const original = readFileSync(src)
        const beforeBytes = original.length

        // Back up the exact raw bytes before any processing.
        writeFileSync(join(BACKUP_DIR, src.split(/[\\/]/).pop()!), original)

        const img = await Jimp.read(original)
        const beforeDims = `${img.bitmap.width}x${img.bitmap.height}`

        // Trim any uniform border (transparent OR flat-color) so the real logo content
        // fills the frame — without this, a wide wordmark on a big square canvas (e.g.
        // DSTV/GOtv) renders as a thin letterboxed strip under object-contain.
        img.autocrop()

        // ...but a plain crop alone overcorrects for a wordmark: it turns a square canvas
        // into an extreme wide aspect (DSTV cropped to 600x600 -> 512x95, a >5:1 strip),
        // which THEN renders tiny inside a square tile for the opposite reason (object-contain
        // fits by the limiting dimension, so a 5:1-wide image in a square box ends up a
        // sliver with big empty top/bottom gaps). Pad the cropped content back onto a
        // TRANSPARENT SQUARE canvas (content centered) before the final resize, so every
        // logo — narrow wordmark or already-square emblem like ECG (a no-op here, it has
        // no border to crop in the first place) — ends up the same square shape with its
        // real content given equal, consistent visual weight in the tile.
        const w = img.bitmap.width
        const h = img.bitmap.height
        const side = Math.round(Math.max(w, h) * (1 + MARGIN_RATIO))
        const squared = new (Jimp as any)(side, side, 0x00000000)
        squared.composite(img, Math.round((side - w) / 2), Math.round((side - h) / 2))

        if (side > MAX_DIM) squared.resize(MAX_DIM, MAX_DIM)

        const resized = await squared.getBufferAsync(Jimp.MIME_PNG)
        writeFileSync(out, resized)

        console.log(
            `${src.split(/[\\/]/).pop()} -> ${out.split(/[\\/]/).pop()}: ` +
            `${beforeDims} -> ${squared.bitmap.width}x${squared.bitmap.height} (cropped content ${w}x${h}), ` +
            `${kb(beforeBytes)} -> ${kb(resized.length)}`
        )
    }

    console.log(`\nOriginals backed up under ${BACKUP_DIR}/`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
