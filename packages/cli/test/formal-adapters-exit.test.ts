/**
 * Formal-verification run (Adapters cluster, candidate 5, cli#5): a CLI command
 * exits 0 iff the mutation it was asked to perform succeeded — and the exit
 * code is the same whether the output is JSON (piped/--json) or text (TTY).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('CLI exit codes agree with the outcome, in both output modes (formal Adapters #5)', () => {
  let dir: string
  let fakeTty: string

  const run = (args: string[], mode: 'json' | 'text') => {
    const pre = mode === 'text' ? ['--import', fakeTty] : []
    const r = spawnSync('node', [...pre, CLI, ...args, ...(mode === 'json' ? ['--json'] : [])], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PLUR_PATH: dir, HOME: dir, USERPROFILE: dir },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-exit-'))
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    fakeTty = join(dir, 'fake-tty.mjs')
    writeFileSync(fakeTty, "Object.defineProperty(process.stdout, 'isTTY', { value: true })\n")
    for (const s of ['alpha deploy rule one', 'alpha deploy rule two', 'beta unique fact']) {
      expect(run(['learn', s, '--scope', 'global'], 'json').code).toBe(0)
    }
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const mode of ['json', 'text'] as const) {
    it(`[${mode}] feedback --batch exits 1 when an item failed`, { timeout: 60_000 }, () => {
      expect(run(['feedback', '--batch', '[{"id":"ENG-NOPE-1","signal":"positive"}]'], mode).code).toBe(1)
    })
    it(`[${mode}] forget with no match exits 1`, { timeout: 60_000 }, () => {
      expect(run(['forget', 'zzqx nonexistent'], mode).code).toBe(1)
    })
    it(`[${mode}] forget with several matches retires nothing and exits 1`, { timeout: 60_000 }, () => {
      expect(run(['forget', 'alpha deploy rule'], mode).code).toBe(1)
    })
    // Decision S1: a refused `scopes register` exits 1 in both modes.
    it(`[${mode}] scopes register refused exits 1`, { timeout: 60_000 }, () => {
      expect(run(['scopes', 'register', 'not-a-shared-scope'], mode).code).toBe(1)
    })
  }

  it('good case: an empty batch and a successful single forget exit 0', { timeout: 60_000 }, () => {
    expect(run(['feedback', '--batch', '[]'], 'json').code).toBe(0)
    const r = run(['forget', 'beta unique fact'], 'json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).success).toBe(true)
  })
})
