/**
 * Doctor / sync warning when the configured embedder's dim differs from the
 * dim of the PGLite-indexed `engram_embeddings` column.
 *
 * Sprint 0 PR 5 (feat/embedding-gemma-default), closes plur-ai/plur#219.
 *
 * Contract: a helper exported from @plur-ai/core returns a structured warning
 * (or null) so both the CLI `plur doctor` command and the MCP session-start
 * check can surface the same message. The message must point at
 * `plur sync --reembed --full` so the fix is obvious.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { checkEmbedderDimMismatch } from '../src/embedders/dim-check.js'

const PGLITE_TIMEOUT = 30_000

describe('checkEmbedderDimMismatch — PR 5 (#219)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-dim-check-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
    writeFileSync(yamlPath, yaml.dump({ engrams: [] }))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when there is no PGLite index on disk', async () => {
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 768,
    })
    expect(warning).toBeNull()
  })

  it('returns null when dims match', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 768 })
    await adapter.reindex()
    await adapter.close()
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 768,
    })
    expect(warning).toBeNull()
  }, PGLITE_TIMEOUT)

  it('returns a warning when dims differ', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter.reindex()
    await adapter.close()
    const warning = await checkEmbedderDimMismatch({
      pglitePath: dbPath,
      yamlPath,
      activeEmbedderDim: 768,
    })
    expect(warning).not.toBeNull()
    expect(warning!.indexedDim).toBe(384)
    expect(warning!.activeDim).toBe(768)
    expect(warning!.message).toMatch(/plur sync --reembed --full/)
  }, PGLITE_TIMEOUT)
})
