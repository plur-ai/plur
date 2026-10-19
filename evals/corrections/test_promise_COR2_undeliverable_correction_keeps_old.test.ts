// COR-2: If the correction itself cannot be delivered (a draft, expired, or not
// available here), the old memory is still given rather than nothing.
//
// "Not available here" has its natural reading (audit A-01): a correction kept
// in another project is not available in mine, whether the injection names an
// allow-list of scopes or selects scopes the ordinary way (by the scope I work
// in). The last case covers the ordinary way.
import { afterEach, describe, expect, it } from 'vitest'
import type { LearnContext } from '../../packages/core/src/types.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'

// Each case saves a correction the agent may not be given, and an optional
// injection restriction that makes it "not available here".
const cases: Array<{ name: string; correction: LearnContext; inject?: { scopes?: string[]; scope?: string } }> = [
  { name: 'the correction is a draft awaiting approval',
    correction: { scope: 'global', commitment: 'draft' } },
  { name: 'the correction has expired',
    correction: { scope: 'global', valid_until: '2020-01-31' } },
  { name: 'the correction is not valid yet',
    correction: { scope: 'global', valid_from: '2999-01-01' } },
  { name: 'the correction lives in a scope this injection may not read',
    correction: { scope: 'project:other' }, inject: { scopes: ['global'] } },
  { name: 'the correction lives in another project and I inject in mine (ordinary scope selection)',
    correction: { scope: 'project:other' }, inject: { scope: 'project:mine' } },
]

describe('COR-2 an undeliverable correction leaves the old memory in place', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const c of cases) {
    for (const path of ['inject', 'injectHybrid'] as const) {
      it(`${c.name} (${path})`, async () => {
        s = await tempStore({ embedder: 'bag-of-words' })
        const old = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
        // Precondition: before any correction exists, this injection does give
        // the old memory, so it really is available here.
        const before = given(await s.plur[path](TASK, { budget: 4000, ...c.inject }))
        expect(before, `precondition: before the correction, the agent is given the old memory here; it got ${JSON.stringify(before)}`)
          .toContain(old.id)
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
