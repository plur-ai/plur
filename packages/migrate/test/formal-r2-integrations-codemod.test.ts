/**
 * Formal verification round 2 (R2-Integrations, mcp-integrations#8).
 *
 * 1. Two fixes on one line where one sits inside the other's `(await ...)`
 *    wrap: the outer wrap's end must account for the inner insertion.
 * 2. The --write summary counts the fixes actually applied, and a site the
 *    rewrite could not apply is reported for a human, not as "fixed".
 * 3. Report-only mode with fixable sites outstanding is not a clean exit.
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §4.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSource, applyFixes, run } from '../src/index.js'

const NESTED = 'async function g(plur, id) {\n  const x = plur.list(plur.getById(id)).length\n}\n'

describe('nested fixes on one line', () => {
  it('wraps the outer call around the inner await, both applied', () => {
    const f = scanSource('a.js', NESTED)
    const { src, applied } = applyFixes(NESTED, f)
    expect(src).toBe('async function g(plur, id) {\n  const x = (await plur.list(await plur.getById(id))).length\n}\n')
    expect(applied).toBe(2)
  })

  it('two consumed calls side by side on one line', () => {
    const src = 'async function g(plur) {\n  const n = plur.list().length + plur.list().length\n}\n'
    expect(applyFixes(src, scanSource('a.js', src)).src)
      .toBe('async function g(plur) {\n  const n = (await plur.list()).length + (await plur.list()).length\n}\n')
  })

  it('a site the rewrite cannot apply is returned as skipped, not counted', () => {
    const src = 'async function g(plur) {\n  plur.list().length\n}\n'
    const [f] = scanSource('a.js', src)
    const bogus = { ...f, wrapTo: f.column } // end <= start: cannot apply
    const r = applyFixes(src, [bogus])
    expect(r.applied).toBe(0)
    expect(r.src).toBe(src)
    expect(r.skipped).toEqual([bogus])
  })
})

describe('CLI summary and exit codes', () => {
  let dir: string
  afterEach(() => { vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  const capture = () => {
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out += String(s); return true })
    return () => out
  }

  it('report-only with fixable sites outstanding exits non-zero', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-migrate-r2-'))
    writeFileSync(join(dir, 'a.mjs'), 'async function g(plur) {\n  plur.learn("x")\n}\n')
    capture()
    expect(run([dir])).not.toBe(0)
  })

  it('--write reports the fixes actually applied and leaves a correct file', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-migrate-r2-'))
    const p = join(dir, 'a.mjs')
    writeFileSync(p, NESTED)
    const out = capture()
    expect(run([dir, '--write'])).toBe(0)
    expect(readFileSync(p, 'utf8')).toContain('(await plur.list(await plur.getById(id))).length')
    expect(out()).toMatch(/applied 2 fix\(es\) across 1 file/)
  })
})
