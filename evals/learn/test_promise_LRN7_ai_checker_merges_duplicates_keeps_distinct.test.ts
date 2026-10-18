// LRN-7: With an AI checker configured, a real duplicate leaves one active
// memory; a statement that changes a value is saved as its own memory that
// supersedes the old one; a different-but-similar statement on another subject
// stays its own active memory.
//
// (Replaces LRN-3. Owner decision 2026-10-17: duplicate handling is promised
// only with a language model configured. Owner decision 2026-10-18: a changed
// value is "a separate memory that supersedes the previous one". The
// similarity-ranking measurement LRN-3 used is kept as a diagnostic:
// evals/diagnostics/learn_duplicate_score_auc.test.ts.)
//
// kind: agent — every save asks a REAL language model, so it costs money and
// runs only with PLUR_AGENT_EVALS=1; otherwise it FAILS with "agent eval not run
// (set PLUR_AGENT_EVALS=1)". Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY,
// the same path as the agent-behaviour evals (helpers/agent-behaviour-harness.ts).
//
// Configuration under test (named, because the result depends on it): PLUR's
// duplicate check with an LLM — `learnAsync(statement, { llm })`, dedup mode
// `llm` (the default), the shipped embedding model finding the candidates, and
// the checker answering PLUR's own dedup prompt (packages/core/src/dedup.ts) is
// Claude (the harness MODEL) through the claude CLI, with no tools and a
// one-line system prompt. The MCP server itself configures its checker from
// OPENAI_API_KEY / OPENROUTER_API_KEY; the eval passes the function to core,
// which is the same seam those keys feed.
//
// What is graded is the PERSISTED outcome, read back by a fresh instance after
// each save, over the three-label pairs in evals/gold/dedup-v2 (dev) and the
// private holdout's dedup-v2 when PLUR_EVAL_HOLDOUT_DIR is set
// (helpers/dedup-outcome.ts; LABELLER-CHECKLIST.md there):
//  * duplicate: right when one live memory remains with the existing text
//    unchanged (skipped, or saved as a memory that supersedes it). Anything
//    else is a MISSED DUPLICATE.
//  * supersede: right when both are stored, the new statement live and saved as
//    said, the old text unchanged and marked superseded by it. Anything else
//    (the old overwritten, the new dropped, no link, a one-sided link) is a
//    FAILED SUPERSEDE.
//  * distinct: right when two live memories remain, the existing text
//    unchanged and the new one saved as said. Anything else is a FALSE MERGE.
// Rewriting the existing memory's text is wrong under every label.
// A pair where the checker could not answer (dedup fell back from `llm`) is
// "could not tell" and fails the run — an outage is not a decision. The
// classification is proven on hand-built snapshots and a scripted checker in
// helpers/dedup-outcome.unit.test.ts.
//
// Ceilings: 10% each (owner, 2026-10-18). The false-merge rate also needs at
// least MIN_DISTINCT_PAIRS distinct pairs in the set before it counts: with the
// 3 the sets first held, one miss was 33% and no miss proved nothing. Each set
// now holds 20, 17 of them written by a labeller from another model family
// (evals/gold/dedup-v2/LABELLER-CHECKLIST.md); a set that drops below fails as
// "not measurable".
import { afterAll, describe, expect, it } from 'vitest'
import { authEnv, claudeLlm, logReport, requireEnabled } from '../helpers/agent-behaviour-harness.js'
import { inBatches, judgeDedupOutcome } from '../helpers/dedup-outcome.js'
import { dedupPairs, fmt, holdoutConfigured, rate } from '../helpers/quality.js'

/** Highest acceptable false-merge rate (owner, 2026-10-18). */
const MAX_FALSE_MERGE_RATE = 0.1
/** Highest acceptable missed-duplicate rate (owner, 2026-10-18). */
const MAX_MISSED_DUPLICATE_RATE = 0.1
/** Highest acceptable failed-supersede rate (owner, 2026-10-18). */
const MAX_FAILED_SUPERSEDE_RATE = 0.1
/** Fewest distinct pairs for the false-merge rate to mean anything (3 + 17 commissioned). */
const MIN_DISTINCT_PAIRS = 20

const PARALLEL = 4
const TIMEOUT = 90 * 60_000

const reports: string[] = []
afterAll(() => { if (reports.length) logReport(reports.join('\n')) })

describe('LRN-7 with an AI checker, a duplicate leaves one memory, a changed value supersedes, a different subject is kept', () => {
  for (const which of ['dev', ...(holdoutConfigured() ? ['holdout'] as const : [])] as const) {
    it(`${which} set: missed duplicates, failed supersedes and false merges, from what is stored after each save`, async () => {
      requireEnabled()
      const llm = claudeLlm(authEnv())
      const pairs = dedupPairs(which)
      for (const label of ['duplicate', 'supersede', 'distinct'] as const) {
        expect(pairs.filter(p => p.label === label).length, `precondition: the set has ${label} pairs`).toBeGreaterThan(0)
      }

      const judged = await inBatches(pairs, PARALLEL, p => judgeDedupOutcome(p, llm, 'real'))

      const unknown = judged.filter(j => j.outcome === 'could-not-tell')
      expect(unknown.map(j => `${j.pair.id}: ${j.detail}`),
        `could not tell: the checker did not answer for ${unknown.length} pair(s)`).toEqual([])

      const of = (label: string) => judged.filter(j => j.pair.label === label)
      const wrong = (label: string) => of(label).filter(j => !j.right)
      const rateOf = (label: string) => rate(wrong(label).length, of(label).length, wrong(label).map(j => j.pair.id))
      const missedRate = rateOf('duplicate')
      const supersedeRate = rateOf('supersede')
      const falseMergeRate = rateOf('distinct')
      const neverShown = judged.filter(j => j.asked === 0).map(j => j.pair.id)
      const list = (label: string) => wrong(label).map(j => `${j.pair.id} [${j.outcome}: ${j.detail}]`).join(', ') || 'none'

      // Item ids and rates only — never pair text (the holdout is private).
      const text = [
        `LRN-7 ${which} set (${pairs.length} pairs):`,
        `  missed duplicates: ${fmt(missedRate)} — ${list('duplicate')}`,
        `  failed supersedes: ${fmt(supersedeRate)} — ${list('supersede')}`,
        `  false merges: ${fmt(falseMergeRate)} (${of('distinct').length} distinct pairs; at least ${MIN_DISTINCT_PAIRS} needed to measure) — ${list('distinct')}`,
        `  pairs the checker was never shown (no candidate found): ${neverShown.join(', ') || 'none'}`,
      ].join('\n')
      reports.push(text)

      expect(missedRate.rate, `missed duplicates above the owner's ceiling.\n${text}`).toBeLessThanOrEqual(MAX_MISSED_DUPLICATE_RATE)
      expect(supersedeRate.rate, `failed supersedes above the owner's ceiling.\n${text}`).toBeLessThanOrEqual(MAX_FAILED_SUPERSEDE_RATE)
      expect(of('distinct').length, `could not tell: too few distinct pairs to measure false merges.\n${text}`).toBeGreaterThanOrEqual(MIN_DISTINCT_PAIRS)
      expect(falseMergeRate.rate, `false merges above the owner's ceiling.\n${text}`).toBeLessThanOrEqual(MAX_FALSE_MERGE_RATE)
    }, TIMEOUT)
  }
})
