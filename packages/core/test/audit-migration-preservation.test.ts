/** Invariant: a failed in-memory migration never changes the live corpus,
 * even when an older backup exists and successful writes followed that backup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ALL_MIGRATIONS, getSchemaVersion, runMigrations, rollbackMigrations, setSchemaVersion } from '../src/migrations/runner.js'
import { saveEngrams } from '../src/engrams.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'

let root: string
let store: string
let config: string
// Models a CRASH at a commit boundary: the first write to `fault.path` fails,
// and so does every write after it, as if the process had died there. A
// plain throw is not a crash: after one, commitMigration puts the corpus back
// (formal round 2, r2-persist §4), which formal-r2-persist-schema-stamp tests.
// `throwOnly` instead models a plain failure of that one write (no crash),
// and `unlinkJournal` a failure to remove the recovery journal.
const fault = vi.hoisted(() => ({ path: '', crashed: false, throwOnly: false, unlinkJournal: false }))
vi.mock('../src/sync.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/sync.js')>()
  return { ...original, atomicWrite: (...args: Parameters<typeof original.atomicWrite>) => {
    if (fault.crashed || (fault.path !== '' && args[0] === fault.path)) {
      if (!fault.throwOnly) fault.crashed = true
      throw new Error('injected commit interruption')
    }
    return original.atomicWrite(...args)
  } }
})
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, unlinkSync: (target: import('node:fs').PathLike) => {
    if (fault.unlinkJournal && String(target).endsWith('.migration.json')) throw new Error('injected unlink failure')
    return real.unlinkSync(target)
  } }
})
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'plur-migration-preserve-'))
  store = join(root, 'engrams.yaml')
  config = join(root, 'config.yaml')
  fault.path = ''; fault.crashed = false; fault.throwOnly = false; fault.unlinkJournal = false
})

it.each(['up', 'down'] as const)('recovers %s after corpus replacement but before the version stamp', direction => {
  saveEngrams(store, [row(1), row(2)])
  setSchemaVersion(config, direction === 'up' ? 0 : ALL_MIGRATIONS.length)
  const run = () => direction === 'up' ? runMigrations(store, config) : rollbackMigrations(store, config, 0)
  fault.path = config
  expect(run).toThrow('injected commit interruption')
  const committed = fs.readFileSync(store, 'utf8')
  expect(fs.existsSync(`${store}.migration.json`)).toBe(true)
  fault.path = ''; fault.crashed = false
  for (const migration of ALL_MIGRATIONS) vi.spyOn(migration, direction).mockImplementation(() => { throw new Error('must not replay') })
  run()
  expect(fs.readFileSync(store, 'utf8')).toBe(committed)
  expect(getSchemaVersion(config)).toBe(direction === 'up' ? ALL_MIGRATIONS.length : 0)
  expect(fs.existsSync(`${store}.migration.json`)).toBe(false)
})

it('does not overwrite intervening writes while recovering an interrupted migration', () => {
  saveEngrams(store, [row(1)])
  setSchemaVersion(config, 0)
  fault.path = config
  expect(() => runMigrations(store, config)).toThrow('injected commit interruption')
  fault.path = ''; fault.crashed = false
  saveEngrams(store, [row(1), row(2)])
  const newer = fs.readFileSync(store, 'utf8')
  expect(() => runMigrations(store, config)).toThrow(/reconcile/)
  expect(fs.readFileSync(store, 'utf8')).toBe(newer)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

function row(n: number) {
  return EngramSchemaPassthrough.parse({ id: `ENG-2026-09-08-${n}`, statement: `Keep record ${n}`, type: 'behavioral', scope: 'local', status: 'active', version: 2 })
}

describe('failed transformation preserves current data', () => {
  it.each(['up', 'down'] as const)('%s failure cannot restore a stale backup', direction => {
    const version = direction === 'up' ? 0 : ALL_MIGRATIONS.length
    saveEngrams(store, [row(1)])
    fs.copyFileSync(store, `${store}.bak.${version}`)
    const oldBackup = fs.readFileSync(`${store}.bak.${version}`, 'utf8')
    saveEngrams(store, [row(1), row(2)])
    setSchemaVersion(config, version)
    const before = fs.readFileSync(store, 'utf8')
    const migration = direction === 'up' ? ALL_MIGRATIONS[0] : ALL_MIGRATIONS.at(-1)!
    vi.spyOn(migration, direction).mockImplementation(() => { throw new Error('injected transformation failure') })
    expect(() => direction === 'up' ? runMigrations(store, config) : rollbackMigrations(store, config, 0))
      .toThrow('injected transformation failure')
    expect(fs.readFileSync(store, 'utf8')).toBe(before)
    expect(getSchemaVersion(config)).toBe(version)
    expect(fs.readFileSync(`${store}.bak.${version}`, 'utf8')).toBe(oldBackup)
  })

  it.each([-1, 1.5, NaN, Infinity, ALL_MIGRATIONS.length + 1])('rejects invalid recorded version %s before mutation', version => {
    saveEngrams(store, [row(1)])
    fs.writeFileSync(config, `schema_version: ${String(version)}\n`)
    const before = fs.readFileSync(store, 'utf8')
    expect(() => runMigrations(store, config)).toThrow(/version/i)
    expect(fs.readFileSync(store, 'utf8')).toBe(before)
    expect(fs.readdirSync(root).filter(f => f.includes('.bak.'))).toEqual([])
  })

  it.each([0.5, NaN, Infinity])('rejects invalid rollback target %s before mutation', version => {
    saveEngrams(store, [row(1)])
    setSchemaVersion(config, ALL_MIGRATIONS.length)
    const before = fs.readFileSync(store, 'utf8')
    expect(() => rollbackMigrations(store, config, version)).toThrow(/version/i)
    expect(fs.readFileSync(store, 'utf8')).toBe(before)
  })
})

describe('migration configuration fails closed', () => {
  // A malformed config used to read as schema_version 0, so `plur migrate`
  // would re-run every migration over an already-migrated corpus.
  it.each(['read', 'stamp'] as const)('%s refuses malformed YAML without exposing or changing its contents', operation => {
    const source = 'token: [audit-secret-value\n'
    fs.writeFileSync(config, source)
    let failure: unknown
    try { operation === 'read' ? getSchemaVersion(config) : setSchemaVersion(config, 1) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('audit-secret-value')
    expect(fs.readFileSync(config, 'utf8')).toBe(source)
  })

  it('does not run migrations over a corpus whose config cannot be read', () => {
    saveEngrams(store, [row(1)])
    fs.writeFileSync(config, 'schema_version: [\n')
    const before = fs.readFileSync(store, 'utf8')
    expect(() => runMigrations(store, config)).toThrow(/migration configuration/)
    expect(fs.readFileSync(store, 'utf8')).toBe(before)
  })

  it('still treats a missing config as version 0', () => {
    expect(getSchemaVersion(config)).toBe(0)
  })
})

describe('round-2 review: configuration shapes, file modes and actionable refusals', () => {
  it.each(['', '# comment only\n', '---\n'])('treats an empty or comment-only config as an empty mapping: %j', source => {
    fs.writeFileSync(config, source)
    expect(getSchemaVersion(config)).toBe(0)
    setSchemaVersion(config, 1)
    expect(getSchemaVersion(config)).toBe(1)
  })

  it.each(['42\n', '- a\n- b\n'])('still refuses a scalar or list config: %j', source => {
    fs.writeFileSync(config, source)
    expect(() => getSchemaVersion(config)).toThrow(/mapping/)
    expect(() => setSchemaVersion(config, 1)).toThrow()
    expect(fs.readFileSync(config, 'utf8')).toBe(source)
  })

  it('says a store from a newer PLUR needs an upgrade', () => {
    fs.writeFileSync(config, `schema_version: ${ALL_MIGRATIONS.length + 1}\n`)
    expect(() => getSchemaVersion(config)).toThrow(/newer PLUR.*Upgrade PLUR/s)
  })

  it.skipIf(process.platform === 'win32')('keeps the version backup as private as the corpus', () => {
    saveEngrams(store, [row(1)])
    fs.chmodSync(store, 0o600)
    setSchemaVersion(config, 0)
    runMigrations(store, config)
    expect(fs.statSync(`${store}.bak.0`).mode & 0o777).toBe(0o600)
  })

  it('names the journal and how to reconcile when an interrupted migration cannot complete', () => {
    saveEngrams(store, [row(1)])
    setSchemaVersion(config, 0)
    fault.path = config
    expect(() => runMigrations(store, config)).toThrow('injected commit interruption')
    fault.path = ''; fault.crashed = false
    saveEngrams(store, [row(1), row(2)])
    let message = ''
    try { runMigrations(store, config) } catch (error) { message = String(error) }
    expect(message).toContain(`${store}.migration.json`)
    expect(message).toMatch(/schema_version: \d+/)
    expect(message).toMatch(/delete the journal/)
  })
})

describe('reconciliation with #1228: stamp failure and last-written bookkeeping', () => {
  it('says the corpus was restored when only removing the journal fails, and the next run clears it', () => {
    saveEngrams(store, [row(1)])
    setSchemaVersion(config, 0)
    const before = fs.readFileSync(store, 'utf8')
    fault.path = config; fault.throwOnly = true; fault.unlinkJournal = true
    let message = ''
    try { runMigrations(store, config) } catch (error) { message = String(error) }
    expect(message).toMatch(/restored to its previous contents/)
    expect(message).toMatch(/next migration run only clears the journal/)
    expect(fs.readFileSync(store, 'utf8')).toBe(before)
    expect(fs.existsSync(`${store}.migration.json`)).toBe(true)
    fault.path = ''; fault.throwOnly = false; fault.unlinkJournal = false
    runMigrations(store, config)
    expect(fs.existsSync(`${store}.migration.json`)).toBe(false)
    expect(getSchemaVersion(config)).toBe(ALL_MIGRATIONS.length)
  })

  it('records the live store, not the staged file, as last written', () => {
    fs.mkdirSync(join(root, 'backups'))
    saveEngrams(store, [row(1), row(2)])
    setSchemaVersion(config, 0)
    runMigrations(store, config)
    const record = JSON.parse(fs.readFileSync(join(root, 'backups', '.last-written.json'), 'utf8'))
    expect(record).toEqual({ file: 'engrams.yaml', count: 2 })
  })
})
