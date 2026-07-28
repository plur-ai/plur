/**
 * The third hazard class from scan.ts's header — ASI splices — pinned.
 *
 * The header named it from day one: "a line beginning `(await ...)` after a
 * line with no semicolon parses as a call on the previous expression." The
 * guard for it did not exist until the 0.16.0 pre-release audit (#752)
 * reproduced the splice: the tool rewrote
 *
 *     const x = someFunc()              const x = someFunc()
 *     plur.list().length          to    (await plur.list()).length
 *
 * which executes as `someFunc()(await plur.list()).length` — the previous
 * line's result is CALLED. Valid syntax, green suite, broken at runtime, in
 * user source. Every case here is asserted through `applyFixes` where a
 * rewrite is expected, because the finding list is not the product — the
 * emitted source is.
 */
import { describe, it, expect } from 'vitest'
import { scanSource, applyFixes } from '../src/scan.js'

const scan = (src: string) => scanSource('t.ts', src)

describe('ASI splice — a leading `(await ...)` after an unterminated line', () => {
  it('refuses the audit repro: paren-wrap after a call with no semicolon', () => {
    const src = 'const x = someFunc()\nplur.list().length\n'
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/ASI/)
    // The refusal must reach the output: nothing may be rewritten.
    expect(applyFixes(src, f).src).toBe(src)
  })

  it('refuses after a line ending in an identifier, `]`, or a string', () => {
    for (const prev of ['let a = b', 'const a = arr[0]', "const s = 'text'", 'const t = `tpl`']) {
      const f = scan(`${prev}\nplur.list().length\n`)
      expect(f, prev).toHaveLength(1)
      expect(f[0].fixable, `after \`${prev}\` the wrap must be refused`).toBe(false)
    }
  })

  it('refuses after `}` — a function expression end is indistinguishable from a block end', () => {
    // `let f = function () {}` + `(await ...)` calls f. A block-closing `}`
    // would be safe, but the scanner cannot tell them apart from one
    // character, and refusal costs a glance while the splice costs a runtime
    // failure.
    const f = scan('let f = function () {}\nplur.list().length\n')
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
  })

  it('rewrites when the previous line is terminated', () => {
    const cases: Array<[string, string]> = [
      ['someFunc();\nplur.list().length\n', 'someFunc();\n(await plur.list()).length\n'],
      ['async function f() {\nplur.list().length\n}', 'async function f() {\n(await plur.list()).length\n}'],
    ]
    for (const [src, want] of cases) {
      const f = scan(src)
      expect(f).toHaveLength(1)
      expect(f[0].fixable, src).toBe(true)
      expect(applyFixes(src, f).src).toBe(want)
    }
  })

  it('rewrites at the start of the file — there is no previous line to splice onto', () => {
    const src = 'plur.list().length\n'
    const f = scan(src)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toBe('(await plur.list()).length\n')
  })

  it('a comment between the lines is not a terminator — the code before it decides', () => {
    // Comment spans are skipped whole: after `;` + comment the wrap is safe,
    // after an unterminated call + comment it is still the splice.
    const safe = 'someFunc();\n// note\nplur.list().length\n'
    expect(scan(safe)[0].fixable).toBe(true)
    const splice = 'const x = someFunc()\n// note\nplur.list().length\n'
    expect(scan(splice)[0].fixable).toBe(false)
  })

  it('mid-line paren-wraps are untouched — parsing there is already fixed', () => {
    const src = 'const x = someFunc()\nconst n = plur.list().length\n'
    const f = scan(src)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toBe('const x = someFunc()\nconst n = (await plur.list()).length\n')
  })

  it('plain `await` insertion is immune — `f() await` cannot continue an expression', () => {
    // Before the rewrite ASI splits `someFunc()` / `plur.learn(x)`; after it,
    // `someFunc() await` is invalid so ASI splits identically. Same statement
    // boundaries, awaited call — exactly the intended change.
    const src = 'const x = someFunc()\nplur.learn("x")\n'
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toBe('const x = someFunc()\nawait plur.learn("x")\n')
  })

  it('an operator tail keeps the wrap — the expression was already continuing', () => {
    const src = 'const ok = flag &&\nplur.list().length\n'
    const f = scan(src)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toBe('const ok = flag &&\n(await plur.list()).length\n')
  })
})
