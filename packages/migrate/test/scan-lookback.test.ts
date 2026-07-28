/**
 * Two guards that worked on short input and failed on realistic input.
 *
 * Both bugs share a shape: a heuristic that reads a fixed window of text, or
 * reads text without knowing what is code and what is a string literal. Both
 * produced output that PARSES — `node --check` says yes — and is silently
 * wrong at runtime. That is the worst possible failure for a codemod, because
 * the user's test suite stays green and the damage surfaces in production.
 *
 * The original combinator bug is not hypothetical: it is the same mistake that
 * silently disabled PLUR's own 5-second CLI timeout.
 */
import { describe, it, expect } from 'vitest'
import { scanSource, applyFixes } from '../src/scan.js'

const scan = (src: string) => scanSource('t.mjs', src)
const fix = (src: string) => applyFixes(src, scan(src)).src

describe('Promise combinator arrays are found at any distance', () => {
  // The guard used to look back 80 characters. Anything that pushed the
  // `Promise.all([` opening past that window was rewritten.
  const padded = `async function go(plur, statement, ctx) {
  const r = await Promise.all([
    someOtherCallWithAVeryLongNameIndeed(statement, ctx, 'padding to push past the lookback window'),
    anotherRatherLongHelperFunctionName(statement, ctx, 'more padding here to be sure of it'),
    plur.learn(statement),
  ])
  return r
}`

  it('refuses a site far from the combinator opening', () => {
    const f = scan(padded)
    expect(f).toHaveLength(1)
    expect(f[0].fixable, 'rewriting here settles the call before the combinator sees it').toBe(false)
    expect(f[0].reason).toMatch(/combinator/)
  })

  it('and leaves the source untouched', () => {
    expect(fix(padded)).toBe(padded)
  })

  it('still refuses the short case the 80-char window did catch', () => {
    const short = `async function go(plur) {\n  await Promise.race([\n    plur.learn('x'),\n    timeout(5000),\n  ])\n}`
    expect(scan(short)[0].fixable).toBe(false)
  })

  it('covers all four combinators', () => {
    for (const c of ['all', 'race', 'allSettled', 'any']) {
      const src = `async function go(plur) {\n  await Promise.${c}([\n    aFunctionWithAnExtremelyLongNameToPushPastAnyFixedLookbackWindow(1, 2, 3),\n    plur.learn('x'),\n  ])\n}`
      expect(scan(src)[0].fixable, `Promise.${c} was not detected`).toBe(false)
    }
  })

  it('does NOT refuse an ordinary array literal — the guard has to discriminate', () => {
    // Without this, "refuse anything inside brackets" would pass every test
    // above while making the tool useless.
    const src = `async function go(plur) {\n  const xs = [\n    aFunctionWithAnExtremelyLongNameToPushPastAnyFixedLookbackWindow(1, 2, 3),\n    plur.learn('x'),\n  ]\n  return xs\n}`
    expect(scan(src)[0].fixable).toBe(true)
  })

  it('does NOT refuse a call that merely FOLLOWS a combinator', () => {
    // The combinator array is closed by then — being after one is not being in one.
    const src = `async function go(plur) {\n  await Promise.all([aVeryLongFunctionNameIndeedToPushPastTheWindow(1), anotherLongOne(2)])\n  plur.learn('x')\n}`
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
  })
})

describe('parens inside strings and comments do not break the wrap', () => {
  // `(await f()).length` vs `await f().length`: the second awaits `.length` of
  // the PROMISE, which is undefined. Both parse. The paren matcher counted
  // parens inside string literals, so a stray one made it give up and fall
  // through to the un-wrapped form.
  const cases: Array<[string, string]> = [
    ['open paren in a string', `plur.recall('an unbalanced ( paren').length`],
    ['close paren in a string', `plur.recall('a stray ) paren').length`],
    ['paren in a block comment', `plur.recall(/* a stray ( here */ 'q').length`],
    ['paren in a template literal', 'plur.recall(`an unbalanced ( paren`).length'],
  ]

  for (const [name, expr] of cases) {
    it(`wraps the call when there is an ${name}`, () => {
      const src = `async function go(plur) {\n  const n = ${expr}\n  return n\n}`
      const out = fix(src)

      // Asserting only "does not emit the bad form" is not enough: refusing to
      // touch the file also satisfies that, and a span-blind paren matcher
      // fails by refusing. These are ordinary, valid single-line calls, so the
      // tool has to actually rewrite them.
      expect(out, 'left untouched — the tool gave up on valid code').not.toBe(src)
      expect(out).toContain('(await plur.recall(')

      // And the rewrite has to be the wrapped form. Checked positionally, not
      // by regex: `/await plur\.recall\([\s\S]*?\)\s*\.length/` backtracks
      // across the closing paren and matches the CORRECT output too, so it
      // cannot tell the two apart.
      for (let i = out.indexOf('await plur.recall'); i !== -1; i = out.indexOf('await plur.recall', i + 1)) {
        expect(
          out[i - 1],
          `await at offset ${i} is not wrapped — this awaits .length of the promise:\n${out}`,
        ).toBe('(')
      }
    })
  }

  it('a paren in a line comment forces multi-line, which is reported not rewritten', () => {
    // Not a span bug — a line comment cannot be single-line with the call, and
    // multi-line consumed calls are deliberately left for a human.
    const src = `async function go(plur) {\n  const n = plur.recall(\n    // a stray ( here\n    'q',\n  ).length\n  return n\n}`
    const f = scan(src)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/multi-line/)
    expect(fix(src)).toBe(src)
  })

  it('the control case is genuinely rewritten — the suite is not passing by refusing everything', () => {
    const src = `async function go(plur) {\n  const n = plur.recall('balanced').length\n  return n\n}`
    expect(fix(src)).toContain(`(await plur.recall('balanced')).length`)
  })

  it('a call whose end cannot be located is reported, not guessed at', () => {
    const src = `async function go(plur) {\n  const n = plur.recall('never closed'\n`
    const f = scan(src)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/could not determine where the call ends/)
  })
})

/**
 * Places the scanner used to look straight past.
 *
 * Each is an ordinary way to write the call, and each was invisible — the tool
 * reported "no un-awaited PLUR calls found" and exited 0 on a file that had
 * them. A migration tool that misses calls is worse than no tool, because the
 * clean exit is taken as evidence the file is done.
 */
describe('call forms the scanner must not miss', () => {
  it('finds a call inside a template-literal interpolation', () => {
    // The worst one. `${promise}` does not throw — it interpolates as
    // "[object Promise]" and ships. The whole template used to be treated as a
    // string literal, so the hole was never examined.
    const f = scan('async function g(plur) {\n  return `result: ${plur.recall("q")}`\n}')
    expect(f).toHaveLength(1)
    expect(f[0].method).toBe('recall')
  })

  it('still ignores a method name that is only MENTIONED in template text', () => {
    // The literal chunks must stay literal — otherwise the fix would trade a
    // false negative for a false positive.
    expect(scan('const s = `call plur.learn(x) to remember`')).toHaveLength(0)
  })

  it('handles a template with several holes, and text between them', () => {
    const f = scan('async function g(plur) {\n  return `${plur.recall("a")} and ${plur.getById("b")}`\n}')
    expect(f.map(x => x.method).sort()).toEqual(['getById', 'recall'])
  })

  it('finds an optional-chained receiver — plur?.learn(x)', () => {
    const f = scan('async function g(plur) {\n  plur?.learn("x")\n}')
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
  })

  it('finds an optional call — plur.learn?.(x)', () => {
    const f = scan('async function g(plur) {\n  plur.learn?.("x")\n}')
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
  })

  it('rewrites both optional forms into parseable code', () => {
    const src = 'async function g(plur) {\n  plur?.learn("a")\n  plur.learn?.("b")\n}'
    const out = fix(src)
    expect(out).toContain('await plur?.learn("a")')
    expect(out).toContain('await plur.learn?.("b")')
  })
})

describe('the multi-line-consumed guard', () => {
  // Removing this guard makes --write emit `await plur.recall(\n ... \n).length`,
  // which awaits `.length` of the promise. The guard shipped untested.
  const src = 'async function g(plur) {\n  const n = plur.recall(\n    "q",\n  ).length\n  return n\n}'

  it('refuses a consumed call that spans lines', () => {
    const f = scan(src)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/multi-line/)
  })

  it('and leaves the source alone', () => {
    expect(fix(src)).toBe(src)
  })

  it('but a multi-line call whose result is NOT consumed is still fixed', () => {
    // The guard is about the member access, not about spanning lines. Without
    // this, "refuse anything multi-line" would pass the two tests above.
    const ok = 'async function g(plur) {\n  plur.learn(\n    "a long statement",\n  )\n}'
    expect(fix(ok)).toContain('await plur.learn(')
  })
})

describe('the combinator lookback reads code, not comments or strings', () => {
  // The lookback slice used to be raw text. A COMMENT whose literal content
  // was `Promise.all(` sitting immediately before an unrelated array made two
  // perfectly ordinary calls "manual" — a fail-safe false positive, but exit
  // code 2 in CI sends a human to investigate nothing. Found by the 0.16.0
  // audit (#752).
  it('a comment mentioning Promise.all( does not poison the array after it', () => {
    const src = `async function go(plur) {
  process(
    // Promise.all(
    [plur.learn('a'), plur.learn('b')],
    'other',
  )
}`
    const f = scan(src)
    expect(f).toHaveLength(2)
    expect(f.every(x => x.fixable)).toBe(true)
  })

  it('a string argument mentioning Promise.all( does not either', () => {
    const src = `async function go(plur, f) {
  f("Promise.all(", [plur.learn('a')])
}`
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
  })

  it('a REAL combinator is still refused when a comment sits between it and the array', () => {
    const src = `async function go(plur) {
  await Promise.all( // settle both
    [plur.learn('a'), plur.learn('b')],
  )
}`
    const f = scan(src)
    expect(f).toHaveLength(2)
    expect(f.every(x => x.fixable === false)).toBe(true)
    expect(f[0].reason).toMatch(/combinator/)
  })
})
