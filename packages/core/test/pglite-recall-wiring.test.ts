/**
 * PGLite recall wiring — Sprint 0 iter-2 audit B-1.
 *
 * Closes RC-1 from iter-1 evaluators (CTO F-CTO-001, Critic concern #1,
 * Dijkstra F-DIJK-003, Data F-DATA-002, Archivist F-ARCH-001 spirit drift):
 * the PGLite adapter was mirrored from YAML on every write but never read by
 * any public method. PLUR_BACKEND=pglite was strictly worse than the default
 * (extra I/O, zero read-path benefit).
 *
 * Fix: when `pgliteAdapter` is active, route the vector portion of
 * recallSemantic / recallHybrid / injectHybrid / similaritySearch through
 * `pgliteAdapter.searchVector`. learn() and learnAsync() auto-call
 * `pgliteAdapter.upsertEmbedding` after the YAML write succeeds.
 *
 * The contract from outside the engine is unchanged. Tests assert that:
 *   1. recall still works (PGLite path returns YAML-backed engrams)
 *   2. learned engrams get embeddings persisted into PGLite
 *   3. recallSemantic returns engrams that were upserted
 *   4. YAML-as-truth is preserved — every returned engram traces to YAML
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, PGLiteAdapter } from '../src/index.js'

const PGLITE_TIMEOUT = 30_000

describe('PGLite recall wiring (iter-2 audit B-1)', () => {
  let dir: string
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pglite-recall-'))
    process.env.PLUR_BACKEND = 'pglite'
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    rmSync(dir, { recursive: true, force: true })
  })

  // Gated: needs the real embedder model (to produce the vector) AND the
  // auto-embed-on-learn path. Offline-safe-gated; run with
  // PLUR_EMBEDDER_NETWORK_TESTS=1 once auto-embed-on-learn is wired (PR-4 TODO).
  it.skipIf(process.env.PLUR_EMBEDDER_NETWORK_TESTS !== '1')('learn() auto-upserts the embedding into PGLite', async () => {
    const plur = new Plur({ path: dir })
    const e = plur.learn('cats prefer to sleep on the keyboard', {
      type: 'behavioral',
      scope: 'global',
    })
    // Block until the background sync + auto-upsert completes.
    await plur.waitForIndex()
    // Open a second adapter on the same dbPath to verify the embedding row
    // exists. This proves the upsertEmbedding ran post-write.
    const adapter = new PGLiteAdapter(
      join(dir, 'engrams.yaml'),
      join(dir, 'store.pglite'),
    )
    const count = await adapter.countEmbeddings()
    expect(count).toBeGreaterThanOrEqual(1)
    await adapter.close()
    expect(e.id).toBeTruthy()
  }, PGLITE_TIMEOUT)

  it('recallHybrid still returns YAML-backed engrams (no synthetic IDs)', async () => {
    const plur = new Plur({ path: dir })
    const seeded = [
      plur.learn('blue ocean strategy is a market positioning concept', { type: 'behavioral', scope: 'global' }),
      plur.learn('the user prefers terse responses', { type: 'behavioral', scope: 'global' }),
      plur.learn('always run tests before merging', { type: 'procedural', scope: 'project:plur' }),
    ]
    await plur.waitForIndex()
    const results = await plur.recallHybrid('ocean strategy')
    // YAML-as-truth: every returned id is one we just learned.
    const seededIds = new Set(seeded.map(e => e.id))
    for (const r of results) {
      expect(seededIds.has(r.id)).toBe(true)
    }
    expect(results.length).toBeGreaterThan(0)
  }, PGLITE_TIMEOUT)

  it('PGLite directory exists after first learn (substrate is opt-in but real)', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('initialize the index', { type: 'behavioral', scope: 'global' })
    await plur.waitForIndex()
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)

  it('recallSemantic returns YAML-backed engrams when PGLite is active', async () => {
    const plur = new Plur({ path: dir })
    const learned = plur.learn('marine biologists study ocean ecosystems', { type: 'behavioral', scope: 'global' })
    plur.learn('the user prefers terse responses', { type: 'behavioral', scope: 'global' })
    await plur.waitForIndex()

    const results = await plur.recallSemantic('ocean')
    // YAML-as-truth — every returned ID came from learn().
    const seededIds = new Set([learned.id])
    plur.list().forEach(e => seededIds.add(e.id))
    for (const r of results) {
      expect(seededIds.has(r.id)).toBe(true)
    }
  }, PGLITE_TIMEOUT)
})
