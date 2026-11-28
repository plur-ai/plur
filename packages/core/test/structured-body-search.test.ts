/**
 * Overhaul W10 (a) and decision D9: the structured body of an engram is part
 * of its search text, and the indexes built from that text rebuild lazily.
 *
 * `structured_data.body` holds the structured form a capture writes (when to
 * apply, what to do, why, pitfalls, anchors). The capture experiment of
 * 2026-11-09 (C3) measured top-10 recall at +7 points once that text was
 * searchable. These tests pin:
 *
 *  - a term that appears ONLY in the body is found by keyword recall and by
 *    hybrid recall;
 *  - the embedding cache re-embeds an engram whose search text changed once,
 *    and only that engram, and is stable afterwards (no rebuild on every
 *    search, no rebuild of rows without a body);
 *  - the search-text version is part of the stamp the Postgres tier stores, so
 *    rows written before the body counted are stale and rebuilt in the
 *    background (gated on PLUR_TEST_POSTGRES_URL);
 *  - learn and the remote-routed constructor accept a validated
 *    `structured_data` {body, kind, outcome} and refuse anything else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'
import {
  engramSearchText, searchEngrams, embeddingContentHash, hashEmbeddedText,
  TOKENIZER_VERSION, SEARCH_TEXT_VERSION, SEARCH_INDEX_VERSION,
} from '../src/fts.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled, embeddingSearch, _readEmbeddingCacheEntries } from '../src/embeddings.js'

const BODY_TERM = 'quokkaflange'

function mk(id: string, statement: string, body?: string): Engram {
  return {
    id, statement, type: 'behavioral', scope: 'global', status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-11-10' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    ...(body ? { structured_data: { body } } : {}),
  } as unknown as Engram
}

describe('engramSearchText includes structured_data.body', () => {
  it('appends the body when present', () => {
    const e = mk('ENG-2026-1110-001', 'Restart the worker after config edits', `When: editing ${BODY_TERM} settings.`)
    expect(engramSearchText(e)).toContain(BODY_TERM)
  })

  it('leaves engrams without a body unchanged', () => {
    const e = mk('ENG-2026-1110-002', 'Restart the worker after config edits')
    expect(engramSearchText(e)).toBe('Restart the worker after config edits')
  })

  it('ignores a non-string body and the bookkeeping keys', () => {
    const e = mk('ENG-2026-1110-003', 'Plain statement')
    ;(e as any).structured_data = { body: { nested: BODY_TERM }, _routed: { scope: BODY_TERM } }
    expect(engramSearchText(e)).not.toContain(BODY_TERM)
  })

  it('changes the embedding content hash, so stored vectors go stale', () => {
    const a = mk('ENG-2026-1110-004', 'Same statement')
    const b = mk('ENG-2026-1110-004', 'Same statement', 'a body that is embedded too')
    expect(embeddingContentHash(a)).not.toBe(embeddingContentHash(b))
  })

  it('carries a search-text version in the index stamp', () => {
    expect(SEARCH_TEXT_VERSION).toBeGreaterThanOrEqual(2)
    // The stamp stored with derived tokens must move when EITHER the tokenizer
    // or the search-text composition changes; a bare tokenizer stamp would let
    // rows written before the body counted pass as current.
    expect(SEARCH_INDEX_VERSION).not.toBe(TOKENIZER_VERSION)
  })

  it('keyword search finds an engram by a term only its body contains', () => {
    const corpus = [
      mk('ENG-2026-1110-010', 'Restart the worker after config edits', `Anchors: the ${BODY_TERM} module.`),
      mk('ENG-2026-1110-011', 'Prefer small pull requests'),
      mk('ENG-2026-1110-012', 'Tag releases with the version number'),
    ]
    const hits = searchEngrams(corpus, BODY_TERM, 5)
    expect(hits.map(h => h.id)).toEqual(['ENG-2026-1110-010'])
  })
})

describe('recall over the structured body', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-body-recall-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
    setEmbeddingsEnabled(false, 'test: writing fixtures')
    plur = new Plur({ path: dir, autoDiscover: false })
    await plur.ready()
  })
  afterEach(() => {
    resetEmbedder()
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('learn stores the body and BM25 recall finds it by a body-only term', async () => {
    const e = await plur.learn('Restart the worker after config edits', {
      scope: 'global',
      structured_data: { body: `When: you change ${BODY_TERM} settings. Do: restart. Why: config is read at boot.`, kind: 'rule' },
    })
    await plur.learn('Prefer small pull requests', { scope: 'global' })
    expect((e as any).structured_data.body).toContain(BODY_TERM)
    expect((e as any).structured_data.kind).toBe('rule')
    const hits = await plur.recall(BODY_TERM, { limit: 5 })
    expect(hits.map(h => h.id)).toContain(e.id)
  })

  it('hybrid recall finds it too, and the embedding cache rebuilds a changed row once', async () => {
    const e = await plur.learn('Restart the worker after config edits', { scope: 'global' })
    const other = await plur.learn('Prefer small pull requests', { scope: 'global' })

    // A deterministic bag-of-words embedder; counts the passages it embeds.
    const DIM = 256
    const embedded: string[] = []
    const vec = (t: string) => {
      const v = new Float32Array(DIM)
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 2166136261
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
        v[Math.abs(h) % DIM] += 1
      }
      const n = Math.hypot(...v) || 1
      return v.map(x => x / n)
    }
    const embed = async (t: string) => { embedded.push(t); return vec(t) }
    setEmbeddingsEnabled(true)
    _setCachedEmbedder({ name: 'stub-bow', dim: DIM, modelId: 'stub', embed, embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)) })

    // First search: both rows are embedded (cold cache).
    let rows = await plur.list()
    await embeddingSearch(rows, 'anything', 5, dir)
    const cold = embedded.filter(t => t !== 'anything')
    expect(cold).toHaveLength(2)

    // Warm: nothing is re-embedded.
    embedded.length = 0
    await embeddingSearch(rows, 'anything', 5, dir)
    expect(embedded.filter(t => t !== 'anything')).toHaveLength(0)

    // The body arrives (an enrichment or an edit). Only that row's search
    // text changed, so only that row is re-embedded — once.
    const stored = (await plur.getById(e.id))!
    await plur.updateEngramAsync({ ...stored, structured_data: { ...(stored as any).structured_data, body: `Anchors: ${BODY_TERM} module` } } as Engram)
    rows = await plur.list()
    embedded.length = 0
    await embeddingSearch(rows, 'anything', 5, dir)
    const rebuilt = embedded.filter(t => t !== 'anything')
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]).toContain(BODY_TERM)

    embedded.length = 0
    await embeddingSearch(rows, 'anything', 5, dir)
    expect(embedded.filter(t => t !== 'anything')).toHaveLength(0)

    const cache = _readEmbeddingCacheEntries(join(dir, '.embeddings-cache.json'), { name: 'stub-bow', dim: DIM })
    expect(Object.keys(cache)).toEqual(expect.arrayContaining([e.id, other.id]))

    const hybrid = await plur.recallHybrid(BODY_TERM, { limit: 5 })
    expect(hybrid.map(h => h.id)[0]).toBe(e.id)
  })
})

describe('learn validates structured_data', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-body-validate-'))
    plur = new Plur({ path: dir, autoDiscover: false })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts body, kind and outcome', async () => {
    const e = await plur.learn('Never deploy on Fridays', {
      scope: 'global',
      structured_data: { body: 'When: a release is ready late in the week.', kind: 'failure_lesson', outcome: 'failure' },
    })
    expect((e as any).structured_data).toMatchObject({ body: 'When: a release is ready late in the week.', kind: 'failure_lesson', outcome: 'failure' })
  })

  it('derives memory_class from kind when none is given', async () => {
    const lesson = await plur.learn('The staging deploy failed because the cache was warm', { scope: 'global', structured_data: { kind: 'experience' } })
    expect(lesson.knowledge_type?.memory_class).toBe('episodic')
    const rule = await plur.learn('Always run the linter before pushing', { scope: 'global', structured_data: { kind: 'rule' } })
    expect(rule.knowledge_type?.memory_class).toBe('procedural')
    const explicit = await plur.learn('Explicit class wins', { scope: 'global', memory_class: 'semantic', structured_data: { kind: 'experience' } })
    expect(explicit.knowledge_type?.memory_class).toBe('semantic')
  })

  it.each([
    ['an unknown kind', { kind: 'opinion' }],
    ['an unknown outcome', { outcome: 'maybe' }],
    ['a non-string body', { body: 42 }],
    ['an over-long body', { body: 'x '.repeat(1500) }],
    ['an unknown key', { colour: 'blue' }],
    ['a forged bookkeeping key', { _routed: { scope: 'group:x' } }],
  ])('refuses %s', async (_label, sd) => {
    await expect(plur.learn('Some statement', { scope: 'global', structured_data: sd as any })).rejects.toThrow(/structured_data/)
  })

  it('the remote-routed constructor applies the same rules', () => {
    const shape = (plur as any)._buildEngramShape('Statement', 'global', { structured_data: { body: 'b', kind: 'tool' } }, new Date().toISOString()) as Engram
    expect((shape as any).structured_data).toMatchObject({ body: 'b', kind: 'tool' })
    expect(() => (plur as any)._buildEngramShape('Statement', 'global', { structured_data: { kind: 'nope' } }, new Date().toISOString())).toThrow(/structured_data/)
  })
})

describe('the search-text version stamp is what Postgres stores (D9)', () => {
  it('hashes stay the raw search text', () => {
    const e = mk('ENG-2026-1110-020', 'Statement', 'Body')
    expect(embeddingContentHash(e)).toBe(hashEmbeddedText(engramSearchText(e)))
  })
})

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
describe.skipIf(!PG_URL)('Postgres rebuilds rows stamped before the body counted, once (D9)', () => {
  it('backfill re-derives tokens and content hash for old-stamp rows, then reports zero', async () => {
    const adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: 'plur_w10_search_text', vectorIndex: 'exact' })
    try {
      const withBody = mk('ENG-2026-1110-030', 'Restart the worker after config edits', `Anchors: ${BODY_TERM}`)
      const plain = mk('ENG-2026-1110-031', 'Prefer small pull requests')
      await adapter.save([withBody, plain])
      const pool = await (adapter as any).getPool()
      // The state an upgraded store is in: stamped by the tokenizer alone, with
      // the search text and hash of the statement-only composition.
      const oldText = 'restart worker after config edits'
      await pool.query(
        `UPDATE "plur_w10_search_text".engrams SET tokens_version = $1, search_text = $2, content_hash = 'old' WHERE id = $3`,
        [TOKENIZER_VERSION, oldText, withBody.id],
      )
      await pool.query(`UPDATE "plur_w10_search_text".engrams SET tokens_version = $1 WHERE id = $2`, [TOKENIZER_VERSION, plain.id])
      expect(await adapter.backfillTokens()).toBe(2)
      const { rows } = await pool.query(`SELECT search_text, content_hash, tokens_version FROM "plur_w10_search_text".engrams WHERE id = $1`, [withBody.id])
      expect(rows[0].search_text).toContain(BODY_TERM)
      expect(rows[0].content_hash).toBe(embeddingContentHash(withBody))
      expect(rows[0].tokens_version).toBe(SEARCH_INDEX_VERSION)
      expect(await adapter.backfillTokens()).toBe(0)
    } finally {
      await adapter.dropSchema().catch(() => {})
      await adapter.close().catch(() => {})
    }
  }, 120_000)
})
