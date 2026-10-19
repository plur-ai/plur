// PRV-4: When PLUR picks a scope for an unscoped memory, it never files it into a shared team scope on its own.
//
// Two stores declare what they cover: a team store (shared scope) covering
// billing, and a personal store covering travel. An unscoped billing memory
// matches the team store strongly, yet must not be filed there. The travel
// memory is the control: it proves the router is active and does file an
// unscoped memory into a matching personal scope.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { useEmbedder } from '../helpers/store.js'

const TEAM = 'group:acme/billing'
const PERSONAL = 'user:me-travel'

describe('PRV-4 auto-routing never files an unscoped memory into a shared team scope', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

  for (const method of ['learn', 'learnRouted'] as const) it(`${method}() with no scope: a strong team-store match is not taken, a personal-store match is`, async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-eval-prv4-'))
    writeFileSync(join(dir, 'config.yaml'), [
      'index: false',
      'embeddings:',
      '  enabled: false',
      'stores:',
      `  - path: "${join(dir, 'team-billing.yaml')}"`,
      `    scope: "${TEAM}"`,
      '    description: Billing team',
      '    covers: ["billing.*", "invoices", "billing"]',
      `  - path: "${join(dir, 'my-travel.yaml')}"`,
      `    scope: "${PERSONAL}"`,
      '    description: My travel notes',
      '    covers: ["travel.*", "flights", "travel"]',
      '',
    ].join('\n'))
    useEmbedder('off')
    const plur = new Plur({ path: dir, autoDiscover: false })

    const control = await plur[method]('book flights for travel with the cheapest refundable fare', {
      domain: 'travel.flights', tags: ['flights', 'travel'],
    })
    expect(control.scope, 'precondition: the router files an unscoped travel memory into the matching personal store').toBe(PERSONAL)

    const billing = await plur[method]('billing invoices are sent on the first working day of the month', {
      domain: 'billing.invoices', tags: ['invoices', 'billing'],
    })
    expect(billing.scope, `expected the unscoped billing memory to stay out of the shared team scope ${TEAM}; it was filed into ${billing.scope}`).not.toBe(TEAM)
    expect(billing.scope.startsWith('group:'), `expected no shared team scope at all; got ${billing.scope}`).toBe(false)
    const teamRows = (await plur.list()).filter(e => e.scope === TEAM)
    expect(teamRows.map(e => e.statement), 'nothing may have been written into the team scope').toEqual([])
  })
})
