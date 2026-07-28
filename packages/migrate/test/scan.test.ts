/**
 * The scanner's job is to be trustworthy, not clever.
 *
 * Every hazard pinned here is one the codemods that migrated PLUR itself
 * actually hit — each produced valid TypeScript that passed a green test suite
 * while being wrong. A tool shipped to users must not repeat them.
 */
import { describe, it, expect } from 'vitest'
import { scanSource, applyFixes } from '../src/scan.js'

const scan = (src: string) => scanSource('t.ts', src)

describe('scanSource — what it finds', () => {
  it('finds a bare un-awaited call', () => {
    const f = scan('plur.learn("x")')
    expect(f).toHaveLength(1)
    expect(f[0].method).toBe('learn')
    expect(f[0].fixable).toBe(true)
  })

  it('finds a call whose result is used as if synchronous', () => {
    // The signature failure of this migration: `.length` on a Promise is
    // `undefined`, not an error.
    expect(scan('const n = plur.recall(q).length')).toHaveLength(1)
  })

  it('finds calls on a member-expression receiver', () => {
    expect(scan('this.memory.plur.feedback(id, "positive")')).toHaveLength(1)
  })

  it('reports each occurrence separately', () => {
    expect(scan('plur.learn("a")\nplur.forget("b")\n')).toHaveLength(2)
  })
})

describe('scanSource — what it must NOT flag', () => {
  it('ignores already-awaited calls', () => {
    expect(scan('await plur.learn("x")')).toEqual([])
  })

  it('ignores a returned promise', () => {
    expect(scan('return plur.learn("x")')).toEqual([])
  })

  it('ignores explicit fire-and-forget', () => {
    expect(scan('void plur.sync()')).toEqual([])
  })

  it('ignores a call whose promise is handled with .then / .catch', () => {
    expect(scan('plur.learn("x").then(ok)')).toEqual([])
    expect(scan('plur.sync().catch(noop)')).toEqual([])
  })

  it('ignores text inside string literals', () => {
    // An early codemod rewrote a CLI help string into `hook-await inject`, and a
    // user-facing message into "Add a remote with await plur.sync(...)". Both
    // compiled; both shipped.
    expect(scan('const help = "run plur.learn(x) to store"')).toEqual([])
    expect(scan("const s = 'plur.sync() syncs your engrams'")).toEqual([])
    expect(scan('const t = `use plur.recall(q) here`')).toEqual([])
  })

  it('ignores comments', () => {
    expect(scan('// plur.learn("x") is how you store\n')).toEqual([])
    expect(scan('/* plur.recall(q) returns hits */\n')).toEqual([])
  })

  it('ignores methods that were always async', () => {
    // recallHybrid was async before 0.16, so an un-awaited call to it is a
    // pre-existing bug, not this migration's business.
    expect(scan('plur.recallHybrid(q)')).toEqual([])
  })

  it('ignores methods that are still synchronous', () => {
    // Episode operations are backed by episodes.yaml, not the engram store.
    expect(scan('plur.capture("x")')).toEqual([])
    expect(scan('plur.timeline({})')).toEqual([])
  })
})

describe('scanSource — sites it refuses to rewrite', () => {
  it('flags but will not fix a call inside a Promise combinator array', () => {
    // Awaiting here resolves the call BEFORE the array is built, so the
    // combinator races an already-settled promise. This silently disabled a 5s
    // timeout guard in PLUR's own CLI, and the tests stayed green.
    const f = scan('const r = await Promise.race([\n  plur.learnRouted(s, ctx),\n  timeout(5000),\n])')
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/combinator/)
  })

  it('flags but will not fix a concise arrow body', () => {
    const f = scan('const go = () => plur.learn("x")')
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/arrow/)
  })
})

describe('applyFixes', () => {
  it('inserts await at the call site', () => {
    const src = 'plur.learn("x")\n'
    const { src: out, applied } = applyFixes(src, scan(src))
    expect(applied).toBe(1)
    expect(out).toBe('await plur.learn("x")\n')
  })

  it('parenthesises when the result is consumed directly', () => {
    // `await plur.list().length` parses as `await (plur.list().length)` — it
    // awaits undefined and yields undefined. Verified against the runtime:
    // `await Promise.resolve([1,2,3]).length` is `undefined`.
    const src = 'const n = plur.list().length\n'
    const { src: out } = applyFixes(src, scan(src))
    expect(out).toBe('const n = (await plur.list()).length\n')
  })

  it('fixes several sites on different lines without corrupting offsets', () => {
    const src = 'plur.learn("a")\nconst n = plur.list().length\nplur.forget("b")\n'
    const { src: out, applied } = applyFixes(src, scan(src))
    expect(applied).toBe(3)
    expect(out).toBe('await plur.learn("a")\nconst n = (await plur.list()).length\nawait plur.forget("b")\n')
  })

  it('fixes several sites on the SAME line', () => {
    // Right-to-left application; a left-to-right pass would shift the second
    // column by the length of the first insertion and land mid-token.
    const src = 'foo(plur.learn("a"), plur.forget("b"))\n'
    const { src: out } = applyFixes(src, scan(src))
    expect(out).toBe('foo(await plur.learn("a"), await plur.forget("b"))\n')
  })

  it('leaves non-fixable sites completely untouched', () => {
    const src = 'const r = Promise.race([plur.learnRouted(s), t()])\n'
    const { src: out, applied } = applyFixes(src, scan(src))
    expect(applied).toBe(0)
    expect(out).toBe(src)
  })

  it('is idempotent — a second run finds nothing to do', () => {
    const src = 'plur.learn("x")\n'
    const once = applyFixes(src, scan(src)).src
    const twice = applyFixes(once, scan(once))
    expect(twice.applied).toBe(0)
    expect(twice.src).toBe(once)
  })
})

describe('never emits source that cannot parse', () => {
  // The tool rewrites a user's files. Emitting a syntax error is the one
  // outcome that is strictly worse than doing nothing, and it shipped: given a
  // call inside a non-async function it inserted `await` anyway and `node
  // --check` rejected the result.
  const scanJs = (src: string) => scanSource('t.mjs', src)

  it('refuses a call inside a non-async function declaration', () => {
    const f = scanJs('function saveIt(plur) {\n  plur.learn("x")\n}\n')
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/not `async`/)
  })

  it('refuses a call inside a non-async function expression', () => {
    const f = scanJs('const go = function (plur) { plur.forget("x") }\n')
    expect(f[0].fixable).toBe(false)
  })

  it('refuses a call inside a non-async method shorthand', () => {
    const f = scanJs('const o = {\n  save(plur) {\n    plur.learn("x")\n  }\n}\n')
    expect(f[0].fixable).toBe(false)
  })

  it('DOES fix a call inside an async function', () => {
    const src = 'async function ok(plur) {\n  plur.learn("x")\n}\n'
    const f = scanJs(src)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toContain('await plur.learn("x")')
  })

  it('DOES fix a call inside an async arrow', () => {
    const src = 'const go = async (plur) => {\n  plur.learn("x")\n}\n'
    expect(scanJs(src)[0].fixable).toBe(true)
  })

  it('allows top-level await in an ES module but not in CommonJS', () => {
    expect(scanSource('t.mjs', 'plur.learn("x")\n')[0].fixable).toBe(true)
    expect(scanSource('t.cjs', 'plur.learn("x")\n')[0].fixable).toBe(false)
  })

  it('nested blocks inside an async function are still fixable', () => {
    // The enclosing-function walk must look THROUGH if/for/try blocks rather
    // than stopping at the first `{` it meets.
    const src = 'async function ok(plur) {\n  if (true) {\n    for (const x of []) {\n      plur.learn("x")\n    }\n  }\n}\n'
    expect(scanJs(src)[0].fixable).toBe(true)
  })

  it('nested blocks inside a NON-async function are still refused', () => {
    const src = 'function bad(plur) {\n  if (true) {\n    plur.learn("x")\n  }\n}\n'
    expect(scanJs(src)[0].fixable).toBe(false)
  })
})
