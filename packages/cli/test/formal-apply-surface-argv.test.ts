/**
 * Formal-verification apply phase, decision S4 (1), 2026-09-26.
 *
 * `plur learn` honours `--`: the token after it is the statement, stored
 * verbatim, and global flags are no longer parsed after `--` — so a statement
 * such as "--path=/elsewhere …" can never select (or create) a store.
 * Before: `learn -- "<x>"` stored the literal "--", and `--path=…` inside a
 * statement was expanded and parsed as the global --path flag.
 * spec/formal/findings/adapters.md §7, PlurSpec/Adapters.lean §7.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { parseGlobalFlags } from '../src/plur.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('parseGlobalFlags stops at `--` (S4.1)', () => {
  it('leaves every token after `--` verbatim, including global-flag lookalikes', () => {
    const r = parseGlobalFlags(['learn', '--json', '--', '--path=/elsewhere', '--quiet', '--json'])
    expect(r.flags.path).toBeUndefined()
    expect(r.flags.quiet).toBeUndefined()
    expect(r.flags.json).toBe(true)
    expect(r.args).toEqual(['learn', '--', '--path=/elsewhere', '--quiet', '--json'])
    expect(r.error).toBeUndefined()
  })

  it('still parses global flags before `--` (good case)', () => {
    const r = parseGlobalFlags(['learn', '--path', '/p', '--', 'x'])
    expect(r.flags.path).toBe('/p')
    expect(r.args).toEqual(['learn', '--', 'x'])
  })
})

describe('plur learn -- <statement> stores the statement verbatim (S4.1)', () => {
  let dir: string
  const run = (args: string[]) => {
    const r = spawnSync('node', [CLI, ...args], {
      encoding: 'utf8', timeout: 60_000, input: '',
      env: { ...process.env, PLUR_PATH: dir, HOME: dir, USERPROFILE: dir },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const stored = () => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-argv-'))
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a flag-like statement after `--` is stored, not "--"', { timeout: 60_000 }, () => {
    const st = '--dry-run=true is required for every deploy'
    const r = run(['learn', '--path', dir, '--json', '--scope', 'global', '--', st])
    expect(r.code, r.err).toBe(0)
    expect(stored()).toContain(st)
    expect(stored()).not.toMatch(/statement: ['"]?--['"]?\s*$/m)
  })

  it('"--path=…" after `--` never selects or creates a store', { timeout: 60_000 }, () => {
    const other = join(dir, 'other')
    const st = `--path=${other} is where the fixtures live`
    const r = run(['learn', '--path', dir, '--json', '--scope', 'global', '--', st])
    expect(r.code, r.err).toBe(0)
    expect(existsSync(other)).toBe(false)
    expect(stored()).toContain('is where the fixtures live')
  })

  it('"--json" after `--` is the statement, not the output flag', { timeout: 60_000 }, () => {
    const r = run(['learn', '--path', dir, '--scope', 'global', '--', '--json'])
    expect(r.code, r.err).toBe(0)
    expect(stored()).toMatch(/statement: ['"]?--json/)
  })
})
