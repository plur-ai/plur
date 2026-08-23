/**
 * A flag the command does not understand must not be silently dropped (#986).
 *
 * Every parser ended in `else { i++ }`, so an unrecognised argument vanished
 * and the command succeeded. Four testers were misled. The worst case was
 * `plur packs install <dir> --dry-run`: no such flag, so it was swallowed, and
 * a pack was installed by somebody who believed they were previewing it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { expandEqualsFlags, parseGlobalFlags } from '../src/plur.js'
import { unknownFlagMessage } from '../src/known-flags.js'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('the --flag=value form', () => {
  it('splits into a flag and its value', () => {
    expect(expandEqualsFlags(['--license=cc-by-4.0'])).toEqual(['--license', 'cc-by-4.0'])
  })

  it('splits on the FIRST equals, so a value may contain one', () => {
    expect(expandEqualsFlags(['--rationale=a=b'])).toEqual(['--rationale', 'a=b'])
  })

  it('leaves a positional argument alone', () => {
    // A statement is a value, not a flag, however many equals signs it has.
    expect(expandEqualsFlags(['x=1'])).toEqual(['x=1'])
  })

  it('stops at a bare double dash', () => {
    expect(expandEqualsFlags(['--', '--not=a-flag'])).toEqual(['--', '--not=a-flag'])
  })

  it('leaves a flag with no equals untouched', () => {
    expect(expandEqualsFlags(['--json', 'x'])).toEqual(['--json', 'x'])
  })
})

describe('the splitting is actually wired into the parser', () => {
  // Testing expandEqualsFlags on its own proves the helper works, not that
  // anything calls it. Deleting the call left every test above passing —
  // caught by deliberately breaking the code and checking these tests failed.
  it('parseGlobalFlags splits a global flag written with equals', () => {
    expect(parseGlobalFlags(['--path=/tmp/x']).flags.path).toBe('/tmp/x')
  })

  it('and splits a command flag on its way through to the command', () => {
    // Command flags are not interpreted here; they must arrive already split,
    // because each command's own parser only understands the two-token form.
    expect(parseGlobalFlags(['learn', 'x', '--license=cc-by-4.0']).args)
      .toEqual(['learn', 'x', '--license', 'cc-by-4.0'])
  })
})

describe('checking a command against the flags it declares', () => {
  const DECLARED = ['--license', '--claim-class']

  it('accepts what was declared', () => {
    expect(unknownFlagMessage(['--license', 'cc-by-4.0'], DECLARED)).toBeUndefined()
  })

  it('accepts the global flags without each command listing them', () => {
    expect(unknownFlagMessage(['--json', '--path', '/tmp/x'], DECLARED)).toBeUndefined()
  })

  it('names a flag it does not know', () => {
    expect(unknownFlagMessage(['--author', 'someone'], DECLARED)).toContain('--author')
  })

  it('suggests the flag somebody probably meant', () => {
    // The British spelling is the case worth catching: it currently fails in
    // silence and takes the licence with it.
    expect(unknownFlagMessage(['--licence', 'x'], DECLARED)).toContain('did you mean --license')
  })

  it('offers no suggestion when nothing is close', () => {
    const msg = unknownFlagMessage(['--completely-different-thing'], DECLARED)!
    expect(msg).not.toContain('did you mean')
  })

  it('treats a value as a value, not a flag', () => {
    expect(unknownFlagMessage(['--license', '-4'], DECLARED)).toBeUndefined()
  })

  it('stops interpreting after a bare double dash', () => {
    expect(unknownFlagMessage(['--', '--anything'], DECLARED)).toBeUndefined()
  })

  it('reports every offender at once, not just the first', () => {
    const msg = unknownFlagMessage(['--one', '--two'], DECLARED)!
    expect(msg).toContain('--one')
    expect(msg).toContain('--two')
  })
})

describe('end to end, through the real command line', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-flags-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', [CLI, ...args, '--path', dir], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }) }
    } catch (e: any) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
    }
  }

  it('honours the equals form all the way through', () => {
    const r = run(['learn', 'Equals form', '--domain=ops.test', '--license=cc-by-4.0', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).domain).toBe('ops.test')
  })

  it('exits non-zero on an unknown flag instead of succeeding', () => {
    const r = run(['learn', 'Anything', '--author', 'someone'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('--author')
  })

  it('refuses the flag that made a tester install a pack they meant to preview', () => {
    const r = run(['packs', 'install', '/nonexistent', '--dry-run'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('--dry-run')
  })

  it('still runs a command whose flags are all known', () => {
    expect(run(['learn', 'Fine', '--license', 'cc-by-4.0', '--json']).code).toBe(0)
  })
})
