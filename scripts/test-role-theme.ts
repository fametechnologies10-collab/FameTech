import assert from 'node:assert/strict'
import { roleConfig, roleTheme } from '../lib/roles'
import { contrastRatio } from '../lib/ft-palette'

let failed = 0

function check(name: string, fn: () => void) {
    try {
        fn()
        console.log(`ok - ${name}`)
    } catch (err) {
        failed++
        console.error(`FAIL - ${name}`)
        console.error(err)
    }
}

const ROLES = ['admin', 'sub-admin', 'dealer', 'agent', 'subagent', 'customer'] as const
const HEX = /^#[0-9A-F]{6}$/i

check('roleTheme has exactly the six roles', () => {
    assert.deepEqual(Object.keys(roleTheme).sort(), [...ROLES].sort())
})

for (const role of ROLES) {
    const t = roleTheme[role]
    check(`${role} ring/dot are hex`, () => {
        assert.match(t.ring, HEX)
        assert.match(t.dot, HEX)
    })
    check(`${role} chip values are hex`, () => {
        for (const v of [t.chipLight.bg, t.chipLight.text, t.chipDark.bg, t.chipDark.text]) assert.match(v, HEX)
    })
    check(`${role} chipLight text on bg >= 4.5`, () => {
        assert.ok(contrastRatio(t.chipLight.text, t.chipLight.bg) >= 4.5)
    })
    check(`${role} chipDark text on bg >= 4.5`, () => {
        assert.ok(contrastRatio(t.chipDark.text, t.chipDark.bg) >= 4.5)
    })
}

check('roleConfig customer uses FT blue', () => {
    assert.equal(roleConfig.customer.color, '#0057FF')
    assert.equal(roleConfig.customer.bgColor, 'rgba(0, 87, 255, 0.1)')
    assert.equal(roleConfig.customer.textColor, '#0057FF')
})

check('roleConfig other roles unchanged', () => {
    assert.equal(roleConfig.admin.color, '#CA8A04')
    assert.equal(roleConfig['sub-admin'].color, '#DB2777')
    assert.equal(roleConfig.dealer.color, '#C2410C')
    assert.equal(roleConfig.agent.color, '#059669')
    assert.equal(roleConfig.subagent.color, '#65A30D')
})

if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
}
