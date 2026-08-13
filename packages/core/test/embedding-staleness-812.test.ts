/**
 * Embedding staleness (#812) — the vector must follow the text.
 *
 * Finding 6 of the #811 whole-repository audit. `engram_embeddings` held only
 * `(engram_id, embedding)`, and the backfill's anti-join asked only whether an
 * id had ANY vector:
 *
 *     LEFT JOIN engram_embeddings em ON em.engram_id = e.id
 *     WHERE e.status = 'active' AND em.engram_id IS NULL
 *
 * So nothing could ever notice that an engram's TEXT had changed. A dedup
 * UPDATE/MERGE (`learn-async.ts`) could rewrite a statement from "cats" to
 * "databases" and semantic recall would go on ranking it as "cats" forever.
 * The engram on disk was correct; the vector answering for it was not. Not
 * data loss — silently wrong recall, which is harder to notice.
 *
 * The fix stores `content_hash` — md5 of the exact text embedded — beside each
 * vector, and both tiers compare against it. These tests pin the behaviour, and
 * three of them pin hazards the fix itself introduces:
 *
 *   - `reindex()` must NOT lose embeddings. The issue proposed adding a
 *     cascading FK to PGLite for the orphan problem; that would empty the whole
 *     table on every reindex, since reindex deletes and re-inserts every engram
 *     row. The orphan sweep lives in `syncFromYaml` for exactly this reason.
 *   - the backfill loop's exit condition is now a hash comparison, so a
 *     writer/selector disagreement would mean every batch returns the same rows
 *     forever. The pass must refuse to revisit an id and warn instead of spin.
 *   - a NULL hash (rows written before the column existed) must converge after
 *     ONE re-embed, not re-embed on every pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { embeddingContentHash, engramSearchText, hashEmbeddedText } from '../src/fts.js'
import { Plur } from '../src/index.js'
import { logger } from '../src/logger.js'
import type { Engram } from '../src/schemas/engram.js'

const PGLITE_TIMEOUT = 30_000
const DIM = 384

function mkEngram(id: string, statement: string, opts: Partial<Engram> = {}): Engram {
  return {
    id,
    statement,
    type: opts.type ?? 'behavioral',
    scope: opts.scope ?? 'project:plur',
    domain: opts.domain ?? 'plur.test',
    status: opts.status ?? 'active',
    tags: opts.tags ?? [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-08-03',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    ...(opts as any),
  } as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

/** Deterministic unit vector — distinct per text, no model download. */
function stubVec(text: string): Float32Array {
  const v = new Float32Array(DIM)
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619)
    v[Math.abs(h) % DIM] += 1
  }
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return v
}

describe('#812 — content hash identifies the text a vector was built from', () => {
  it('changes when the statement changes', () => {
    const before = embeddingContentHash(mkEngram('ENG-2026-0803-001', 'cats are excellent pets'))
    const after = embeddingContentHash(mkEngram('ENG-2026-0803-001', 'databases are excellent stores'))
    expect(before).not.toBe(after)
  })

  it('is stable for identical content — a re-derivation must not look like an edit', () => {
    const a = mkEngram('ENG-2026-0803-001', 'cats are excellent pets', { tags: ['x'] })
    const b = mkEngram('ENG-2026-0803-001', 'cats are excellent pets', { tags: ['x'] })
    expect(embeddingContentHash(a)).toBe(embeddingContentHash(b))
  })

  it('tracks every field that feeds the embedding, not just the statement', () => {
    const base = mkEngram('ENG-2026-0803-001', 'same statement')
    const withRationale = mkEngram('ENG-2026-0803-001', 'same statement', { rationale: 'a reason that is embedded too' })
    expect(embeddingContentHash(base)).not.toBe(embeddingContentHash(withRationale))
  })

  /**
   * It hashes the RAW text handed to `embed()`, not its tokenization (audit
   * 2026-08-03, finding 9). Both tiers store this value, so it is the single
   * definition of "which text is this vector for".
   */
  it('equals the hash of the raw search text that gets embedded', () => {
    const e = mkEngram('ENG-2026-0803-001', 'the embedded string is what is hashed')
    expect(embeddingContentHash(e)).toBe(hashEmbeddedText(engramSearchText(e)))
  })

  /**
   * The regression finding 9 named. `ftsTokenize` drops stop words, drops
   * tokens under three characters, strips punctuation and lowercases — so a
   * hash of the TOKENIZED form could not see a meaning-inverting edit, which is
   * exactly the edit worth catching.
   */
  it.each([
    ['negation via stop word + short token', 'use the legacy adapter', 'do not use the legacy adapter'],
    ['punctuation-only change', 'ship it', 'ship it?'],
    ['case-only change', 'Use HTTPS', 'use https'],
    ['short-token change', 'set ttl to 60', 'set ttl to 90'],
  ])('detects a %s that the tokenized form erased', (_label, before, after) => {
    const a = mkEngram('ENG-2026-0803-001', before)
    const b = mkEngram('ENG-2026-0803-001', after)
    expect(embeddingContentHash(a)).not.toBe(embeddingContentHash(b))
  })
})

describe('#812 — PGLite tracks staleness and sweeps orphans', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-812-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports a vector as current only for the text it was built from', async () => {
    const original = mkEngram('ENG-2026-0803-001', 'cats are excellent pets')
    seedYaml(yamlPath, [original])
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()

    const originalHash = embeddingContentHash(original)
    await adapter.upsertEmbedding(original.id, stubVec(original.statement), originalHash)
    expect(await adapter.embeddingIsCurrent(original.id, originalHash)).toBe(true)

    // The engram is rewritten in place — same id, different meaning. Before the
    // fix this still reported "has an embedding" and was skipped forever.
    const edited = mkEngram('ENG-2026-0803-001', 'databases are excellent stores')
    expect(await adapter.embeddingIsCurrent(edited.id, embeddingContentHash(edited))).toBe(false)
    expect(await adapter.hasEmbedding(edited.id)).toBe(true) // the old signal, still true — that was the bug

    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('treats a vector stored without a hash as unknown, then converges after one re-embed', async () => {
    const e = mkEngram('ENG-2026-0803-001', 'written by a version that had no content_hash')
    seedYaml(yamlPath, [e])
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()

    await adapter.upsertEmbedding(e.id, stubVec(e.statement)) // legacy write: no hash
    const hash = embeddingContentHash(e)
    expect(await adapter.embeddingIsCurrent(e.id, hash)).toBe(false)

    await adapter.upsertEmbedding(e.id, stubVec(e.statement), hash)
    expect(await adapter.embeddingIsCurrent(e.id, hash)).toBe(true) // converged — not stale forever

    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('deletes the vector when its engram leaves YAML', async () => {
    const keep = mkEngram('ENG-2026-0803-001', 'still here')
    const drop = mkEngram('ENG-2026-0803-002', 'about to be removed')
    seedYaml(yamlPath, [keep, drop])
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()
    await adapter.upsertEmbedding(keep.id, stubVec(keep.statement), embeddingContentHash(keep))
    await adapter.upsertEmbedding(drop.id, stubVec(drop.statement), embeddingContentHash(drop))
    expect(await adapter.countEmbeddings()).toBe(2)

    seedYaml(yamlPath, [keep])
    await adapter.syncFromYaml()

    expect(await adapter.hasEmbedding(drop.id)).toBe(false)
    expect(await adapter.hasEmbedding(keep.id)).toBe(true)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  /**
   * The concrete harm the orphan caused. `generateEngramId` mints
   * `max(same-day id) + 1`, so removing the highest engram of a day frees its
   * id for the next `learn()`. With the vector left behind, the new and
   * unrelated engram inherited it — and semantic recall ranked it as whatever
   * the deleted engram used to say.
   */
  it('does not let a reused id inherit the removed engram\'s vector', async () => {
    const removed = mkEngram('ENG-2026-0803-001', 'the original meaning of this identifier')
    seedYaml(yamlPath, [removed])
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()
    await adapter.upsertEmbedding(removed.id, stubVec(removed.statement), embeddingContentHash(removed))

    seedYaml(yamlPath, [])
    await adapter.syncFromYaml()

    // Same id minted again for entirely different content.
    const reused = mkEngram('ENG-2026-0803-001', 'a completely unrelated later assertion')
    seedYaml(yamlPath, [reused])
    await adapter.syncFromYaml()

    expect(await adapter.hasEmbedding(reused.id)).toBe(false)
    expect(await adapter.embeddingIsCurrent(reused.id, embeddingContentHash(reused))).toBe(false)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  /**
   * Regression guard on the fix's own shape. Adding `ON DELETE CASCADE` to
   * PGLite — which is what #812 originally proposed for the orphan problem —
   * would discard every vector on each reindex, because reindex deletes all
   * engram rows and re-inserts them. That turns a cheap index rebuild into a
   * full re-embed of the corpus.
   */
  it('keeps embeddings across a reindex — the rebuild must not force a re-embed', async () => {
    const e = mkEngram('ENG-2026-0803-001', 'expensive to embed, cheap to reindex')
    seedYaml(yamlPath, [e])
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()
    const hash = embeddingContentHash(e)
    await adapter.upsertEmbedding(e.id, stubVec(e.statement), hash)

    await adapter.reindex()

    expect(await adapter.embeddingIsCurrent(e.id, hash)).toBe(true)
    await adapter.close()
  }, PGLITE_TIMEOUT)
})

describe('#812 — the backfill pass cannot spin', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-812-loop-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * The pass loops until the store stops reporting stale rows, and staleness is
   * now a hash comparison. A store whose predicate never goes false — a
   * writer/selector hash disagreement, a broken `search_text`, a hostile
   * adapter — would previously mean an unbounded background loop pinning a CPU
   * and re-embedding the same engram forever.
   *
   * This adapter lies exactly that way: it accepts every upsert and still
   * reports the rows as stale. The pass must notice it has already handled
   * them, warn, and stop.
   *
   * It must return a FULL batch to reach the hazard. The loop already returns
   * early on a short batch — the "tail" heuristic — so only a store that keeps
   * saturating the batch can drive it round again. That is also the realistic
   * shape of the bug: a systematic hash disagreement makes every row stale, so
   * every batch comes back full.
   */
  it('stops and warns when a store keeps reporting the same engrams as stale', async () => {
    const BATCH = 100 // must match PRIMARY_AUTO_EMBED_BATCH in index.ts
    const staleBatch = Array.from({ length: BATCH }, (_, i) =>
      mkEngram(`ENG-2026-0803-${String(i + 1).padStart(3, '0')}`, `row ${i} will never be admitted as current`))
    let upserts = 0
    const lyingAdapter = {
      listEngramsMissingEmbeddings: async () => staleBatch,
      upsertEmbedding: async () => { upserts++ },
      getVectorColumnDim: async () => null,
    }

    const plur = new Plur({ path: dir })
    const { _setCachedEmbedder, resetEmbedder } = await import('../src/embeddings.js')
    _setCachedEmbedder({
      name: 'stub-812',
      dim: DIM,
      embed: async (text: string) => stubVec(text),
    } as any)
    // Collect into a local array rather than reading `warn.mock.calls` later:
    // `mockRestore()` clears the recorded calls, so asserting after the restore
    // reads an empty history and passes for the wrong reason.
    const warnings: string[] = []
    const warn = vi.spyOn(logger, 'warning').mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]))
    })

    try {
      await (plur as any)._autoEmbedPrimaryStore(lyingAdapter)
    } finally {
      warn.mockRestore()
      resetEmbedder()
    }

    // Terminated instead of spinning, having tried each row exactly once.
    expect(upserts).toBe(BATCH)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(staleBatch[0].id)
  }, PGLITE_TIMEOUT)
})
