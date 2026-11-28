// INJ-2: What my agent is given never goes over the space I set for it.
//
// "Space" is the injection budget, in tokens. The eval measures what the agent
// actually receives — the rendered text of every section — with a fixed rule
// written here, not with PLUR's own estimator: one token per 4 characters,
// rounded up. (The owner may change the rule; it must stay a literal.)
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { renderedText } from '../helpers/corrections-inject-feedback-util.js'

const CHARS_PER_TOKEN = 4
const measuredTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)

// The task names no single service: under INJ-1 a near-copy written for another
// service than the one a task names is a nearby rule that does not apply, so a
// task naming one service would be given only that service's practices. (Setup
// restated 2026-11-28 with the owner's approval; the promise and checks are unchanged.)
const TASK = 'deploy our finance services to production'
const SERVICES = ['billing', 'invoicing', 'ledger', 'payments', 'refunds', 'payouts', 'tax', 'pricing']
// Each practice is long enough that the 20 memories unified injection hands
// over at most (its recall limit) still need far more than 900 tokens, so the
// budget binds in both selection modes. (Setup restated 2026-11-24 with the
// owner's approval when unified injection became the default; the promise and
// its checks are unchanged.)
const PRACTICES = [
  'with blue-green rollouts and a manual smoke test before switching traffic, keeping the old colour warm for an hour and writing the switch time, the build number and the person who switched into the release log',
  'only after the database migration has run on the staging copy first, has been timed against a copy of last night\'s data, and its down-migration has been tried once so the way back is known to work',
  'behind a feature flag that defaults to off for every existing customer, with the flag owner named in the change request and a date by which the flag is either turned on for everyone or removed',
  'during the morning window so the on-call engineer is awake and watching, the support lead has been told what changes for users, and nobody else is deploying a dependent service at the same time',
  'with the error budget dashboard open and the rollback command ready to paste, a second engineer watching the logs, and a written note of which alert would make you roll back without a discussion',
]

describe('INJ-2 the injection never exceeds the budget I set', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const path of ['inject', 'injectHybrid'] as const) {
    it(`many relevant memories, tight budgets (${path})`, async () => {
      s = await tempStore({ embedder: 'bag-of-words' })
      // 40 distinct memories, every one relevant to the task.
      for (const svc of SERVICES) {
        for (const p of PRACTICES) {
          await s.plur.learn(`Deploy the ${svc} service to production ${p}. Afterwards, check the ${svc} service's own health page and its two busiest endpoints for ten minutes before calling the deployment done.`, { scope: 'global' })
        }
      }
      expect((await s.plur.list()).length, 'precondition: 40 memories are stored').toBe(40)

      // Precondition: with room to spare, the relevant memories need far more
      // space than the tight budgets below — so the budget really has to bind.
      const roomy = await s.plur[path](TASK, { budget: 20000 })
      const roomyTokens = measuredTokens(renderedText(roomy))
      expect(roomyTokens, `precondition: unconstrained, the relevant memories take more than 900 tokens, well over the 600 budget below (took ${roomyTokens})`)
        .toBeGreaterThan(900)

      for (const budget of [150, 300, 600]) {
        const r = await s.plur[path](TASK, { budget })
        const text = renderedText(r)
        const seen = measuredTokens(text)
        expect(r.count, `budget ${budget}: the agent was given nothing at all, so the limit was never tested`)
          .toBeGreaterThan(0)
        expect(seen, `budget ${budget}: the agent received ${text.length} characters (~${seen} tokens), over the budget`)
          .toBeLessThanOrEqual(budget)
        expect(r.tokens_used, `budget ${budget}: PLUR reports using ${r.tokens_used} tokens, over the budget`)
          .toBeLessThanOrEqual(budget)
      }
    })
  }
})
