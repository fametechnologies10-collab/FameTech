/**
 * EGRESS BACKFILL — downscale oversized shop logos in the `shop-logos` bucket.
 *
 * Why: logos were uploaded raw (see app/api/shop/upload/route.ts) with only a
 * 5MB cap and no resizing. Measured 2026-08-16: 37 objects served 165 times in
 * 24h for 121.5 MB — averaging ~908 KB per request, some originals up to 2.9 MB.
 * That is the single largest Supabase egress line item on the project.
 *
 * SAFETY DESIGN (this rewrites production assets, so it is deliberately timid):
 *   - DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
 *   - Every original is downloaded to scripts/.logo-backups/ BEFORE any upload.
 *   - Same object path and SAME IMAGE FORMAT are preserved, so `logo_url` in
 *     shop_profiles keeps working untouched. No DB migration, no URL changes.
 *   - WebP is skipped: jimp 0.22 cannot decode it, and it is already efficient.
 *   - Files already under the size floor are skipped.
 *
 * Run from project root:
 *   npx tsx scripts/compress-shop-logos.ts            # dry run, writes nothing
 *   npx tsx scripts/compress-shop-logos.ts --apply    # backs up, then rewrites
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createClient } from '@supabase/supabase-js'
import Jimp from 'jimp'

// jimp's bundled jpeg-js defaults to a 512MB decode ceiling that rejects a few
// very large phone photos ("maxMemoryUsageInMB limit exceeded"). Those are
// exactly the files worth shrinking, so raise the ceiling for this one-off.
const JPEG = require('jpeg-js')
;(Jimp as any).decoders['image/jpeg'] = (data: Buffer) =>
    JPEG.decode(data, { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 })

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const BUCKET = 'shop-logos'
const MAX_DIM = 512              // logos render at <=64px; 512 leaves retina headroom
const JPEG_QUALITY = 85
const SKIP_BELOW_BYTES = 150 * 1024   // already small enough to not matter
// Don't re-encode for a marginal win — a rewrite always costs some generational
// quality loss, so it has to actually buy something. Several 500x500 PNGs only
// shrank 12-37 KB in the first dry run; those aren't worth touching.
const MIN_GAIN_RATIO = 0.20
const BACKUP_DIR = join('scripts', '.logo-backups')

const APPLY = process.argv.includes('--apply')
const INCLUDE_ORPHANS = process.argv.includes('--all')

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`

type Row = {
    path: string
    beforeBytes: number
    afterBytes: number
    dims: string
    action: string
    live: boolean
}

async function listAllObjects(): Promise<string[]> {
    const paths: string[] = []
    const { data: folders, error } = await db.storage.from(BUCKET).list('', { limit: 1000 })
    if (error) throw new Error(`list root failed: ${error.message}`)

    for (const entry of folders ?? []) {
        // Folder entries have a null id; real files at the root would have one.
        if (entry.id === null) {
            const { data: files, error: fErr } = await db.storage
                .from(BUCKET)
                .list(entry.name, { limit: 1000 })
            if (fErr) {
                console.warn(`  ! could not list ${entry.name}: ${fErr.message}`)
                continue
            }
            for (const f of files ?? []) {
                if (f.id !== null) paths.push(`${entry.name}/${f.name}`)
            }
        } else {
            paths.push(entry.name)
        }
    }
    return paths
}

// Detect the REAL format from magic bytes, not the file extension — this bucket
// contains WebP files saved under a .png name, and jimp 0.22 cannot decode WebP.
// Re-encoding by a lying extension would corrupt them.
function detectMime(buf: Buffer): string | null {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return Jimp.MIME_PNG
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return Jimp.MIME_JPEG
    }
    return null   // webp / unknown -> leave untouched
}

// Which objects are actually referenced by a shop? Only these cost egress; the
// rest are orphaned legacy uploads from before the deterministic-path change.
async function loadLiveLogoPaths(): Promise<Set<string>> {
    const live = new Set<string>()
    const { data, error } = await db.from('shop_profiles').select('logo_url')
    if (error) {
        console.warn(`! could not read shop_profiles (${error.message}) — every object will be treated as live`)
        return live
    }
    for (const row of (data ?? []) as { logo_url: string | null }[]) {
        const marker = `/${BUCKET}/`
        const idx = row.logo_url?.indexOf(marker) ?? -1
        if (row.logo_url && idx !== -1) {
            live.add(decodeURIComponent(row.logo_url.slice(idx + marker.length).split('?')[0]))
        }
    }
    return live
}

async function main() {
    console.log(APPLY
        ? '*** APPLY MODE — originals will be backed up, then overwritten ***\n'
        : '--- DRY RUN — nothing will be written. Pass --apply to commit. ---\n')

    const livePaths = await loadLiveLogoPaths()
    const allPaths = await listAllObjects()

    // Only logos actually referenced by a shop_profile cost egress. The rest are
    // orphaned legacy uploads (pre deterministic-path); rewriting them buys
    // nothing and risks touching an asset someone may still want.
    const paths = INCLUDE_ORPHANS
        ? allPaths
        : allPaths.filter((p) => livePaths.size === 0 || livePaths.has(p))

    console.log(`Found ${allPaths.length} object(s) in "${BUCKET}"`)
    console.log(`${livePaths.size} referenced by a shop_profile; processing ${paths.length}` +
        `${INCLUDE_ORPHANS ? ' (--all: including orphans)' : ' (live only; pass --all to include orphans)'}\n`)

    const rows: Row[] = []
    let totalBefore = 0
    let totalAfter = 0

    for (const path of paths) {
        const isLive = livePaths.size === 0 || livePaths.has(path)
        const { data: blob, error } = await db.storage.from(BUCKET).download(path)
        if (error || !blob) {
            rows.push({ path, beforeBytes: 0, afterBytes: 0, dims: '-', live: isLive, action: `ERROR: ${error?.message ?? 'no data'}` })
            continue
        }

        const original = Buffer.from(await blob.arrayBuffer())
        const beforeBytes = original.length
        totalBefore += beforeBytes

        const mime = detectMime(original)
        if (!mime) {
            totalAfter += beforeBytes
            rows.push({ path, beforeBytes, afterBytes: beforeBytes, dims: '-', live: isLive, action: 'skip (webp/unsupported)' })
            continue
        }
        if (beforeBytes < SKIP_BELOW_BYTES) {
            totalAfter += beforeBytes
            rows.push({ path, beforeBytes, afterBytes: beforeBytes, dims: '-', live: isLive, action: 'skip (already small)' })
            continue
        }

        let img: Jimp
        try {
            img = await Jimp.read(original)
        } catch (e: any) {
            totalAfter += beforeBytes
            rows.push({ path, beforeBytes, afterBytes: beforeBytes, dims: '-', live: isLive, action: `skip (decode failed: ${e.message})` })
            continue
        }

        const w = img.bitmap.width
        const h = img.bitmap.height
        if (w > MAX_DIM || h > MAX_DIM) img.scaleToFit(MAX_DIM, MAX_DIM)
        if (mime === Jimp.MIME_JPEG) img.quality(JPEG_QUALITY)

        const resized = await img.getBufferAsync(mime)
        const afterBytes = resized.length

        // A rewrite costs generational quality loss, so it must buy a real win.
        // Covers both "bigger than the original" and "trivially smaller".
        if (afterBytes >= beforeBytes * (1 - MIN_GAIN_RATIO)) {
            totalAfter += beforeBytes
            rows.push({ path, beforeBytes, afterBytes: beforeBytes, dims: `${w}x${h}`, live: isLive, action: 'skip (gain too small)' })
            continue
        }

        totalAfter += afterBytes
        const dims = `${w}x${h} -> ${img.bitmap.width}x${img.bitmap.height}`

        if (!APPLY) {
            rows.push({ path, beforeBytes, afterBytes, dims, live: isLive, action: 'would rewrite' })
            continue
        }

        // Back up the ORIGINAL before touching anything remote.
        const backupPath = join(BACKUP_DIR, path)
        mkdirSync(dirname(backupPath), { recursive: true })
        writeFileSync(backupPath, original)

        const { error: upErr } = await db.storage
            .from(BUCKET)
            .upload(path, resized, { contentType: mime, upsert: true })

        rows.push({
            path,
            beforeBytes,
            afterBytes,
            dims,
            live: isLive,
            action: upErr ? `UPLOAD FAILED: ${upErr.message}` : 'rewritten',
        })
    }

    rows.sort((a, b) => (b.beforeBytes - b.afterBytes) - (a.beforeBytes - a.afterBytes))

    console.log('Before    After     Saved     Dimensions              Ref     Action                Path')
    console.log('-'.repeat(130))
    for (const r of rows) {
        const saved = r.beforeBytes - r.afterBytes
        console.log(
            `${kb(r.beforeBytes).padEnd(10)}${kb(r.afterBytes).padEnd(10)}${kb(saved).padEnd(10)}` +
            `${r.dims.padEnd(24)}${(r.live ? 'live' : 'orphan').padEnd(8)}${r.action.padEnd(22)}${r.path}`
        )
    }

    const saved = totalBefore - totalAfter
    const pct = totalBefore > 0 ? ((saved / totalBefore) * 100).toFixed(1) : '0'
    console.log('-'.repeat(120))
    console.log(`TOTAL  before=${kb(totalBefore)}  after=${kb(totalAfter)}  saved=${kb(saved)} (${pct}%)`)

    if (APPLY) {
        console.log(`\nOriginals backed up under ${BACKUP_DIR}/`)
    } else {
        console.log('\nDry run only. Re-run with --apply to back up and rewrite.')
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
