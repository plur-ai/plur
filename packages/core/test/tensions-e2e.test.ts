/**
 * End-to-end tension detection regression test.
 *
 * Exercises the full flow: learn engrams → getCandidatePairs → scanForTensions.
 * Uses a deterministic mock LLM (no network calls).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'
import { getCandidatePairs, scanForTensions } from '../src/tensions.js'
import type { LlmFunction } from '../src/types.js'

function newDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-e2e-'))
}

/** Mock LLM that detects contradictions when both statements mention the same subject. */
function makeMockLlm(): LlmFunction {
  return async (prompt: string): Promise<string> => {
    // Extract the two statements from the prompt. The label may carry a
    // "(recorded YYYY-MM-DD)" annotation when dates are derivable (#240).
    const stmtA = prompt.match(/STATEMENT A \[.*?\][^:]*:\s*"([^"]+)"/)?.[1] ?? ''
    const stmtB = prompt.match(/STATEMENT B \[.*?\][^:]*:\s*"([^"]+)"/)?.[1] ?? ''

    // Simple heuristic: if both mention a shared keyword and make different assertions, flag it
    const wordsA = new Set(stmtA.toLowerCase().split(/\W+/).filter(w => w.length > 4))
    const wordsB = new Set(stmtB.toLowerCase().split(/\W+/).filter(w => w.length > 4))
    let overlap = 0
    for (const w of wordsA) if (wordsB.has(w)) overlap++

    if (overlap >= 2) {
      return 'CONTRADICTS: yes\nCONFIDENCE: 0.92\nREASON: Both statements make assertions about the same subject but with different claims.'
    }
    return 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Different topics.'
  }
}

describe('tension detection e2e', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = newDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('detects contradictory engrams through the full pipeline', async () => {
    // Learn two contradictory facts about PLUR storage format
    plur.learn('PLUR engrams storage uses individual JSON files per engram', {
      type: 'architectural',
      domain: 'plur.storage',
    })
    plur.learn('PLUR engrams storage uses a single YAML file for all engrams', {
      type: 'architectural',
      domain: 'plur.storage',
    })

    const engrams = plur.list()
    expect(engrams).toHaveLength(2)

    // Stage 1: getCandidatePairs should find them (same scope, same domain, overlapping subjects)
    const pairs = getCandidatePairs(engrams)
    expect(pairs.length).toBeGreaterThanOrEqual(1)
    const ids = pairs[0].map(e => e.id).sort()
    expect(ids).toEqual(engrams.map(e => e.id).sort())

    // Stage 2: scanForTensions with mock LLM should detect the contradiction
    const result = await scanForTensions(engrams, makeMockLlm())
    expect(result.pairs_checked).toBeGreaterThanOrEqual(1)
    expect(result.new_tensions).toBe(1)
    expect(result.tensions[0].confidence).toBeGreaterThanOrEqual(0.7)
    expect(result.tensions[0].reason).toBeTruthy()
  })

  it('does not flag unrelated engrams in different domains', async () => {
    plur.learn('PLUR uses YAML for engram storage', {
      type: 'architectural',
      domain: 'plur.storage',
    })
    plur.learn('Bitcoin price dropped 5% after the Fed announcement', {
      type: 'behavioral',
      domain: 'markets.crypto',
    })

    const engrams = plur.list()
    const pairs = getCandidatePairs(engrams)

    // Different domains, no domain segment overlap → filtered out before LLM
    expect(pairs).toHaveLength(0)
  })

  it('does not flag complementary facts in the same domain', async () => {
    plur.learn('PLUR supports BM25 keyword search for engram retrieval', {
      type: 'architectural',
      domain: 'plur.search',
    })
    plur.learn('PLUR supports BGE embedding vectors for semantic similarity', {
      type: 'architectural',
      domain: 'plur.search',
    })

    const engrams = plur.list()
    const pairs = getCandidatePairs(engrams)

    // These may pass pre-filtering (same domain, shared "plur" token)
    // but the mock LLM should NOT flag them — different subjects (BM25 vs BGE)
    if (pairs.length > 0) {
      const result = await scanForTensions(engrams, makeMockLlm())
      // The mock LLM checks for 2+ shared words — "plur" alone isn't enough
      // Real LLM would correctly identify these as complementary, not contradictory
      expect(result.new_tensions).toBe(0)
    }
  })

  it('filters out cross-scope pairs', async () => {
    plur.learn('Deploy to production on Fridays', {
      type: 'behavioral',
      domain: 'ops.deploy',
      scope: 'project:alpha',
    })
    plur.learn('Never deploy to production on Fridays', {
      type: 'behavioral',
      domain: 'ops.deploy',
      scope: 'project:beta',
    })

    const engrams = plur.list()
    const pairs = getCandidatePairs(engrams)

    // Different project scopes → filtered out (conservative rule)
    expect(pairs).toHaveLength(0)
  })

  it('global engrams can conflict with project-scoped engrams', async () => {
    plur.learn('Default timeout for API requests is 30 seconds', {
      type: 'architectural',
      domain: 'plur.api',
      // Explicit 'global' — this test is about global-vs-project overlap, not the
      // unscoped default (which is now 'local' as of Stage 3b, #351).
      scope: 'global',
    })
    plur.learn('Default timeout for API requests is 60 seconds', {
      type: 'architectural',
      domain: 'plur.api',
      scope: 'project:plur',
    })

    const engrams = plur.list()
    const pairs = getCandidatePairs(engrams)

    // Global + project:plur → should overlap (global is universal)
    expect(pairs.length).toBeGreaterThanOrEqual(1)

    const result = await scanForTensions(engrams, makeMockLlm())
    expect(result.new_tensions).toBe(1)
  })

  // Phase 2 (#180): candidate pairs are ranked by shared-token overlap so the
  // most likely contradictions are checked first even when max_pairs truncates.
  it('ranks candidate pairs by overlap score, not insertion order (#180)', () => {
    // Learn 3 engrams: A and C contradict (high overlap), B is unrelated but inserted between them
    plur.learn('PLUR storage format uses JSON files', { domain: 'plur.storage' })
    plur.learn('PLUR search uses hybrid BM25 plus embeddings', { domain: 'plur.search' })
    plur.learn('PLUR storage format uses YAML not JSON', { domain: 'plur.storage' })

    const engrams = plur.list()
    const pairs = getCandidatePairs(engrams)

    const pairIds = pairs.map(([a, b]) => [a.id, b.id].sort().join(':'))
    expect(pairIds.length).toBeGreaterThanOrEqual(1)

    // The contradictory storage pair has the highest token overlap → must be first
    const storageEngrams = engrams.filter(e => e.domain === 'plur.storage')
    expect(storageEngrams).toHaveLength(2)
    const targetPair = storageEngrams.map(e => e.id).sort().join(':')
    expect(pairIds[0]).toBe(targetPair)
  })
})
