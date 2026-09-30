// Formal verification round 2, core-retrieval#9 (spec/formal/findings/r2-retrieval.md §3).
//  (a) recallAuto's strategy_used must not say 'hybrid' when no embedding leg contributed.
//  (b) expandedSearch honours the caller's limit on aggregation queries, like every
//      hybrid path since #770 (the floor of 50 is an internal over-fetch only).
// Model: PlurSpec.R2Retrieval.Labels. Offline: stub embedder / embeddings disabled.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recallAuto } from '../src/search-orchestrator.js'
import { expandedSearch } from '../src/query-expansion.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled, embedderStatus } from '../src/embeddings.js'
import { EngramSchema } from '../src/schemas/engram.js'

const mk = (n: number, stmt: string) =>
  EngramSchema.parse({ id: `ENG-2026-0926-${String(n).padStart(3, '0')}`, statement: stmt, type: 'behavioral', scope: 'global', status: 'active' })

const deployEngrams = [
  mk(1, 'Deploy production servers with blue-green strategy'),
  mk(2, 'Never deploy production servers on Friday'),
  mk(3, 'Production servers deploy through the CI pipeline'),
  mk(4, 'Servers in production need a health check after deploy'),
  mk(5, 'PostgreSQL is the primary database'),
]

describe('formal R2 core-retrieval#9 — hybrid labels and limit cap', () => {
  const before = embedderStatus()
  afterEach(() => {
    resetEmbedder()
    setEmbeddingsEnabled(!before.disabled, before.disabledReason ?? undefined)
  })

  it('(a) a failed embedder is not reported as a hybrid search', async () => {
    setEmbeddingsEnabled(true)
    _setCachedEmbedder({
      name: 'failing-stub', dim: 4, modelId: 'stub',
      embed: async () => { throw new Error('model crashed') },
      embedBatch: async () => { throw new Error('model crashed') },
    })
    const dir = mkdtempSync(join(tmpdir(), 'plur-r2-labels-'))
    const r = await recallAuto(deployEngrams, 'how should we deploy production servers safely', 5, dir)
    expect(r.results.length).toBeGreaterThan(0)
    expect(embedderStatus().available).toBe(false)
    expect(r.strategy_used).toBe('bm25') // pre-fix: 'hybrid'
  })

  it('(a) embeddings disabled by the user: also not hybrid', async () => {
    setEmbeddingsEnabled(false, 'test')
    const r = await recallAuto(deployEngrams, 'how should we deploy production servers safely', 5)
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.strategy_used).toBe('bm25')
  })

  it('(b) an aggregation query through expandedSearch returns at most `limit`', async () => {
    setEmbeddingsEnabled(false, 'test')
    const many = Array.from({ length: 80 }, (_, i) => mk(100 + i, `Attended the deploy review meeting number ${i}`))
    const llm = async () => '1. deploy review meeting\n2. attended meeting\n3. review count'
    const out = await expandedSearch(many, 'how many deploy review meetings did I attend', 5, llm)
    expect(out.length).toBe(5) // pre-fix: 50
  })

  it('(b) non-vacuity: a limit above the floor is honoured too', async () => {
    setEmbeddingsEnabled(false, 'test')
    const many = Array.from({ length: 80 }, (_, i) => mk(100 + i, `Attended the deploy review meeting number ${i}`))
    const llm = async () => '1. deploy review meeting'
    const out = await expandedSearch(many, 'how many deploy review meetings did I attend', 60, llm)
    expect(out.length).toBe(60)
  })
})
