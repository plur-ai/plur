/**
 * plur_doctor per-store reranker eval gate — #451 (final task).
 *
 * The gate compares rerank-on vs RRF-only ordering on probes synthesized
 * from the store's own engrams, caches the verdict per store, and surfaces
 * it as an ADVISORY doctor check. It never auto-disables reranking.
 *
 * Stub rerankers are seeded into the adapter cache so no test touches a
 * real model download.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, _setCachedReranker, _resetRerankerCache, resetRerankerStatus } from '@plur-ai/core'
import type { RerankerAdapter } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const TINY = 'ms-marco-minilm-l6' as const
const TINY_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2'

const STATEMENTS = [
  'The staging deploy target for the ingestion service is cluster-2 in Frankfurt',
  'Karl prefers TypeScript strict mode enabled for every new package in the monorepo',
  'The nightly benchmark harness runs LongMemEval fixtures against the hybrid search pipeline',
  'Postgres connection pooling for the enterprise server uses pgbouncer in transaction mode',
  'The Telegram bot forwards trading alerts to the meridian channel every morning',
  'Grafana dashboards for the reranker latency live under the retrieval folder',
  'The YAML store keeps engram truth while PGLite carries the derived vector index',
  'OpenClaw sessions auto-inject engrams through the context engine assembler hook',
  'The outbox queue retries failed remote writes on every session start event',
  'BM25 tokenization lowercases statements and strips punctuation before scoring',
  'Reciprocal rank fusion merges lexical and semantic result lists with constant sixty',
  'The dedup pipeline hashes statement content before invoking the LLM judge',
]

/** Order-agreeing stub: scores by query-token overlap → source doc wins. */
const oracle = (): RerankerAdapter => ({
  name: TINY,
  modelId: TINY_MODEL_ID,
  async score(q, d) { return overlap(q, d) },
  async scoreBatch(q, docs) { return docs.map(d => overlap(q, d)) },
})

function overlap(query: string, document: string): number {
  const qs = new Set(query.toLowerCase().split(/\s+/).filter(Boolean))
  let s = 0
  for (const token of document.toLowerCase().split(/\s+/)) if (qs.has(token)) s += 1
  return s
}

/** Order-inverting stub: demotes whatever RRF ranked first → harmful verdict. */
const adversary = (): RerankerAdapter => ({
  name: TINY,
  modelId: TINY_MODEL_ID,
  async score() { return 0 },
  async scoreBatch(_q, docs) { return docs.map((_d, i) => i) },
})

describe('plur_doctor per-store reranker eval gate (#451)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  // #469: warm the cold ONNX embedder load once so individual tests measure
  // logic, not model download/load time.
  beforeAll(async () => {
    const warmDir = mkdtempSync(join(tmpdir(), 'plur-evalgate-warm-'))
    try {
      const warm = new Plur({ path: warmDir })
      warm.learn('embedder warm-up', { scope: 'global' })
      await warm.recallHybrid('embedder warm-up')
    } finally {
      rmSync(warmDir, { recursive: true, force: true })
    }
  }, 120_000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-evalgate-'))
    plur = new Plur({ path: dir })
    for (const s of STATEMENTS) plur.learn(s, { scope: 'global' })
    tools = getToolDefinitions('full')
    process.env.PLUR_RERANKER = TINY
    _resetRerankerCache()
    resetRerankerStatus()
  })
  afterEach(() => {
    delete process.env.PLUR_RERANKER
    _resetRerankerCache()
    resetRerankerStatus()
    rmSync(dir, { recursive: true, force: true })
  })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  const gateCheck = (result: any) =>
    result.checks.find((c: any) => c.check === 'reranker per-store eval')

  it('reports "not yet evaluated" (ok, advisory) when no eval is cached', async () => {
    _setCachedReranker(TINY, oracle())
    const result = await callTool('plur_doctor') as any
    const check = gateCheck(result)
    expect(check).toBeDefined()
    expect(check.ok).toBe(true)
    expect(check.detail).toContain('rerank_eval')
    expect(check.detail.toLowerCase()).toContain('not yet evaluated')
  })

  it('rerank_eval:true runs the self-eval and reports a non-harmful verdict as ok', async () => {
    _setCachedReranker(TINY, oracle())
    const result = await callTool('plur_doctor', { rerank_eval: true }) as any
    const check = gateCheck(result)
    expect(check).toBeDefined()
    expect(check.ok).toBe(true)
    expect(check.detail).toMatch(/beneficial|neutral/)
    expect(check.detail).toContain('ΔMRR')
  }, 60_000)

  it('rerank_eval:true flags a harmful verdict loudly, with advisory remediation', async () => {
    _setCachedReranker(TINY, adversary())
    const result = await callTool('plur_doctor', { rerank_eval: true }) as any
    const check = gateCheck(result)
    expect(check).toBeDefined()
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('harmful')
    const remediation = result.remediation.join('\n')
    expect(remediation).toContain('net-negative')
    // Advisory, not auto-disable: the remediation must say reranking stays on.
    expect(remediation.toLowerCase()).toContain('advisory')
    expect(remediation).toContain('PLUR_RERANKER')
  }, 60_000)

  it('a cached harmful verdict surfaces on later doctor runs WITHOUT rerank_eval', async () => {
    _setCachedReranker(TINY, adversary())
    await callTool('plur_doctor', { rerank_eval: true })
    // New doctor call, no flag: the cached verdict still shows.
    const result = await callTool('plur_doctor') as any
    const check = gateCheck(result)
    expect(check).toBeDefined()
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('harmful')
    expect(check.detail).toContain('cached')
  }, 60_000)

  it('skips the gate check entirely when PLUR_RERANKER is off', async () => {
    delete process.env.PLUR_RERANKER
    const result = await callTool('plur_doctor') as any
    expect(gateCheck(result)).toBeUndefined()
  })

  it('reports a failed self-eval as a failed check instead of throwing', async () => {
    _setCachedReranker(TINY, {
      name: TINY,
      modelId: TINY_MODEL_ID,
      async score() { throw new Error('model load failed') },
      async scoreBatch() { throw new Error('model load failed') },
    })
    const result = await callTool('plur_doctor', { rerank_eval: true }) as any
    const check = gateCheck(result)
    expect(check).toBeDefined()
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('model load failed')
  }, 60_000)
})
