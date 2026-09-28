/**
 * Formal-verification round 2 (spec/formal/PlurSpec/R2Persist.lean §5,
 * findings/r2-persist.md item 5, core-persistence#9): the PGLite skip-if-unchanged
 * guard must not skip a real change.
 *
 * The guard compared `size:mtimeMs`. A same-size rewrite inside one mtime tick —
 * a feedback counter going 1 → 2, on a filesystem with coarse timestamps (the
 * reason yaml-primary-store.ts never trusts mtime alone, #25) — kept both, so
 * `syncFromYaml` returned early and the index kept serving the old text.
 * The tick is simulated by putting the old mtime back with `utimes`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'

const TIMEOUT = 60_000

function doc(statement: string): string {
  return yaml.dump({
    engrams: [{
      id: 'ENG-2026-09-26-001',
      statement,
      type: 'behavioral',
      scope: 'global',
      status: 'active',
      tags: [],
      activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-26' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    }],
  })
}

describe('formal-r2-persist: PGLite fingerprint', () => {
  let dir: string
  let adapter: PGLiteAdapter
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2fp-')) })
  afterEach(async () => {
    await adapter?.close?.()
    rmSync(dir, { recursive: true, force: true })
  })

  const indexed = async (): Promise<string> => {
    const db = await (adapter as unknown as { getDb: () => Promise<{ query: (q: string) => Promise<{ rows: Array<{ s: string }> }> }> }).getDb()
    return (await db.query("SELECT data->>'statement' AS s FROM engrams")).rows[0]?.s
  }

  it('a same-size rewrite in the same mtime tick reaches the index', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, doc('deploy host is alpha'))
    // An mtime well in the past, as if the file had been quiet for a while.
    const old = new Date(Date.now() - 60_000)
    utimesSync(yamlPath, old, old)
    adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: 384 })
    await adapter.syncFromYaml()
    expect(await indexed()).toBe('deploy host is alpha')

    const before = statSync(yamlPath)
    writeFileSync(yamlPath, doc('deploy host is gamma')) // same length, in place
    utimesSync(yamlPath, before.atime, before.mtime)    // same mtime tick
    expect(statSync(yamlPath).size).toBe(before.size)
    await adapter.syncFromYaml()
    expect(await indexed()).toBe('deploy host is gamma')
  }, TIMEOUT)

  it('an unchanged file is still recognised as unchanged (and a change after it is still seen)', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, doc('one'))
    adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: 384 })
    await adapter.syncFromYaml()
    await adapter.syncFromYaml()
    expect(await indexed()).toBe('one')
    writeFileSync(yamlPath, doc('two, longer'))
    await adapter.syncFromYaml()
    expect(await indexed()).toBe('two, longer')
  }, TIMEOUT)
})
