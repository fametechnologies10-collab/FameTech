import assert from 'node:assert/strict'
import {
    normalizeRecipient,
    carrierForPackageNetwork,
    recipientMatchesPackage,
    blacklistVariants,
    findBlacklistedRecipients,
    isValidReferenceCode,
    isValidBatchReference,
} from '../lib/order-recipient'

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
    try {
        await fn()
        passed++
        console.log(`ok - ${name}`)
    } catch (err) {
        console.error(`FAIL - ${name}`)
        console.error(err)
        process.exit(1)
    }
}

async function main() {
    await check('0-format and 233-format canonicalize to the same value', () => {
        const a = normalizeRecipient('0241234567')
        const b = normalizeRecipient('233241234567')
        assert.ok(a.ok && b.ok)
        if (a.ok && b.ok) {
            assert.equal(a.phone, '0241234567')
            assert.equal(b.phone, '0241234567')
            assert.equal(a.carrier, 'MTN')
        }
    })

    await check('inner whitespace is stripped, canonical output has none', () => {
        const r = normalizeRecipient(' 024 123\t4567 ')
        assert.ok(r.ok)
        if (r.ok) assert.equal(r.phone, '0241234567')
    })

    await check('whitespace padding beyond the raw length cap is rejected', () => {
        assert.equal(normalizeRecipient('0241234567' + ' '.repeat(100000)).ok, false)
    })

    await check('non-strings, empty, garbage and short numbers are rejected', () => {
        for (const v of [undefined, null, 5, {}, [], '', 'abc', '024123456', '02412345678', '+233241234567', '0241234567abc']) {
            assert.equal(normalizeRecipient(v as unknown).ok, false, String(v))
        }
    })

    await check('unknown prefix (landline / invalid) is rejected', () => {
        assert.equal(normalizeRecipient('0301234567').ok, false)
        assert.equal(normalizeRecipient('0001234567').ok, false)
    })

    await check('carrier detection covers all three networks', () => {
        const mtn = normalizeRecipient('0551234567')
        const tel = normalizeRecipient('0201234567')
        const at = normalizeRecipient('0261234567')
        assert.ok(mtn.ok && tel.ok && at.ok)
        if (mtn.ok && tel.ok && at.ok) {
            assert.equal(mtn.carrier, 'MTN')
            assert.equal(tel.carrier, 'Telecel')
            assert.equal(at.carrier, 'AirtelTigo')
        }
    })

    await check('both AT package networks map to AirtelTigo', () => {
        assert.equal(carrierForPackageNetwork('AT-iShare'), 'AirtelTigo')
        assert.equal(carrierForPackageNetwork('AT-BigTime'), 'AirtelTigo')
        assert.equal(carrierForPackageNetwork('MTN'), 'MTN')
        assert.equal(carrierForPackageNetwork('Telecel'), 'Telecel')
    })

    await check('recipient/package network matching', () => {
        assert.equal(recipientMatchesPackage('MTN', 'MTN'), true)
        assert.equal(recipientMatchesPackage('Telecel', 'MTN'), false)
        assert.equal(recipientMatchesPackage('AirtelTigo', 'AT-iShare'), true)
        assert.equal(recipientMatchesPackage('AirtelTigo', 'AT-BigTime'), true)
        assert.equal(recipientMatchesPackage('MTN', 'AT-BigTime'), false)
    })

    await check('blacklist variants cover every stored spelling', () => {
        assert.deepEqual(blacklistVariants('0241234567'), ['0241234567', '233241234567', '+233241234567'])
    })

    await check('blacklist hit is found whichever spelling the admin stored', async () => {
        for (const stored of ['0241234567', '233241234567', '+233241234567']) {
            const client = {
                from: () => ({ select: () => ({ in: async () => ({ data: [{ phone_number: stored }], error: null }) }) }),
            }
            const r = await findBlacklistedRecipients(client, ['0241234567', '0551234567'])
            assert.ok(r.ok)
            if (r.ok) {
                assert.equal(r.blocked.has('0241234567'), true, stored)
                assert.equal(r.blocked.has('0551234567'), false)
            }
        }
    })

    await check('blacklist lookup error fails CLOSED', async () => {
        const client = {
            from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'boom' } }) }) }),
        }
        const origError = console.error
        console.error = () => {}
        try {
            const r = await findBlacklistedRecipients(client, ['0241234567'])
            assert.equal(r.ok, false)
        } finally {
            console.error = origError
        }
    })

    await check('blacklist lookup is chunked (no oversized IN list)', async () => {
        const sizes: number[] = []
        const client = {
            from: () => ({ select: () => ({ in: async (_c: string, vals: string[]) => { sizes.push(vals.length); return { data: [], error: null } } }) }),
        }
        const phones = Array.from({ length: 250 }, (_, i) => `024${String(1000000 + i)}`)
        const r = await findBlacklistedRecipients(client, phones)
        assert.ok(r.ok)
        assert.equal(sizes.length, 3)
        assert.ok(sizes.every(n => n <= 300))
    })

    await check('reference codes: bounded charset, no wildcards/whitespace/control chars', () => {
        assert.equal(isValidReferenceCode('GHD-MG1ABC-X7Y2Z9'), true)
        for (const v of ['', 'short', 'has space here', 'under_score', '100%match', 'a'.repeat(98), 'new\nline1', 5, null, undefined]) {
            assert.equal(isValidReferenceCode(v), false, String(v))
        }
        assert.equal(isValidBatchReference('GHD-MG1ABC-X7Y2Z9'), true)
        assert.equal(isValidBatchReference('a'.repeat(81)), false)
        assert.equal(isValidBatchReference('under_score'), false)
    })

    console.log(`\n${passed} checks passed`)
}

main()
