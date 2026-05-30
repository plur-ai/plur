/**
 * Doctor / sync warning for the JSON `.embeddings-cache.json` path.
 * Sprint 0 iter-2 audit B-3 — closes RC-3 for the default (non-PGLite)
 * backend, which is ~99% of installs.
 *
 * Before this fix: `checkEmbedderDimMismatch` only checked the PGLite vector
 * column. Default users got no warning when switching embedders — their
 * cached 384d vectors silently mis-scored against new 768d queries.
 *
 * After this fix: the helper also reads the cache's meta header
 * `{ embedder_name, embedder_dim }` and surfaces a warning when either
 * differs from the active embedder. Legacy flat-object caches are also
 * flagged as a hard mismatch (no embedder identity).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { checkEmbedderDimMismatch, defaultJsonCachePath } from '../src/embedders/dim-check.js'

describe('checkEmbedderDimMismatch — JSON cache path (iter-2 audit B-3)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string
  let jsonCachePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-doctor-json-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
    jsonCachePath = defaultJsonCachePath(dir)
    writeFileSync(yamlPath, '[]')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no JSON cache exists and no PGLite store', async () => {
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 384,
      jsonCachePath,
      activeEmbedderName: 'bge-small',
    })
    expect(warning).toBeNull()
  })

  it('returns a warning when the JSON cache has a different embedder_dim', async () => {
    writeFileSync(jsonCachePath, JSON.stringify({
      meta: { embedder_name: 'embedding-gemma', embedder_dim: 768, version: 1 },
      entries: {},
    }))
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 384,
      jsonCachePath,
      activeEmbedderName: 'bge-small',
    })
    expect(warning).not.toBeNull()
    expect(warning!.source).toBe('json-cache')
    expect(warning!.indexedDim).toBe(768)
    expect(warning!.activeDim).toBe(384)
    expect(warning!.message).toMatch(/plur sync --reembed --full/)
  })

  it('returns a warning when the JSON cache has a different embedder_name at same dim', async () => {
    // Same dim, different family — both 384d but minilm vs bge-small vectors
    // live in incompatible spaces.
    writeFileSync(jsonCachePath, JSON.stringify({
      meta: { embedder_name: 'minilm', embedder_dim: 384, version: 1 },
      entries: {},
    }))
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 384,
      jsonCachePath,
      activeEmbedderName: 'bge-small',
    })
    expect(warning).not.toBeNull()
    expect(warning!.source).toBe('json-cache')
    expect(warning!.message).toMatch(/minilm/)
  })

  it('flags a legacy flat-object cache (no meta header) as a hard mismatch', async () => {
    writeFileSync(jsonCachePath, JSON.stringify({
      'ENG-2026-0530-001': { hash: 'h', embedding: [0.1, 0.2, 0.3] },
    }))
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 384,
      jsonCachePath,
      activeEmbedderName: 'bge-small',
    })
    expect(warning).not.toBeNull()
    expect(warning!.source).toBe('json-cache')
    expect(warning!.message).toMatch(/legacy format/)
    expect(warning!.message).toMatch(/plur sync --reembed --full/)
  })

  it('returns null when the cache header matches the active embedder', async () => {
    writeFileSync(jsonCachePath, JSON.stringify({
      meta: { embedder_name: 'bge-small', embedder_dim: 384, version: 1 },
      entries: {},
    }))
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 384,
      jsonCachePath,
      activeEmbedderName: 'bge-small',
    })
    expect(warning).toBeNull()
  })
})
