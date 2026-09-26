/**
 * Formal-verification gap closure, 2026-09-26 — decision S4 left one hole:
 * `--` ends flag parsing in plur.ts, but src/index.ts scanned the WHOLE argv
 * for `--help`/`-h`/`--version`/`-v` first, so `plur learn -- "--help"` printed
 * help and exited 0 instead of storing the statement. The help/version check
 * now stops at `--`, like every other flag.
 * spec/formal/findings/adapters.md §7.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('--help / --version after `--` are statement text (S4)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-s4-help-'))
    mkdirSync(join(dir, '.plur'), { recursive: true })
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function run(args: string[]) {
    return runCli('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, PLUR_PATH: join(dir, '.plur') },
      cwd: dir,
    })
  }

  for (const flag of ['--help', '-h', '--version', '-v']) {
    it(`learn -- "${flag}" stores "${flag}" verbatim`, { timeout: 90_000 }, () => {
      const r = run(['learn', '--json', '--', flag])
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout).statement).toBe(flag)
      expect(readFileSync(join(dir, '.plur', 'engrams.yaml'), 'utf-8')).toContain(flag)
    })
  }

  it('a bare --help before `--` still prints help (good case)', { timeout: 90_000 }, () => {
    const r = runCli('node', [CLI, '--help'], {
      encoding: 'utf-8', timeout: 60_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, PLUR_PATH: join(dir, '.plur') },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Usage|Commands/i)
  })
})
