/**
 * Duplicate ids in one engrams.yaml must not abort the PGLite sync
 * (data-loss audit F7, a regression the batched upserts introduced).
 *
 * parseEngramFile does not reject duplicate ids, so both copies reach the
 * upsert. The old per-row loop tolerated that last-wins; the batched
 * multi-row `INSERT ... ON CONFLICT DO UPDATE` raised Postgres's "cannot
 * affect row a second time" instead — permanently, because the documented
 * recovery (`plur sync --full` → reindex) built the same statement and hit
 * the same error. The user was told to run a command that could not help.
 *
 * The OUTCOME changed with owner decision P1 (2026-09-27, "keep both, rename
 * one"; findings/r2-persist.md item 2). These tests used to pin last-wins: the
 * index kept the second copy and the first was unreachable. Now the index
 * follows the loader's one rule — the first copy keeps the id, a later
 * different copy is indexed under a fresh id — so both engrams are searchable.
 * The F7 property (no abort, no "cannot affect row a second time") is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { loadEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

const PGLITE_TIMEOUT = 60_000

function mkEngram(id: string, statement: string): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope: 'project:plur',
    domain: 'plur.test',
    status: 'active',
    tags: [],
    activation: { retrieval_strength: 1.0, storage_strength: 1.0, frequency: 0, last_accessed: '2026-08-27' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

describe('duplicate ids in one YAML (F7)', () => {
  let dir: string
  let adapter: PGLiteAdapter

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-dup-ids-')) })
  afterEach(async () => {
    await adapter?.close?.()
    rmSync(dir, { recursive: true, force: true })
  })

  it('syncFromYaml keeps both copies: the first under its id, the later under a fresh id (P1)', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    const list = [
      mkEngram('ENG-DUP-1', 'first copy'),
      mkEngram('ENG-OTHER', 'unrelated'),
      mkEngram('ENG-DUP-1', 'second copy'),
    ]
    writeFileSync(yamlPath, yaml.dump({ engrams: list }), 'utf8')
    const renamed = loadEngrams(yamlPath)[2].id // the loader's rule decides the fresh id

    adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: 384 })
    await adapter.syncFromYaml() // used to throw "cannot affect row a second time"

    const db = await (adapter as unknown as { getDb: () => Promise<{ query: (q: string) => Promise<{ rows: Array<Record<string, unknown>> }> }> }).getDb()
    const rows = await db.query("SELECT id, data->>'statement' AS s FROM engrams ORDER BY id")
    expect(renamed).not.toBe('ENG-DUP-1')
    expect(rows.rows).toEqual([
      { id: 'ENG-DUP-1', s: 'first copy' },
      { id: renamed, s: 'second copy' },
      { id: 'ENG-OTHER', s: 'unrelated' },
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  }, PGLITE_TIMEOUT)

  it('reindex — the documented recovery path — also keeps both copies (P1)', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    const list = [mkEngram('ENG-DUP-2', 'a'), mkEngram('ENG-DUP-2', 'b')]
    writeFileSync(yamlPath, yaml.dump({ engrams: list }), 'utf8')
    const renamed = loadEngrams(yamlPath)[1].id

    adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: 384 })
    await adapter.reindex()

    const db = await (adapter as unknown as { getDb: () => Promise<{ query: (q: string) => Promise<{ rows: Array<Record<string, unknown>> }> }> }).getDb()
    const rows = await db.query("SELECT id, data->>'statement' AS s FROM engrams ORDER BY s")
    expect(rows.rows).toEqual([{ id: 'ENG-DUP-2', s: 'a' }, { id: renamed, s: 'b' }])
  }, PGLITE_TIMEOUT)
})
