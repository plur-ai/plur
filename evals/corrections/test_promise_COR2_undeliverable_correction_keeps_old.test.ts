// COR-2: If the correction itself cannot be delivered (a draft, expired, or not
// available here), the old memory is still given rather than nothing.
import { afterEach, describe, expect, it } from 'vitest'
import type { LearnContext } from '../../packages/core/src/types.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'

// Each case saves a correction the agent may not be given, and an optional
// injection restriction that makes it "not available here".
const cases: Array<{ name: string; correction: LearnContext; inject?: { scopes?: string[] } }> = [
  { name: 'the correction is a draft awaiting approval',
    correction: { scope: 'global', commitment: 'draft' } },
  { name: 'the correction has expired',
    correction: { scope: 'global', valid_until: '2020-01-31' } },
  { name: 'the correction is not valid yet',
    correction: { scope: 'global', valid_from: '2999-01-01' } },
  { name: 'the correction lives in a scope this injection may not read',
    correction: { scope: 'project:other' }, inject: { scopes: ['global'] } },
]

describe('COR-2 an undeliverable correction leaves the old memory in place', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const c of cases) {
    for (const path of ['inject', 'injectHybrid'] as const) {
      it(`${c.name} (${path})`, async () => {
        s = await tempStore({ embedder: 'bag-of-words' })
        const old = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
        const fix = await s.plur.learn('Deploy the billing service with canary rollouts, not blue-green',
          { ...c.correction, supersedes: [old.id] })

        // Precondition: the correction really is linked to the old memory, so a
        // delivered correction WOULD replace it (COR-1). Without the link this
        // case would pass for the wrong reason.
        const stored = await s.plur.getById(old.id)
        expect(stored?.relations?.superseded_by ?? [], 'precondition: the old memory records the correction that replaces it')
          .toContain(fix.id)

        const r = await s.plur[path](TASK, { budget: 4000, ...c.inject })
        const ids = given(r)
        expect(ids, `the correction could not be delivered here, yet the agent was given it: ${JSON.stringify(ids)}`)
          .not.toContain(fix.id)
        expect(ids, `the agent was given neither the correction nor the old memory (${old.id}); it got ${JSON.stringify(ids)}`)
          .toContain(old.id)
      })
    }
  }
})
