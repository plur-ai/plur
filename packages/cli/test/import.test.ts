import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { Plur } from '@plur-ai/core'

const CLI = join(__dirname, '..', 'dist', 'index.js')
// Checked-in format fixtures live in core (single source of truth for the
// format contracts); the CLI suite reuses them for end-to-end runs.
const CORE_FIXTURES = join(__dirname, '..', '..', 'core', 'test', 'fixtures', 'import')

// Issue #441 — `plur import --from <source> --path <file>`.
//
// NOTE the flag split: for `import`, `--path` is the INPUT FILE (per the issue
// spec). The storage directory override (what --path means on every other
// command) is `--store` here.

describe('plur import', () => {
  let store: string
  let work: string

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'plur-cli-import-store-'))
    work = mkdtempSync(join(tmpdir(), 'plur-cli-import-work-'))
  })
  afterEach(() => {
    rmSync(store, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  function run(args: string): string {
    return execSync(`node ${CLI} import ${args} --store ${store} --json`, {
      encoding: 'utf-8',
      timeout: 20000,
    }).trim()
  }

  it('imports a generic JSON file and prints a migration report', () => {
    const input = join(work, 'memories.json')
    writeFileSync(input, JSON.stringify([
      { statement: 'cli import fact one' },
      { statement: 'cli import fact two' },
      { statement: 'cli import fact one' },
    ]))
    const report = JSON.parse(run(`--from generic --path ${input}`))
    expect(report.from).toBe('generic')
    expect(report.total).toBe(3)
    expect(report.imported).toBe(2)
    expect(report.skipped).toBe(1)
    expect(report.conflicts).toBe(0)
    const plur = new Plur({ path: store })
    expect(plur.list({})).toHaveLength(2)
  })

  it('imports the mem0 fixture', () => {
    const report = JSON.parse(run(`--from mem0 --path ${join(CORE_FIXTURES, 'mem0-export.json')}`))
    expect(report.imported).toBe(3)
    const plur = new Plur({ path: store })
    const darkMode = plur.list({}).find(e => e.statement.includes('dark mode'))
    expect(darkMode?.scope).toBe('user:alice')
  })

  it('imports a gp-engram .db', () => {
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    const dbPath = join(work, 'engram.db')
    const db = new Database(dbPath)
    db.exec(readFileSync(join(CORE_FIXTURES, 'gp-engram-fixture.sql'), 'utf-8'))
    db.close()

    const report = JSON.parse(run(`--from gp-engram --path ${dbPath}`))
    expect(report.imported).toBe(3)
    expect(report.skipped).toBe(0)
  })

  it('supports --dry-run (report only, no writes)', () => {
    const input = join(work, 'memories.json')
    writeFileSync(input, JSON.stringify([{ statement: 'dry run fact' }]))
    const report = JSON.parse(run(`--from generic --path ${input} --dry-run`))
    expect(report.dry_run).toBe(true)
    expect(report.imported).toBe(1)
    const plur = new Plur({ path: store })
    expect(plur.list({})).toHaveLength(0)
  })

  it('supports --scope override', () => {
    const input = join(work, 'memories.json')
    writeFileSync(input, JSON.stringify([{ statement: 'scoped cli fact' }]))
    run(`--from generic --path ${input} --scope project:cli-test`)
    const plur = new Plur({ path: store })
    expect(plur.list({})[0].scope).toBe('project:cli-test')
  })

  it('supports --mapping for generic imports', () => {
    const input = join(work, 'custom.json')
    writeFileSync(input, JSON.stringify([{ note: 'mapped cli fact', area: 'dev.cli' }]))
    const mapping = join(work, 'mapping.json')
    writeFileSync(mapping, JSON.stringify({ fields: { statement: 'note', domain: 'area' } }))
    const report = JSON.parse(run(`--from generic --path ${input} --mapping ${mapping}`))
    expect(report.imported).toBe(1)
    const plur = new Plur({ path: store })
    expect(plur.list({})[0].domain).toBe('dev.cli')
  })

  it('exits 1 with a clear error for an unknown --from', () => {
    const input = join(work, 'x.json')
    writeFileSync(input, '[]')
    expect(() => run(`--from supermemory --path ${input}`)).toThrow()
  })

  it('exits 1 with a not-implemented error for the zep stub', () => {
    const input = join(work, 'x.json')
    writeFileSync(input, '[]')
    let message = ''
    try {
      run(`--from zep --path ${input}`)
    } catch (err: any) {
      message = String(err.stdout ?? '') + String(err.stderr ?? '') + String(err.message ?? '')
    }
    expect(message).toMatch(/not.*implemented/i)
  })

  it('exits 1 when --path is missing', () => {
    expect(() => run('--from generic')).toThrow()
  })
})
