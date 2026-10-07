import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import Jimp from 'jimp'

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
const MAX_LOGO_BYTES = 5 * 1024 * 1024   // 5 MB — what we ACCEPT, not what we store

// EGRESS: logos used to be stored exactly as uploaded. Phone photos of 1-3 MB
// were then served on every storefront visit and every next/image variant
// fetch, which measured as the single largest Supabase egress line item
// (2026-08-16: 37 objects, 121.5 MB in 24h, ~908 KB per request). Logos render
// at <=64px, so 512px still leaves retina headroom.
const MAX_LOGO_DIM = 512
const LOGO_JPEG_QUALITY = 85

// EGRESS (2026-09-27): a 512px PHOTO saved as PNG still averaged 282 KB (41 live
// logos). An opaque PNG is therefore stored as JPEG (~5x smaller); only a PNG
// with real transparency stays PNG. The object is then cached for 30 days — safe
// because the returned URL carries a ?v= version, so a replaced logo gets a new URL.
const LOGO_CACHE_SECONDS = String(30 * 24 * 60 * 60)

// SEC: decompression-bomb ceiling. MAX_LOGO_BYTES is NOT a bound on decode cost —
// a flat-colour PNG only a few KB on disk can declare 10000x10000 and expand to a
// ~400MB RGBA bitmap. 40MP (~160MB decoded) is far beyond any real logo; a genuine
// photo that large would exceed MAX_LOGO_BYTES long before reaching this.
const MAX_DECODE_PIXELS = 40_000_000
const JPEG_DECODE_MAX_MB = 160   // ~= MAX_DECODE_PIXELS x 4 bytes/px

// SEC: a file whose magic bytes claim a raster format but which jimp cannot decode
// is suspicious — without this it would fall back to storing the original
// full-size bytes and silently defeat the downscale. Odd-but-valid encodings do
// exist, so only large undecodable files are rejected.
const MAX_UNDECODABLE_FALLBACK_BYTES = 500 * 1024

// Hoisted to module scope deliberately: this mutates Jimp's GLOBAL decoder table.
// Doing it per-request would race across concurrent invocations sharing a warm
// Fluid Compute instance the moment this config ever becomes request-dependent.
;(Jimp as unknown as { decoders: Record<string, unknown> }).decoders['image/jpeg'] =
    (data: Buffer) => require('jpeg-js').decode(data, { maxMemoryUsageInMB: JPEG_DECODE_MAX_MB })

// Magic byte signatures for image formats
type MagicSig = { mime: string; segments: { offset: number; bytes: number[] }[] }
const MAGIC_BYTES: MagicSig[] = [
    { mime: 'image/jpeg', segments: [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }] },
    { mime: 'image/png',  segments: [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }] },
    // Must match the RIFF container AND the WEBP FourCC at offset 8. Checking only
    // "RIFF" also matches WAV/AVI, which would let non-image bytes be stored in a
    // public bucket under an image content-type.
    {
        mime: 'image/webp',
        segments: [
            { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
            { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
        ],
    },
]

function detectMimeFromBytes(buffer: ArrayBuffer): string | null {
    const bytes = new Uint8Array(buffer.slice(0, 12))
    for (const sig of MAGIC_BYTES) {
        const matches = sig.segments.every((seg) =>
            seg.bytes.every((b, i) => bytes[seg.offset + i] === b)
        )
        if (matches) return sig.mime
    }
    return null
}

// PNG IHDR carries width/height as big-endian uint32 at fixed offsets 16 and 20
// (8-byte signature + 4-byte chunk length + 4-byte "IHDR"). Reading them costs
// nothing and lets us reject a bomb BEFORE allocating the bitmap. JPEG is covered
// separately by the jpeg-js maxMemoryUsageInMB budget above.
function pngPixelCount(buf: Buffer): number | null {
    if (buf.length < 24) return null
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (!width || !height) return null
    return width * height
}

export async function POST(req: NextRequest) {
    try {
        // ── 1. Authenticate ──────────────────────────────────────────────────
        const cookieStore = await cookies()
        const supabaseAuth = await createRouteClient()
        const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── 1b. Authorize: caller must own a shop (SEC-030) ──────────────────
        // Auth alone is not enough — an authenticated non-owner must not be able
        // to write into the shop-logos bucket. RLS-aware select scopes to the
        // caller; no shop => 403.
        const { data: shop } = await supabaseAuth
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // ── 2. Parse multipart form data ─────────────────────────────────────
        const formData = await req.formData()
        const file = formData.get('file') as File | null
        const uploadType = formData.get('type') as string | null // 'logo'

        if (!file || !uploadType) {
            return NextResponse.json({ error: 'Missing file or upload type' }, { status: 400 })
        }

        if (uploadType !== 'logo') {
            return NextResponse.json({ error: 'Invalid upload type' }, { status: 400 })
        }

        // ── 3. Server-side file validation ───────────────────────────────────
        if (!ALLOWED_MIME_TYPES.includes(file.type)) {
            return NextResponse.json(
                { error: 'File type not allowed. Use JPG, PNG, or WEBP.' },
                { status: 400 }
            )
        }

        if (file.size > MAX_LOGO_BYTES) {
            return NextResponse.json(
                { error: 'File too large. Max size is 5MB.' },
                { status: 400 }
            )
        }

        // ── 4. Server-side magic byte verification (client MIME type is untrusted) ──
        const fileBuffer = await file.arrayBuffer()
        const detectedMime = detectMimeFromBytes(fileBuffer)
        if (!detectedMime || !ALLOWED_MIME_TYPES.includes(detectedMime)) {
            return NextResponse.json(
                { error: 'File content does not match an allowed image type (JPG, PNG, WEBP).' },
                { status: 400 }
            )
        }

        // ── 5. Derive extension from verified MIME — never trust file.name ────
        const MIME_TO_EXT: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/jpg':  'jpg',
            'image/png':  'png',
            'image/webp': 'webp',
        }
        if (!ALLOWED_EXTENSIONS.includes(MIME_TO_EXT[detectedMime] || 'jpg')) {
            return NextResponse.json({ error: 'File extension not allowed.' }, { status: 400 })
        }

        // ── 6. Bucket ────────────────────────────────────────────────────────
        // Path pattern: {user_id}/{type}.{ext} — deterministic so each user keeps
        // at most one logo per format (upsert overwrites) instead of stacking
        // timestamped objects unbounded (SEC-030). The user folder is enforced
        // here, so users can only write to their own folder. The extension is
        // fixed AFTER encoding (step 6b) because an opaque PNG is stored as JPEG.
        const bucket = 'shop-logos'
        let storedMime = detectedMime

        // ── 6b. Downscale before storing ─────────────────────────────────────
        // jimp 0.22 cannot decode WebP, and WebP is already compact, so those
        // pass through untouched. A decode failure must never block a legitimate
        // upload — we fall back to the original bytes, which are already
        // validated and under MAX_LOGO_BYTES.
        let uploadBuffer: Buffer = Buffer.from(fileBuffer)

        if (detectedMime !== 'image/webp') {
            // SEC: reject oversized PNGs before decoding — the byte cap alone does
            // not bound how much memory the bitmap will take.
            const pixels = detectedMime === 'image/png' ? pngPixelCount(uploadBuffer) : null
            if (pixels !== null && pixels > MAX_DECODE_PIXELS) {
                return NextResponse.json(
                    { error: 'Image dimensions are too large. Please upload a smaller logo.' },
                    { status: 400 }
                )
            }

            try {
                const img = await Jimp.read(uploadBuffer)
                if (img.bitmap.width > MAX_LOGO_DIM || img.bitmap.height > MAX_LOGO_DIM) {
                    img.scaleToFit(MAX_LOGO_DIM, MAX_LOGO_DIM)
                }
                // Opaque images (every JPEG, and a PNG with no transparent pixel)
                // are stored as JPEG; a PNG with real transparency stays PNG.
                const targetMime = detectedMime === 'image/png' && img.hasAlpha() ? 'image/png' : 'image/jpeg'
                if (targetMime === 'image/jpeg') img.quality(LOGO_JPEG_QUALITY)

                const encoded = await img.getBufferAsync(targetMime)
                // Never store something larger than what we received.
                if (encoded.length < uploadBuffer.length) {
                    uploadBuffer = encoded
                    storedMime = targetMime
                }
            } catch (e: any) {
                // Magic bytes said JPEG/PNG but the decoder disagreed. Storing the
                // original here is what the pre-change route effectively did, and
                // it is trivially reachable on purpose — so allow it only for files
                // small enough that the egress cost is irrelevant.
                console.warn('[Upload API] logo downscale failed:', e?.message)
                if (uploadBuffer.length > MAX_UNDECODABLE_FALLBACK_BYTES) {
                    return NextResponse.json(
                        { error: 'Could not process this image. Please re-save it as a standard JPG or PNG and try again.' },
                        { status: 400 }
                    )
                }
            }
        }

        const ext = MIME_TO_EXT[storedMime] || 'jpg'
        const path = `${user.id}/${uploadType}.${ext}`

        // ── 7. Upload via service role (stays on server, never sent to browser) ──
        const adminDb = createServerClient()

        // contentType comes from the magic-byte check / our own re-encode, never
        // the client-supplied file.type — that is untrusted.
        const { error: uploadError } = await adminDb.storage
            .from(bucket)
            .upload(path, uploadBuffer, {
                contentType: storedMime,
                cacheControl: LOGO_CACHE_SECONDS,
                upsert: true,
            })

        if (uploadError) {
            console.error('[Upload API] Storage error:', uploadError)
            return NextResponse.json(
                { error: 'Storage upload failed: ' + uploadError.message },
                { status: 500 }
            )
        }

        // ── 8. Return the public URL ─────────────────────────────────────────
        // The logo in another format (e.g. logo.png before this became logo.jpg) is
        // deliberately NOT deleted here: the saved logo_url still points at it until
        // the owner saves their profile, and an abandoned edit must not break it.
        // At most one object per format per user, so this stays bounded (SEC-030).

        // ?v= makes every upload a new URL, so the 30-day cache can never serve
        // the previous logo from the same path.
        const { data: urlData } = adminDb.storage.from(bucket).getPublicUrl(path)

        return NextResponse.json({ publicUrl: `${urlData.publicUrl}?v=${Date.now()}` })

    } catch (err: any) {
        console.error('[Upload API] Unhandled error:', err)
        return NextResponse.json(
            { error: err.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
