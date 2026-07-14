import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-'))
}

function injectLegacyConflict(plur: Plur, fromId: string, toId: string): void {
  const engrams = plur.list()
  const engram = engrams.find(e => e.id === fromId)!
  plur.updateEngram({
    ...engram,
    relations: {
      broader: [],
      narrower: [],
      related: [],
      conflicts: [toId],
    },
  })
}

describe('plur_tensions tool', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!
  const purgeTool = tools.find(t => t.name === 'plur_tensions_purge')!

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is registered as a tool', () => {
    expect(tensionsTool).toBeDefined()
    expect(tensionsTool.name).toBe('plur_tensions')
  })

  it('plur_tensions_purge is registered as a tool', () => {
    expect(purgeTool).toBeDefined()
    expect(purgeTool.name).toBe('plur_tensions_purge')
  })

  it('returns empty tensions when no conflicts', async () => {
    plur.learn('Always use TypeScript')
    const result = await tensionsTool.handler({}, plur) as any
    expect(result.tensions).toEqual([])
    expect(result.count).toBe(0)
    expect(result.purge_hint).toBeUndefined()
  })

  it('scan detects a contradiction between conflicting engrams', async () => {
    // The old test called plur_tensions in LIST mode (no scan), which returns
    // only PERSISTED records — so count was ALWAYS 0 and the `if (count>0)`
    // guard meant the pair-field assertions never ran. Detection happens in
    // SCAN mode; mock the LLM judge (as the sibling scan tests do) and assert
    // the detected pair, unguarded.
    plur.learn('Always use tabs for indentation in TypeScript files')
    plur.learn('Always use spaces for indentation in TypeScript files')

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'CONTRADICTS: yes\nCONFIDENCE: 0.9\nREASON: Tabs and spaces are mutually exclusive.' } }],
      }),
    }) as any
    try {
      const result = await tensionsTool.handler({
        scan: true, llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'test-key',
      }, plur) as any
      expect(result.count).toBeGreaterThan(0)
      expect(result.tensions[0].tension_id).toMatch(/^T-/)
      expect(result.tensions[0].engram_a.id).toBeDefined()
      expect(result.tensions[0].engram_b.id).toBeDefined()
      expect(result.tensions[0].confidence).toBeGreaterThanOrEqual(0.7)
      expect(result.tensions[0].reason).toBeTruthy()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('list mode returns de-duplicated tension records', async () => {
    // The old test ran LIST mode behind an `if (count>0)` guard that was always
    // false (nothing was ever persisted), so the uniqueness assertion never ran
    // — and it read t.engram_a.id, but list records expose engram_a as a bare id
    // string. Here we SEED persisted records (same pair thrice, including a
    // swapped-id ordering) and assert the pair collapses to one record, unguarded.
    const e1 = plur.learn('Use PostgreSQL for the database')
    const e2 = plur.learn('Use MySQL for the database instead of PostgreSQL')
    const pair = {
      id_a: e1.id, id_b: e2.id,
      statement_a: e1.statement, statement_b: e2.statement,
      confidence: 0.9, reason: 'Mutually exclusive database choices.',
    }
    plur.recordTensions([pair])
    plur.recordTensions([pair])
    plur.recordTensions([{ ...pair, id_a: e2.id, id_b: e1.id }])

    const result = await tensionsTool.handler({ status: 'all' }, plur) as any
    const pairKeys = result.tensions.map((t: any) => [t.engram_a, t.engram_b].sort().join(':'))
    expect(pairKeys.length).toBeGreaterThan(0)               // records actually persisted
    expect(new Set(pairKeys).size).toBe(pairKeys.length)     // no duplicate pair
    expect(pairKeys.length).toBe(1)                          // 3 recordings collapsed to 1
  })

  it('surfaces legacy conflict relations separately with a purge hint (#181)', async () => {
    const e1 = plur.learn('Always use PostgreSQL')
    const e2 = plur.learn('Always use MySQL')
    injectLegacyConflict(plur, e1.id, e2.id)

    const result = await tensionsTool.handler({}, plur) as any
    // legacy relations.conflicts refs are NOT persisted tension records
    expect(result.count).toBe(0)
    expect(result.legacy_conflicts).toHaveLength(1)
    expect(result.purge_hint).toBeDefined()
    expect(result.purge_hint).toContain('plur_tensions_purge')
  })

  it('omits purge_hint when there are no tensions', async () => {
    plur.learn('Use TypeScript')
    const result = await tensionsTool.handler({}, plur) as any
    expect(result.count).toBe(0)
    expect(result.purge_hint).toBeUndefined()
  })
})

describe('plur_tensions scan mode', () => {
  let dir: string
  let plur: Plur
  let originalFetch: typeof globalThis.fetch
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-scan-'))
    plur = new Plur({ path: dir })
    originalFetch = globalThis.fetch
    delete (process.env as any).OPENAI_API_KEY
    delete (process.env as any).OPENROUTER_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns error when scan:true but no LLM configured', async () => {
    plur.learn('plur uses BM25 for search')
    plur.learn('plur uses embeddings for search')
    const result = await tensionsTool.handler({ scan: true }, plur) as any
    expect(result.error).toMatch(/requires an LLM/)
    expect(result.tensions).toEqual([])
    expect(result.count).toBe(0)
  })

  it('calls LLM and returns high-confidence tensions', async () => {
    plur.learn('plur search uses only BM25 and ignores embeddings entirely')
    plur.learn('plur search uses only embeddings and ignores BM25 entirely')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'CONTRADICTS: yes\nCONFIDENCE: 0.92\nREASON: One says BM25-only, the other says embeddings-only.' } }],
      }),
    } as any)

    const result = await tensionsTool.handler({
      scan: true,
      llm_base_url: 'https://api.openai.com/v1',
      llm_api_key: 'test-key',
    }, plur) as any

    expect(result.count).toBeGreaterThan(0)
    expect(result.tensions[0]).toHaveProperty('confidence')
    expect(result.tensions[0].confidence).toBeGreaterThanOrEqual(0.7)
    expect(result.tensions[0]).toHaveProperty('reason')
    expect(result.tensions[0].engram_a).toHaveProperty('id')
    expect(result.tensions[0].engram_b).toHaveProperty('id')
    expect(result.pairs_checked).toBeGreaterThan(0)
  })

  it('filters out low-confidence pairs', async () => {
    plur.learn('plur uses BM25 for search ranking')
    plur.learn('plur uses embeddings for search ranking')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'CONTRADICTS: yes\nCONFIDENCE: 0.4\nREASON: Slightly different approaches.' } }],
      }),
    } as any)

    const result = await tensionsTool.handler({
      scan: true,
      llm_base_url: 'https://api.openai.com/v1',
      llm_api_key: 'test-key',
    }, plur) as any

    // Confidence 0.4 is below the 0.7 threshold — no tensions stored
    expect(result.count).toBe(0)
    expect(result.tensions).toEqual([])
  })

  it('respects min_confidence override', async () => {
    plur.learn('plur uses BM25 for search ranking')
    plur.learn('plur uses embeddings for search ranking')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'CONTRADICTS: yes\nCONFIDENCE: 0.5\nREASON: Different ranking strategies.' } }],
      }),
    } as any)

    const result = await tensionsTool.handler({
      scan: true,
      llm_base_url: 'https://api.openai.com/v1',
      llm_api_key: 'test-key',
      min_confidence: 0.3,
    }, plur) as any

    expect(result.count).toBeGreaterThan(0)
  })

  it('batches multiple candidate pairs into a single LLM call by default (#180)', async () => {
    plur.learn('plur uses yaml')
    plur.learn('plur uses json')
    plur.learn('plur uses toml')

    const fetchMock = vi.fn().mockImplementation(async (_url: any, init: any) => {
      const prompt: string = JSON.parse(init.body).messages[0].content
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      const content = n > 0
        ? Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: CONTRADICTS: no | CONFIDENCE: 0.1 | REASON: Fine.`).join('\n')
        : 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Fine.'
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    globalThis.fetch = fetchMock as any

    const result = await tensionsTool.handler({
      scan: true,
      llm_base_url: 'https://api.openai.com/v1',
      llm_api_key: 'test-key',
    }, plur) as any

    expect(result.pairs_checked).toBe(3)
    // 3 pairs, default batch_size 5 → one LLM call
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.count).toBe(0)
  })

  it('batch_size 1 forces sequential single-pair calls (#180)', async () => {
    plur.learn('plur uses yaml')
    plur.learn('plur uses json')
    plur.learn('plur uses toml')

    const prompts: string[] = []
    const fetchMock = vi.fn().mockImplementation(async (_url: any, init: any) => {
      prompts.push(JSON.parse(init.body).messages[0].content)
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Fine.' } }] }),
      }
    })
    globalThis.fetch = fetchMock as any

    const result = await tensionsTool.handler({
      scan: true,
      llm_base_url: 'https://api.openai.com/v1',
      llm_api_key: 'test-key',
      batch_size: 1,
    }, plur) as any

    expect(result.pairs_checked).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const p of prompts) expect(p).toContain('STATEMENT A')
  })

  it('uses OPENAI_API_KEY from env when no explicit LLM args', async () => {
    process.env.OPENAI_API_KEY = 'env-test-key'
    plur.learn('plur search uses only BM25 for ranking')
    plur.learn('plur search uses only embeddings for ranking')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'CONTRADICTS: yes\nCONFIDENCE: 0.85\nREASON: Mutually exclusive claims.' } }],
      }),
    } as any)

    const result = await tensionsTool.handler({ scan: true }, plur) as any
    expect(result.count).toBeGreaterThan(0)
    delete process.env.OPENAI_API_KEY
  })
})

describe('plur_tensions temporal config wiring (#240)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-temporal-'))
    originalFetch = globalThis.fetch
    delete (process.env as any).OPENAI_API_KEY
    delete (process.env as any).OPENROUTER_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Learn two contradicting snapshot engrams recorded on different days. */
  function seedSnapshotPair(plur: Plur): void {
    const a = plur.learn('hormuz strait ceasefire holding, passage regulated', { domain: 'war-analysis' })
    const b = plur.learn('hormuz strait ceasefire collapsed, passage closed', { domain: 'war-analysis' })
    for (const [id, learnedAt] of [[a.id, '2026-04-07'], [b.id, '2026-05-05']] as const) {
      const stored = plur.getById(id)!
      plur.updateEngram({ ...stored, temporal: { ...stored.temporal, learned_at: learnedAt } })
    }
  }

  const yesLlm = () => vi.fn().mockImplementation(async (_url: any, init: any) => {
    const prompt: string = JSON.parse(init.body).messages[0].content
    const n = (prompt.match(/PAIR \d+/g) ?? []).length
    const content = n > 0
      ? Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.`).join('\n')
      : 'CONTRADICTS: yes\nCONFIDENCE: 0.9\nREASON: Opposite.'
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  })

  it('config tensions.temporal_domains skips snapshot pairs in scan mode', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'tensions:\n  temporal_domains:\n    - war-analysis\n')
    const plur = new Plur({ path: dir })
    seedSnapshotPair(plur)

    const fetchMock = yesLlm()
    globalThis.fetch = fetchMock as any

    const result = await tensionsTool.handler({
      scan: true, llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'k',
    }, plur) as any

    expect(result.pairs_checked).toBe(0)
    expect(result.count).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('without the config the same pair is judged (dates still reach the prompt)', async () => {
    const plur = new Plur({ path: dir })
    seedSnapshotPair(plur)

    const prompts: string[] = []
    const fetchMock = vi.fn().mockImplementation(async (_url: any, init: any) => {
      const prompt: string = JSON.parse(init.body).messages[0].content
      prompts.push(prompt)
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      const content = Array.from({ length: Math.max(n, 1) }, (_, i) => `PAIR_${i + 1}: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.`).join('\n')
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    globalThis.fetch = fetchMock as any

    const result = await tensionsTool.handler({
      scan: true, llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'k',
    }, plur) as any

    expect(result.pairs_checked).toBe(1)
    expect(result.count).toBe(1)
    expect(prompts.join('\n')).toContain('2026-04-07')
    expect(prompts.join('\n')).toContain('2026-05-05')
    expect(result.tensions[0].days_apart).toBe(28)
  })

  it('temporal_discount arg discounts confidence and reports raw_confidence', async () => {
    const plur = new Plur({ path: dir })
    seedSnapshotPair(plur)

    globalThis.fetch = yesLlm() as any

    const result = await tensionsTool.handler({
      scan: true, llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'k',
      temporal_discount: true, min_confidence: 0.2,
    }, plur) as any

    expect(result.count).toBe(1)
    // 28 days apart → 0.3 factor → 0.27
    expect(result.tensions[0].confidence).toBeCloseTo(0.27)
    expect(result.tensions[0].raw_confidence).toBeCloseTo(0.9)
  })

  it('config tensions.temporal_discount=true applies without an explicit arg', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'tensions:\n  temporal_discount: true\n')
    const plur = new Plur({ path: dir })
    seedSnapshotPair(plur)

    globalThis.fetch = yesLlm() as any

    const result = await tensionsTool.handler({
      scan: true, llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'k',
      min_confidence: 0.2,
    }, plur) as any

    expect(result.count).toBe(1)
    expect(result.tensions[0].confidence).toBeCloseTo(0.27)
  })
})

describe('plur_learn supersedes (#240)', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()
  const learnTool = tools.find(t => t.name === 'plur_learn')!
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-learn-supersedes-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('declares supersedes as an array param', () => {
    const schema = learnTool.inputSchema as any
    expect(schema.properties.supersedes).toBeDefined()
    expect(schema.properties.supersedes.type).toBe('array')
  })

  it('writes the forward edge on the new engram and the reverse edge on the target', async () => {
    const oldE = await learnTool.handler({ statement: 'plur cli version is 0.3.0', scope: 'global' }, plur) as any
    const newE = await learnTool.handler({
      statement: 'plur cli version is 0.8.2', scope: 'global', supersedes: [oldE.id],
    }, plur) as any

    expect(plur.getById(newE.id)?.relations?.supersedes).toEqual([oldE.id])
    expect(plur.getById(oldE.id)?.relations?.superseded_by).toEqual([newE.id])
  })

  it('supersedes-linked pair no longer surfaces as a scan candidate', async () => {
    const oldE = await learnTool.handler({ statement: 'plur cli version is 0.3.0', scope: 'global' }, plur) as any
    await learnTool.handler({
      statement: 'plur cli version is 0.8.2', scope: 'global', supersedes: [oldE.id],
    }, plur) as any

    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'CONTRADICTS: yes\nCONFIDENCE: 1.0\nREASON: Versions differ.' } }] }),
    })
    globalThis.fetch = fetchMock as any
    try {
      const result = await tensionsTool.handler({
        scan: true, llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'k',
      }, plur) as any
      expect(result.pairs_checked).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('plur_tensions_purge tool', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!
  const purgeTool = tools.find(t => t.name === 'plur_tensions_purge')!

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('clears all legacy conflict relations', async () => {
    const e1 = plur.learn('Use tabs for indentation')
    const e2 = plur.learn('Use spaces for indentation')
    injectLegacyConflict(plur, e1.id, e2.id)

    const before = await tensionsTool.handler({}, plur) as any
    expect(before.legacy_conflicts).toHaveLength(1)

    const purgeResult = await purgeTool.handler({}, plur) as any
    expect(purgeResult.purged_conflict_refs).toBe(1)
    expect(purgeResult.engrams_modified).toBe(1)
    expect(purgeResult.message).toContain('1')

    const after = await tensionsTool.handler({}, plur) as any
    expect(after.legacy_conflicts).toBeUndefined()
    expect(after.purge_hint).toBeUndefined()
  })

  it('returns zero counts when nothing to purge', async () => {
    plur.learn('Use TypeScript')
    const result = await purgeTool.handler({}, plur) as any
    expect(result.purged_conflict_refs).toBe(0)
    expect(result.engrams_modified).toBe(0)
  })
})
