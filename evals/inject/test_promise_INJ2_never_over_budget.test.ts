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

const TASK = 'deploy the billing service to production'
const SERVICES = ['billing', 'invoicing', 'ledger', 'payments', 'refunds', 'payouts', 'tax', 'pricing']
const PRACTICES = [
  'with blue-green rollouts and a manual smoke test before switching traffic',
  'only after the database migration has run on the staging copy first',
  'behind a feature flag that defaults to off for every existing customer',
  'during the morning window so the on-call engineer is awake and watching',
  'with the error budget dashboard open and the rollback command ready to paste',
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
          await s.plur.learn(`Deploy the ${svc} service to production ${p}.`, { scope: 'global' })
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
