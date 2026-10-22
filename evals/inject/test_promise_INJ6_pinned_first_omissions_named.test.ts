// INJ-6: Pinned memories are given first, up to their share of the space I
// set, and PLUR names any pinned memory it could not fit.
//
// Replaces INJ-3 ("a rule I pinned is always given"), which an unconditional
// budget makes impossible for a large pinned set (audit A-01). The INJ-3 cases
// are kept unchanged below (one pinned rule, roomy budget: it must be given
// even when it does not match the task). The capacity cases are new: ten
// pinned rules under a 150-token budget.
//   * the agent gets no more than the 150 tokens (measured on what it receives,
//     one token per 4 characters, rounded up — the INJ-2 rule),
//   * every pinned rule that was left out is named, in the core result and in
//     both MCP tool replies,
//   * pinned rules come first, up to their share of the budget (owner decision
//     2026-10-19), and the memories matching the task get the rest.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, useEmbedder, type TempStore } from '../helpers/store.js'
import { given, renderedText } from '../helpers/corrections-inject-feedback-util.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'

const CHARS_PER_TOKEN = 4
const measuredTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)
const BUDGET = 150
// Ten pinned rules, none sharing a word with the task.
const PINNED_RULES = [
  'Always greet returning visitors warmly by their first name',
  'Always reply to support emails within one working day',
  'Always write commit messages in the imperative mood',
  'Always keep meeting notes in the shared notebook folder',
  'Always label screenshots with their capture date',
  'Always cc the office manager on travel bookings',
  'Always book meeting rooms at least a day ahead',
  'Always spell out acronyms on their first use in reports',
  'Always archive closed tickets after thirty days',
  'Always water the lobby plants on Thursday mornings',
]

const TASK = 'deploy the billing service to production'

describe('INJ-6 (kept from INJ-3) a pinned rule is given even when the task does not match it', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const path of ['inject', 'injectHybrid'] as const) {
    for (const how of ['pinned when saved', 'pinned afterwards'] as const) {
      it(`${how} (${path})`, async () => {
        s = await tempStore({ embedder: 'bag-of-words' })
        // Memories that DO match the task, competing for the same space.
        for (let i = 1; i <= 6; i++) {
          await s.plur.learn(`Deploy the billing service to production in step ${i} of the release checklist`,
            { scope: 'project:alpha' })
        }
        // Rules that share no word with the task (not even "the"): one pinned, one twin not pinned.
        const pinnedText = 'Never mention customer names unless users raise them first'
        const rule = how === 'pinned when saved'
          ? await s.plur.learn(pinnedText, { scope: 'project:alpha', pinned: true })
          : await s.plur.learn(pinnedText, { scope: 'project:alpha' })
        if (how === 'pinned afterwards') {
          const updated = await s.plur.setPinned(rule.id, true)
          expect(updated?.pinned, 'precondition: setPinned reports the rule as pinned').toBe(true)
        }
        const twin = await s.plur.learn('Always greet returning visitors warmly by their first name',
          { scope: 'project:alpha' })

        const r = await s.plur[path](TASK, { scope: 'project:alpha', budget: 2000 })
        const ids = given(r)
        // Preconditions: the injection is working, and an equally unrelated
        // rule that is NOT pinned is left out — so the task really does not match.
        expect(r.count, 'precondition: the agent was given the memories that match the task').toBeGreaterThan(0)
        expect(ids, 'precondition: an unrelated rule that is not pinned is not given, so the task does not match it')
          .not.toContain(twin.id)

        expect(ids, `the pinned rule ${rule.id} was not given to the agent in its scope; it was given ${JSON.stringify(ids)}`)
          .toContain(rule.id)
      })
    }
  }
})

async function seedCapacity(s: TempStore | McpSession): Promise<{ pinned: string[]; unpinned: string[] }> {
  const unpinned: string[] = []
  for (let i = 1; i <= 6; i++) {
    unpinned.push((await s.plur.learn(`Deploy the billing service to production in step ${i} of the release checklist`,
      { scope: 'project:alpha' })).id)
  }
  const pinned: string[] = []
  for (const rule of PINNED_RULES) pinned.push((await s.plur.learn(rule, { scope: 'project:alpha', pinned: true })).id)
  return { pinned, unpinned }
}

describe('INJ-6 ten pinned rules under a 150-token budget', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const path of ['inject', 'injectHybrid'] as const) {
    it(`stays within budget and names every pinned rule it left out (${path})`, async () => {
      s = await tempStore({ embedder: 'bag-of-words' })
      const { pinned } = await seedCapacity(s)
      const r = await s.plur[path](TASK, { scope: 'project:alpha', budget: BUDGET })
      const ids = given(r)
      const left = pinned.filter(id => !ids.includes(id))
      expect(r.count, 'precondition: the agent was given something, so the limit was tested').toBeGreaterThan(0)
      expect(left.length, `precondition: ten pinned rules do not all fit in ${BUDGET} tokens, so capacity really binds (all were given)`)
        .toBeGreaterThan(0)
      const seen = measuredTokens(renderedText(r))
      expect(seen, `the agent received ~${seen} tokens, over the ${BUDGET} I set`).toBeLessThanOrEqual(BUDGET)
      expect(r.tokens_used, `PLUR reports using ${r.tokens_used} tokens, over the ${BUDGET} I set`).toBeLessThanOrEqual(BUDGET)
      const named = (r.omitted_pinned ?? []).map(o => o.id)
      const silent = left.filter(id => !named.includes(id))
      expect(silent, `${silent.length} of the ${left.length} pinned rules left out were not named as left out (named: ${JSON.stringify(named)})`)
        .toEqual([])
    })

    it(`pinned rules come first, up to their share, and the task still gets room (${path})`, async () => {
      // Owner decision 2026-10-19: pinned memories are capped at their share of the
      // budget (injection.pinned_ratio, default half), so a large pinned set cannot
      // crowd out the memories that match the task.
      s = await tempStore({ embedder: 'bag-of-words' })
      const { pinned, unpinned } = await seedCapacity(s)
      const r = await s.plur[path](TASK, { scope: 'project:alpha', budget: BUDGET })
      const ids = given(r)
      const left = pinned.filter(id => !ids.includes(id))
      expect(left.length, 'precondition: capacity binds, so some pinned rule is left out').toBeGreaterThan(0)
      const pinnedGiven = pinned.filter(id => ids.includes(id))
      const unpinnedGiven = unpinned.filter(id => ids.includes(id))
      expect(pinnedGiven.length, 'no pinned rule was given at all').toBeGreaterThan(0)
      expect(unpinnedGiven.length, `the pinned rules took the whole budget (${pinnedGiven.length} given); no memory matching the task was given`).toBeGreaterThan(0)
      const lastPinned = Math.max(...pinnedGiven.map(id => ids.indexOf(id)))
      const firstUnpinned = Math.min(...unpinnedGiven.map(id => ids.indexOf(id)))
      expect(lastPinned, `a task memory was given before a pinned rule (order: ${JSON.stringify(ids)})`).toBeLessThan(firstUnpinned)
    })
  }

  for (const tool of ['plur_inject', 'plur_inject_hybrid'] as const) {
    it(`the MCP reply names every pinned rule it left out (${tool})`, async () => {
      useEmbedder('bag-of-words')
      const m = await mcpSession({ profile: 'full' })
      try {
        const { pinned } = await seedCapacity(m)
        const res = await m.call(tool, { task: TASK, scope: 'project:alpha', budget: BUDGET })
        expect(res.isError, `${tool} failed: ${res.text}`).toBe(false)
        const ids: string[] = res.json?.injected_ids ?? []
        const left = pinned.filter(id => !ids.includes(id))
        expect(left.length, `precondition: capacity binds in ${tool}, so some pinned rule is left out`).toBeGreaterThan(0)
        const named = ((res.json?.omitted_pinned ?? []) as Array<{ id: string }>).map(o => o.id)
        const silent = left.filter(id => !named.includes(id))
        expect(silent, `${tool}: ${silent.length} of the ${left.length} pinned rules left out are not named in the reply (named: ${JSON.stringify(named)})`)
          .toEqual([])
      } finally { await m.close() }
    })
  }
})
