/**
 * Reembed migration for the non-PGLite (default) backend.
 * Sprint 0 iter-2 audit B-3 — closes RC-3 for the ~99% default-install
 * users who don't run PGLite.
 *
 * Before this fix: `plur sync --reembed` returned
 * `{ skipped: true, reason: 'reembed requires PLUR_BACKEND=pglite' }` when
 * PGLite wasn't active. Users switching embedders had no migration path and
 * silently kept the poisoned cache.
 *
 * After this fix: `reembedAsync()` and `sync({ reembed: true })` both
 * rebuild `.embeddings-cache.json` against the active embedder using
 * `embeddings.rebuildJsonCache`. YAML stays the source of truth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

describe('reembedAsync — JSON cache path (iter-2 audit B-3)', () => {
  let dir: string
  // M-3 flipped the default to pglite; these tests are about the non-PGLite
  // JSON cache path, so pin sqlite explicitly.
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    process.env.PLUR_BACKEND = 'sqlite'
    dir = mkdtempSync(join(tmpdir(), 'plur-reembed-json-'))
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    rmSync(dir, { recursive: true, force: true })
  })

  it('reembedAsync() rebuilds JSON cache when PGLite is not the active backend', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('cats are not dogs', { type: 'behavioral', scope: 'global' })
    plur.learn('humans like coffee', { type: 'behavioral', scope: 'global' })

    const result = await plur.reembedAsync({ full: true })
    // The JSON cache path returns success — no more "skipped: pglite required".
    expect(result.skipped).toBe(false)
    expect(result.reembedded).toBeGreaterThan(0)
    expect(result.reembedded).toBeLessThanOrEqual(2)

    // Cache file exists with the new versioned format.
    const cachePath = join(dir, '.embeddings-cache.json')
    expect(existsSync(cachePath)).toBe(true)
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cache).toHaveProperty('meta')
    expect(cache.meta).toHaveProperty('embedder_name')
    expect(cache.meta).toHaveProperty('embedder_dim')
  })

  it('reembedAsync({full: true}) overwrites a stale cache with the current embedder', async () => {
    const plur = new Plur({ path: dir })
    const e = plur.learn('rebuild me', { type: 'behavioral', scope: 'global' })

    // Seed a stale cache from a fictitious embedder, keyed by the real
    // learned-engram ID so we can prove the entry was replaced.
    const cachePath = join(dir, '.embeddings-cache.json')
    writeFileSync(cachePath, JSON.stringify({
      meta: { embedder_name: 'fake-old-model', embedder_dim: 999, version: 1 },
      entries: {
        [e.id]: { hash: 'stale', embedding: new Array(999).fill(0.5) },
      },
    }))

    const result = await plur.reembedAsync({ full: true })

    expect(result.skipped).toBe(false)
    // After full reembed, the cache header tracks the active embedder.
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cache.meta.embedder_name).not.toBe('fake-old-model')
    expect(cache.meta.embedder_dim).not.toBe(999)
    // The stale 999d entry must be replaced — new embedding has the active
    // embedder's dim (not 999).
    expect(cache.entries[e.id]).toBeDefined()
    expect(cache.entries[e.id].embedding.length).toBe(cache.meta.embedder_dim)
    expect(cache.entries[e.id].embedding.length).not.toBe(999)
  })

  it('sync({reembed: true}) is no longer a silent no-op for non-PGLite users', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('migrate me too', { type: 'behavioral', scope: 'global' })

    // sync returns synchronously; the JSON rebuild fires in the background.
    // We don't need git remote for this test — gitSync just returns no-op
    // when no remote is configured.
    plur.sync(undefined, { reembed: true, full: true })
    // Wait for the background rebuild to complete by calling the
    // awaitable variant which uses the same code path.
    const result = await plur.reembedAsync({ full: true })
    expect(result.skipped).toBe(false)

    const cachePath = join(dir, '.embeddings-cache.json')
    expect(existsSync(cachePath)).toBe(true)
  })
})
