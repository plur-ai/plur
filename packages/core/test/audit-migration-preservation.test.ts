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
const fault = vi.hoisted(() => ({ path: '' }))
vi.mock('../src/sync.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/sync.js')>()
  return { ...original, atomicWrite: (...args: Parameters<typeof original.atomicWrite>) => {
    if (args[0] === fault.path) throw new Error('injected commit interruption')
    return original.atomicWrite(...args)
  } }
})
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'plur-migration-preserve-'))
  store = join(root, 'engrams.yaml')
  config = join(root, 'config.yaml')
  fault.path = ''
})

it.each(['up', 'down'] as const)('recovers %s after corpus replacement but before the version stamp', direction => {
  saveEngrams(store, [row(1), row(2)])
  setSchemaVersion(config, direction === 'up' ? 0 : ALL_MIGRATIONS.length)
  const run = () => direction === 'up' ? runMigrations(store, config) : rollbackMigrations(store, config, 0)
  fault.path = config
  expect(run).toThrow('injected commit interruption')
  const committed = fs.readFileSync(store, 'utf8')
  expect(fs.existsSync(`${store}.migration.json`)).toBe(true)
  fault.path = ''
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
  fault.path = ''
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
