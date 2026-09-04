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

/**
 * A flag that needs a value must have one, and a mistyped global flag must
 * never reach a command (#986, round five).
 *
 * A tester found `capture "x" --pathh <dir>` exiting 0 with the episode written
 * to the user's REAL store, because the mistyped flag was passed through as a
 * positional argument and `--path` was simply never set. That is the only
 * defect in this area that writes outside the directory the operator named.
 *
 * Separately, `learn "x" --scope --type behavioral` stored the literal string
 * "--type" as the scope, and a value-taking flag at the end of the line was
 * dropped in silence. Both wrote an engram; both exited 0.
 */
describe('mistyped global flags never reach a command', () => {
  it('catches a near miss on --path, whatever the command', () => {
    const { error } = parseGlobalFlags(['status', '--pathh', '/tmp/x'])
    expect(error).toContain('--pathh')
    expect(error).toContain('did you mean --path')
  })

  it('refuses --path with no value, rather than falling back to the default store', () => {
    expect(parseGlobalFlags(['learn', 'x', '--path']).error).toContain('--path needs a directory')
  })

  it('refuses --path whose value is the next flag', () => {
    expect(parseGlobalFlags(['learn', 'x', '--path', '--json']).error).toContain('--path needs a directory')
  })

  it('leaves a correct invocation alone', () => {
    const { flags, error } = parseGlobalFlags(['status', '--path', '/tmp/x'])
    expect(error).toBeUndefined()
    expect(flags.path).toBe('/tmp/x')
  })

  it('does not complain about a flag that is nothing like a global one', () => {
    // Those belong to the command, and the command checks them.
    expect(parseGlobalFlags(['learn', 'x', '--claim-class', 'asserted']).error).toBeUndefined()
  })

  it('does not reject a legitimate command flag that merely resembles a global one', () => {
    // A wider net caught `--session`, which is two edits from `--version` and
    // a real flag on `capture`. The check exists for one harm — a mistyped
    // --path silently retargeting the store — so it looks only for that.
    expect(parseGlobalFlags(['capture', 'x', '--session', 'sess-1']).error).toBeUndefined()
    expect(parseGlobalFlags(['capture', 'x', '--agent', 'a']).error).toBeUndefined()
  })
})

describe('a flag that takes a value must have one', () => {
  const DECLARED = ['--scope', '--type', '--license']
  const TAKES = ['--scope', '--type', '--license']

  it('refuses a value that is itself a flag', () => {
    expect(unknownFlagMessage(['--scope', '--type', 'behavioral'], DECLARED, TAKES))
      .toContain('--scope needs a value')
  })

  it('refuses a value-taking flag at the end of the line', () => {
    expect(unknownFlagMessage(['--type'], DECLARED, TAKES)).toContain('--type needs a value')
  })

  it('accepts a real value', () => {
    expect(unknownFlagMessage(['--scope', 'global', '--type', 'behavioral'], DECLARED, TAKES))
      .toBeUndefined()
  })

  it('does not mistake a value for a flag it should check', () => {
    // The value of one flag must not be read as the start of another.
    expect(unknownFlagMessage(['--license', 'cc-by-4.0'], DECLARED, TAKES)).toBeUndefined()
  })
})

/**
 * A declared command flag can never be rejected by the global parser (#1002
 * review).
 *
 * The `--path` near-miss check ran at edit distance two, and two edits covers
 * real flags: `feedback --batch` and `restore --date` were both rejected as
 * "did you mean --path?" before the command ever loaded. The check now allows
 * one edit — a single typo, as its own comment always said — and this sweep
 * holds every flag literal in the package against it, so a future flag that
 * collides is caught here rather than by a user.
 */
describe('no declared command flag is mistaken for a --path typo', () => {
  it('feedback --batch is accepted', () => {
    expect(parseGlobalFlags(['feedback', '--batch', '[]']).error).toBeUndefined()
  })

  it('restore --date is accepted', () => {
    expect(parseGlobalFlags(['restore', '--date', '2026-01-01']).error).toBeUndefined()
  })

  it('every --flag literal under src/ passes the global parser', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs')
    const src = join(__dirname, '..', 'src')
    const files: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(src)
    const flags = new Set<string>()
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/'(--[a-z][a-z0-9-]*)'/g)) flags.add(m[1])
    }
    expect(flags.size).toBeGreaterThan(50)
    const rejected = [...flags].filter(flag => parseGlobalFlags(['cmd', flag, 'value']).error !== undefined)
    expect(rejected).toEqual([])
  })

  it('still catches the typo it exists for', () => {
    for (const typo of ['--pathh', '--pat', '--paths', '--pth']) {
      expect(parseGlobalFlags(['status', typo, '/tmp/x']).error, typo).toContain('did you mean --path')
    }
  })
})

describe('feedback --batch and restore --date run, end to end', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-flags-e2e-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', [CLI, ...args, '--path', dir], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }) }
    } catch (e: any) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
    }
  }

  it('feedback --batch reaches the command', () => {
    const r = run(['feedback', '--batch', '[]', '--json'])
    expect(r.out).not.toContain('did you mean --path')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).mode).toBe('batch')
  })

  it('restore --date reaches the command', () => {
    // No snapshots exist, so the command itself reports that — which proves
    // the flag got through. The global parser's message must not appear.
    const r = run(['restore', '--date', '2026-01-01'])
    expect(r.out).not.toContain('did you mean --path')
    expect(r.out).not.toContain('Unrecognised flag')
  })
})
