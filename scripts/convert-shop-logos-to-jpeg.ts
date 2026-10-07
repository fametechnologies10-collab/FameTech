/**
 * EGRESS BACKFILL — re-save opaque PNG shop logos as JPEG.
 *
 * Why: measured 2026-09-27, 41 live logos were 512px PHOTOS stored as PNG,
 * averaging 282 KB, and shop-logos was the largest Supabase egress line
 * (19 MB/day). They load unoptimized as the storefront favicon, PWA icon and
 * WhatsApp/Facebook preview. JPEG is ~5x smaller for photos. New uploads already
 * do this (app/api/shop/upload/route.ts); this converts the existing ones.
 *
 * SAFETY DESIGN (rewrites production data, so deliberately timid):
 *   - DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
 *   - Only logos referenced by a shop_profile are touched.
 *   - Only real PNGs (magic bytes) with NO transparent pixel; transparent logos,
 *     JPEG and WebP (incl. WebP saved under a .png name) are skipped.
 *   - Skipped unless JPEG saves at least MIN_GAIN_RATIO.
 *   - The original is backed up to scripts/.logo-backups/ AND left in the bucket.
 *     The JPEG is written as a NEW object beside it, then logo_url is swapped
 *     with a compare-and-swap on the exact old URL. Rollback = set logo_url back.
 *   - The new object is downloaded and decoded again before logo_url is swapped.
 *
 * Run from the project root (env from .env.local):
 *   npx tsx --env-file=.env.local scripts/convert-shop-logos-to-jpeg.ts          # dry run
 *   npx tsx --env-file=.env.local scripts/convert-shop-logos-to-jpeg.ts --apply  # convert
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createClient } from '@supabase/supabase-js'
import Jimp from 'jimp'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
})

const BUCKET = 'shop-logos'
const MAX_DIM = 512
const JPEG_QUALITY = 85                          // same as the upload route
const CACHE_SECONDS = String(30 * 24 * 60 * 60)  // same as the upload route
const MIN_GAIN_RATIO = 0.3
const BACKUP_DIR = join('scripts', '.logo-backups')
const APPLY = process.argv.includes('--apply')
const MARKER = `/${BUCKET}/`
const SAFE_PNG_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/logo(_\d+)?\.png$/i

const kb = (n: number) => `${Math.round(n / 1024)} KB`
const isPng = (b: Buffer) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

async function main() {
    console.log(APPLY ? '*** APPLY MODE ***\n' : '--- DRY RUN — pass --apply to convert ---\n')

    const { data: shops, error } = await db.from('shop_profiles').select('id, shop_slug, logo_url').not('logo_url', 'is', null)
    if (error) throw new Error(`read shop_profiles: ${error.message}`)

    let before = 0, after = 0, converted = 0
    for (const shop of shops as { id: string; shop_slug: string; logo_url: string }[]) {
        const idx = shop.logo_url.indexOf(MARKER)
        if (idx === -1) continue
        const path = decodeURIComponent(shop.logo_url.slice(idx + MARKER.length).split('?')[0])
        // logo_url is owner-editable, and `path` becomes a local backup file path below —
        // accept ONLY the shapes the upload route itself writes ({uuid}/logo.png or
        // {uuid}/logo_<ms>.png), so a crafted URL can never reach the filesystem with '..'.
        if (!SAFE_PNG_PATH.test(path)) continue

        const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(path)
        if (dlErr || !blob) { console.log(`ERROR  ${path}: ${dlErr?.message ?? 'no data'}`); continue }
        const original = Buffer.from(await blob.arrayBuffer())
        if (!isPng(original)) { console.log(`skip   ${path} (not really PNG)`); continue }

        let img: Jimp
        try { img = await Jimp.read(original) } catch (e: any) { console.log(`skip   ${path} (decode: ${e.message})`); continue }
        if (img.hasAlpha()) { console.log(`skip   ${path} (has transparency) ${kb(original.length)}`); continue }
        if (img.bitmap.width > MAX_DIM || img.bitmap.height > MAX_DIM) img.scaleToFit(MAX_DIM, MAX_DIM)
        const jpeg = await img.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG)

        if (jpeg.length > original.length * (1 - MIN_GAIN_RATIO)) {
            console.log(`skip   ${path} (gain too small: ${kb(original.length)} -> ${kb(jpeg.length)})`)
            continue
        }
        before += original.length
        after += jpeg.length
        const newPath = path.replace(/\.png$/i, '.jpg')
        console.log(`${APPLY ? 'conv' : 'would'}  ${kb(original.length).padStart(7)} -> ${kb(jpeg.length).padStart(6)}  ${shop.shop_slug}  ${path} -> ${newPath}`)
        if (!APPLY) continue

        const backup = join(BACKUP_DIR, path)
        mkdirSync(dirname(backup), { recursive: true })
        writeFileSync(backup, original)

        const { error: upErr } = await db.storage.from(BUCKET).upload(newPath, jpeg, {
            contentType: 'image/jpeg', cacheControl: CACHE_SECONDS, upsert: true,
        })
        if (upErr) { console.log(`   UPLOAD FAILED: ${upErr.message} — logo_url untouched`); continue }

        // Verify the stored object before pointing the shop at it.
        const { data: check } = await db.storage.from(BUCKET).download(newPath)
        const checkBuf = check ? Buffer.from(await check.arrayBuffer()) : null
        let ok = false
        try { ok = !!checkBuf && checkBuf.length === jpeg.length && (await Jimp.read(checkBuf)).bitmap.width > 0 } catch { ok = false }
        if (!ok) { console.log('   VERIFY FAILED — logo_url untouched'); continue }

        const newUrl = `${db.storage.from(BUCKET).getPublicUrl(newPath).data.publicUrl}?v=${Date.now()}`
        const { data: swapped, error: swErr } = await db.from('shop_profiles')
            .update({ logo_url: newUrl })
            .eq('id', shop.id)
            .eq('logo_url', shop.logo_url)   // CAS: never overwrite a logo the owner changed meanwhile
            .select('id')
        if (swErr) console.log(`   URL SWAP FAILED: ${swErr.message}`)
        else if (!swapped?.length) console.log('   URL SWAP SKIPPED: logo_url changed meanwhile')
        else converted++
    }

    console.log(`\nTOTAL ${kb(before)} -> ${kb(after)} (saved ${kb(before - after)}, ${before ? Math.round(100 * (before - after) / before) : 0}%)` +
        (APPLY ? `, ${converted} shop(s) switched. Originals kept in the bucket and in ${BACKUP_DIR}/` : ''))
}

main().catch(e => { console.error(e); process.exit(1) })
