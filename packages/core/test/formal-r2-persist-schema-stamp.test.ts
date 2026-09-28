/**
 * Formal-verification round 2 (spec/formal/PlurSpec/R2Persist.lean §4,
 * findings/r2-persist.md item 4): the corpus and the schema version it claims
 * must change together.
 *
 * `runMigrations`/`rollbackMigrations` save the migrated corpus and THEN stamp
 * `schema_version` in config.yaml. When the stamp throws (here: another process
 * holds the config lock), the corpus had already changed while the version had
 * not. After a failed rollback the store says "current" over a rolled-back
 * corpus, and nothing ever migrates it again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import yaml from 'js-yaml'
import { runMigrations, rollbackMigrations, getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../src/migrations/runner.js'

function legacyEngram(id: string) {
  return {
    id,
    statement: `statement for ${id}`,
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-26' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  }
}

describe('formal-r2-persist: schema stamp failure after the corpus write', () => {
  let dir: string
  let engramsPath: string
  let configPath: string
  // A live holder (this process) of the config lock: setSchemaVersion's withLock gives up.
  const holdConfigLock = () => writeFileSync(configPath + '.lock', `${hostname()}:${process.pid}:1:0`)
  const releaseConfigLock = () => unlinkSync(configPath + '.lock')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2stamp-'))
    engramsPath = join(dir, 'engrams.yaml')
    configPath = join(dir, 'config.yaml')
    writeFileSync(engramsPath, yaml.dump({ engrams: [legacyEngram('ENG-2026-09-26-001'), legacyEngram('ENG-2026-09-26-002')] }))
    writeFileSync(configPath, 'schema_version: 0\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a failed run leaves corpus and version as they were', () => {
    const before = readFileSync(engramsPath)
    holdConfigLock()
    expect(() => runMigrations(engramsPath, configPath)).toThrow()
    releaseConfigLock()
    expect(getSchemaVersion(configPath)).toBe(0)
    expect(readFileSync(engramsPath).equals(before)).toBe(true)
    // The put-back is complete, so no recovery journal is left for a later run.
    expect(existsSync(`${engramsPath}.migration.json`)).toBe(false)
  }, 30_000)

  it('a failed rollback leaves corpus and version as they were', () => {
    runMigrations(engramsPath, configPath)
    expect(getSchemaVersion(configPath)).toBe(CURRENT_SCHEMA_VERSION)
    const migrated = readFileSync(engramsPath)
    holdConfigLock()
    expect(() => rollbackMigrations(engramsPath, configPath, 0)).toThrow()
    releaseConfigLock()
    expect(getSchemaVersion(configPath)).toBe(CURRENT_SCHEMA_VERSION)
    expect(readFileSync(engramsPath).equals(migrated)).toBe(true)
    expect(existsSync(`${engramsPath}.migration.json`)).toBe(false)
  }, 30_000)

  it('without the fault, run and rollback still write and stamp', () => {
    runMigrations(engramsPath, configPath)
    expect(getSchemaVersion(configPath)).toBe(CURRENT_SCHEMA_VERSION)
    rollbackMigrations(engramsPath, configPath, 0)
    expect(getSchemaVersion(configPath)).toBe(0)
  }, 30_000)
})
