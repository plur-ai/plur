import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

// Skip if better-sqlite3 is not installed
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let hasSqlite = false
try {
  require('better-sqlite3')
  hasSqlite = true
} catch {}

describe.skipIf(!hasSqlite)('SQLite indexed storage', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-indexed-'))
    writeFileSync(join(dir, 'config.yaml'), 'index: true\n')
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('learn and recall work with index enabled', async () => {
    const engram = await plur.learn('API uses snake_case', { scope: 'project:myapp', type: 'behavioral' })
    expect(engram.id).toMatch(/^ENG-/)
    const results = await plur.recall('API naming convention snake')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].statement).toContain('snake_case')
  })

  it('creates db file when index is enabled', async () => {
    await plur.learn('Test engram for indexing', { scope: 'global' })
    expect(existsSync(join(dir, 'engrams.db'))).toBe(true)
  })

  it('reindex rebuilds db from YAML', async () => {
    await plur.learn('First engram', { scope: 'global' })
    await plur.learn('Second engram', { scope: 'global' })
    const dbPath = join(dir, 'engrams.db')
    if (existsSync(dbPath)) rmSync(dbPath)
    expect(existsSync(dbPath)).toBe(false)
    await plur.reindex()
    expect(existsSync(dbPath)).toBe(true)
    const results = await plur.list()
    expect(results.length).toBe(2)
  })

  it('forget + compact works with index', async () => {
    const e1 = await plur.learn('Keep this', { scope: 'global' })
    const e2 = await plur.learn('Remove this', { scope: 'global' })
    await plur.forget(e2.id, 'test')
    await plur.compact()
    const all = await plur.list()
    expect(all.length).toBe(1)
    expect(all[0].id).toBe(e1.id)
  })

  it('feedback persists through index', async () => {
    const engram = await plur.learn('Use feature flags', { scope: 'global' })
    await plur.feedback(engram.id, 'positive')
    const recalled = await plur.recall('feature flags')
    expect(recalled[0].feedback_signals?.positive).toBe(1)
  })

  it('status returns correct count with index', async () => {
    await plur.learn('Indexed engram', { scope: 'global' })
    const status = await plur.status()
    expect(status.engram_count).toBe(1)
  })
})
