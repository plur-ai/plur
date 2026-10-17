// LRN-7: When an AI checker is configured, saying a real duplicate is merged or
// skipped, and a different-but-similar statement is saved as its own memory.
//
// (Replaces LRN-3. Owner decision 2026-10-17: duplicate handling is promised
// only with a language model configured. The similarity-ranking measurement
// LRN-3 used is kept as a diagnostic: evals/diagnostics/learn_duplicate_score_auc.test.ts.)
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
// each save, over the frozen labelled pairs in evals/gold/recall-v1 (dev) and
// the private holdout when PLUR_EVAL_HOLDOUT_DIR is set:
//  * duplicate pair: right when ONE active memory remains (the new statement
//    was skipped, or merged/updated into the existing one). Two memories is a
//    MISSED DUPLICATE.
//  * different-but-similar pair: right when TWO active memories remain, the
//    existing one with its text unchanged and the new one saved as said.
//    Anything else (one memory, or the existing text rewritten) is a FALSE MERGE.
// A pair where the checker could not answer (dedup fell back from `llm`) is
// "could not tell" and fails the run — an outage is not a decision. The
// outcome classification is proven with a scripted checker in
// helpers/dedup-outcome.unit.test.ts.
//
// Floors: NOT SET. The owner has not chosen the highest acceptable false-merge
// and missed-duplicate rates; the literals below are placeholders that fail
// after the rates are measured and printed (`decide:` in promises.yaml).
import { afterAll, describe, expect, it } from 'vitest'
import { authEnv, claudeLlm, logReport, requireEnabled } from '../helpers/agent-behaviour-harness.js'
import { inBatches, judgeDedupOutcome } from '../helpers/dedup-outcome.js'
import { fmt, goldSet, holdoutConfigured, rate } from '../helpers/quality.js'

/** Highest acceptable false-merge rate — PLACEHOLDER until the owner sets it. */
const MAX_FALSE_MERGE_RATE: number | null = null
/** Highest acceptable missed-duplicate rate — PLACEHOLDER until the owner sets it. */
const MAX_MISSED_DUPLICATE_RATE: number | null = null

const PARALLEL = 4
const TIMEOUT = 90 * 60_000

const reports: string[] = []
afterAll(() => { if (reports.length) logReport(reports.join('\n')) })

describe('LRN-7 with an AI checker, a real duplicate is merged or skipped and a similar-but-different statement is kept', () => {
  for (const which of ['dev', ...(holdoutConfigured() ? ['holdout'] as const : [])] as const) {
    it(`${which} set: false merges and missed duplicates, from what is stored after each save`, async () => {
      requireEnabled()
      const llm = claudeLlm(authEnv())
      const pairs = goldSet(which).pairs
      expect(pairs.filter(p => p.label === 'duplicate').length, 'precondition: the set has duplicate pairs').toBeGreaterThan(0)
      expect(pairs.filter(p => p.label === 'distinct').length, 'precondition: the set has different-but-similar pairs').toBeGreaterThan(0)

      const judged = await inBatches(pairs, PARALLEL, p => judgeDedupOutcome(p, llm, 'real'))

      const unknown = judged.filter(j => j.outcome === 'could-not-tell')
      expect(unknown.map(j => `${j.pair.id}: ${j.detail}`),
        `could not tell: the checker did not answer for ${unknown.length} pair(s)`).toEqual([])

      const dups = judged.filter(j => j.pair.label === 'duplicate')
      const distinct = judged.filter(j => j.pair.label === 'distinct')
      const missed = dups.filter(j => j.outcome !== 'one-memory')
      const falseMerge = distinct.filter(j => j.outcome !== 'kept-separate')
      const missedRate = rate(missed.length, dups.length, missed.map(j => j.pair.id))
      const falseMergeRate = rate(falseMerge.length, distinct.length, falseMerge.map(j => j.pair.id))
      const neverShown = judged.filter(j => j.asked === 0).map(j => j.pair.id)

      // Item ids and rates only — never pair text (the holdout is private).
      const text = [
        `LRN-7 ${which} set (${pairs.length} pairs):`,
        `  missed duplicates: ${fmt(missedRate)} — ${missed.map(j => `${j.pair.id} [${j.detail}]`).join(', ') || 'none'}`,
        `  false merges: ${fmt(falseMergeRate)} — ${falseMerge.map(j => `${j.pair.id} [${j.detail}]`).join(', ') || 'none'}`,
        `  pairs the checker was never shown (no candidate found): ${neverShown.join(', ') || 'none'}`,
      ].join('\n')
      reports.push(text)

      expect(MAX_FALSE_MERGE_RATE, `the owner has not set the highest acceptable false-merge rate (placeholder).\n${text}`).not.toBeNull()
      expect(MAX_MISSED_DUPLICATE_RATE, `the owner has not set the highest acceptable missed-duplicate rate (placeholder).\n${text}`).not.toBeNull()
      expect(falseMergeRate.rate, `false merges above the owner's ceiling.\n${text}`).toBeLessThanOrEqual(MAX_FALSE_MERGE_RATE!)
      expect(missedRate.rate, `missed duplicates above the owner's ceiling.\n${text}`).toBeLessThanOrEqual(MAX_MISSED_DUPLICATE_RATE!)
    }, TIMEOUT)
  }
})
