/**
 * LLM dedup circuit breaker under interleaved calls (convergence Phase 2).
 *
 * The breaker used to be a counter that `recordLlmSuccess()` set to zero. The
 * sequence around it —
 *
 *     isLlmAvailable()  →  await llm(prompt)  →  record{Success,Failure}()
 *
 * is a read-modify-write straddling an `await`, so with more than one call in
 * flight a success returning from ONE call erases failures the OTHERS just
 * recorded. The breaker then never trips, however consistently the LLM is
 * failing, and every subsequent call keeps paying for a doomed round-trip.
 *
 * The tests below interleave failing and succeeding calls on purpose. Awaiting
 * them in sequence would pass either way — the old counter only loses when a
 * success lands between two failures of a DIFFERENT in-flight call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'

describe('LLM dedup circuit breaker — concurrent calls', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-llm-breaker-'))
    plur = new Plur({ path: dir })
    // Seed so semantic recall finds candidates and the LLM path is reached.
    await plur.learn('Deploy using the blue green strategy for zero downtime', { tags: ['deploy'] })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('trips after 3 failures even when successes interleave', async () => {
    // An LLM that fails for "staging/production/testing" and succeeds for
    // "canary/preview" — the successes are what used to reset the counter.
    const calls: string[] = []
    const llm = vi.fn(async (prompt: string) => {
      calls.push(prompt)
      if (/staging|production|testing/.test(prompt)) throw new Error('API timeout')
      return 'DECISION: ADD'
    })

    const statements = [
      'Deploy using the blue green strategy for staging',   // fail
      'Deploy using the blue green strategy for canary',    // ok
      'Deploy using the blue green strategy for production', // fail
      'Deploy using the blue green strategy for preview',   // ok
      'Deploy using the blue green strategy for testing',   // fail
    ]

    // Interleaved, not sequential: each call suspends at its own await, so the
    // successes land between the failures of other in-flight calls.
    await Promise.all(
      statements.map((s, i) => (async () => {
        for (let k = 0; k < i; k++) await new Promise(r => setImmediate(r))
        return await plur.learnAsync(s, { llm })
      })()),
    )

    // Three failures inside the window must have tripped it: the next call
    // skips the LLM entirely.
    const before = llm.mock.calls.length
    await plur.learnAsync('Deploy using the blue green strategy for QA', { llm })
    expect(llm.mock.calls.length).toBe(before)
  })

  it('a success does not erase failures recorded before it', async () => {
    // Each round needs a real BM25 candidate or learnAsync short-circuits to
    // ADD without ever calling the LLM. Give every round its own discriminating
    // term, present in exactly one seed, so the match does not depend on how
    // the corpus has grown.
    const rounds = ['alpha', 'beta', 'delta', 'gamma', 'omega']
    for (const r of rounds) {
      await plur.learn(`The ${r} rollout convention is blue green with zero downtime`, { tags: [r] })
    }

    // Outcome per call, not per prompt: `buildDedupPrompt` embeds the candidate
    // statements, so a content-matched mock starts failing on rounds it was
    // meant to pass once earlier rounds appear among the candidates.
    const outcomes = ['fail', 'fail', 'ok', 'fail']
    let call = 0
    const llm = vi.fn(async () => {
      const outcome = outcomes[call++]
      if (outcome === 'fail') throw new Error('API timeout')
      return 'DECISION: ADD'
    })

    // Two failures, then a success, then a third failure — the ordering the
    // old counter's reset made harmless. Each step asserts the LLM was actually
    // reached, so the test cannot pass vacuously by never entering that path.
    for (const r of ['alpha', 'beta', 'delta', 'gamma']) {
      const before = llm.mock.calls.length
      await plur.learnAsync(`The ${r} rollout convention is blue green with zero downtime and no drift`, { llm })
      expect(llm.mock.calls.length, `LLM path not reached for ${r}`).toBe(before + 1)
    }

    // Three failures happened; the intervening success must not have wiped
    // them, so the breaker is open.
    const before = llm.mock.calls.length
    await plur.learnAsync('The omega rollout convention is blue green with zero downtime and no drift', { llm })
    expect(llm.mock.calls.length).toBe(before)
  })

  it('does not trip when the LLM is healthy', async () => {
    const llm = vi.fn(async () => 'DECISION: ADD')
    for (const s of ['one', 'two', 'three', 'four']) {
      await plur.learnAsync(`Deploy using the blue green strategy for ${s}`, { llm })
    }
    const before = llm.mock.calls.length
    await plur.learnAsync('Deploy using the blue green strategy for five', { llm })
    expect(llm.mock.calls.length).toBeGreaterThan(before)
  })
})
