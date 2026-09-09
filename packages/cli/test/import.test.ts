import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, execFileSync } from 'child_process'
import { createRequire } from 'module'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
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

  it.each(['--path', '--file'])('uses PLUR_PATH for the destination when %s supplies the input', async flag => {
    const input = join(work, 'source with spaces.json')
    const bytes = JSON.stringify([{ statement: 'Environment-selected import destination', created_at: '2025-01-02T03:04:05Z' }])
    writeFileSync(input, bytes)
    writeFileSync(join(store, 'config.yaml'), 'index: false\n')
    const report = JSON.parse(execFileSync(process.execPath, [CLI, 'import', '--from', 'generic', flag, input, '--json'], {
      cwd: work, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PLUR_PATH: store, PLUR_AUTO_DISCOVER: '0' },
    }))
    expect(report.imported).toBe(1)
    expect(report.errors).toBe(0)
    expect(readFileSync(input, 'utf8')).toBe(bytes)
    const plur = new Plur({ path: store, autoDiscover: false })
    expect((await plur.list())[0].temporal?.learned_at).toBe('2025-01-02T03:04:05Z')
  })

  it('keeps an explicit --store override separate from the input and environment default', async () => {
    const input = join(work, 'source.json')
    const bytes = JSON.stringify([{ statement: 'Explicit import destination wins' }])
    writeFileSync(input, bytes)
    writeFileSync(join(store, 'config.yaml'), 'index: false\n')
    const report = JSON.parse(execFileSync(process.execPath, [CLI, 'import', '--from', 'generic', '--path', input, '--store', store, '--json'], {
      cwd: work, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PLUR_PATH: join(work, 'unused-store'), PLUR_AUTO_DISCOVER: '0' },
    }))
    expect(report.imported).toBe(1)
    expect(readFileSync(input, 'utf8')).toBe(bytes)
    const plur = new Plur({ path: store, autoDiscover: false })
    expect(await plur.list()).toHaveLength(1)
  })

  it('imports a generic JSON file and prints a migration report', async () => {
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
    expect(await plur.list({})).toHaveLength(2)
  })

  it('imports the mem0 fixture', async () => {
    const report = JSON.parse(run(`--from mem0 --path ${join(CORE_FIXTURES, 'mem0-export.json')}`))
    expect(report.imported).toBe(3)
    const plur = new Plur({ path: store })
    const darkMode = (await plur.list({})).find(e => e.statement.includes('dark mode'))
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

  it('supports --dry-run (report only, no writes)', async () => {
    const input = join(work, 'memories.json')
    writeFileSync(input, JSON.stringify([{ statement: 'dry run fact' }]))
    const report = JSON.parse(run(`--from generic --path ${input} --dry-run`))
    expect(report.dry_run).toBe(true)
    expect(report.imported).toBe(1)
    const plur = new Plur({ path: store })
    expect(await plur.list({})).toHaveLength(0)
  })

  it('supports --scope override', async () => {
    const input = join(work, 'memories.json')
    writeFileSync(input, JSON.stringify([{ statement: 'scoped cli fact' }]))
    run(`--from generic --path ${input} --scope project:cli-test`)
    const plur = new Plur({ path: store })
    expect((await plur.list({}))[0].scope).toBe('project:cli-test')
  })

  it('supports --mapping for generic imports', async () => {
    const input = join(work, 'custom.json')
    writeFileSync(input, JSON.stringify([{ note: 'mapped cli fact', area: 'dev.cli' }]))
    const mapping = join(work, 'mapping.json')
    writeFileSync(mapping, JSON.stringify({ fields: { statement: 'note', domain: 'area' } }))
    const report = JSON.parse(run(`--from generic --path ${input} --mapping ${mapping}`))
    expect(report.imported).toBe(1)
    const plur = new Plur({ path: store })
    expect((await plur.list({}))[0].domain).toBe('dev.cli')
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
