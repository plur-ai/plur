/**
 * Multi-line receiver chains — audit #752 item 6, fixed in #758.
 *
 * The receiver used to be matched by a regex that could not span a newline,
 * so `plur\n  .recall(q)` — an ordinary fluent chain — was neither rewritten
 * nor reported, and the report read as clean on a file that was not. Worse,
 * on a single line the same regex re-anchored MID-chain:
 * `getStore().plur.recall(q)` matched with receiver `plur`, and `--write`
 * emitted `getStore().await plur.recall(q)` — source that does not parse —
 * while `await getStore().plur.recall(q)`, already correct, was reported and
 * then mangled the same way.
 *
 * The scanner now anchors on the METHOD and resolves the receiver by walking
 * backward from the dot (see `receiverStart`). These tests pin both halves:
 * chains split across lines are found, and every finding anchors at the head
 * of the chain — the only position `await` may legally occupy.
 */
import { describe, it, expect } from 'vitest'
import { scanSource, applyFixes } from '../src/scan.js'

const scan = (src: string) => scanSource('t.ts', src)
const fix = (src: string) => applyFixes(src, scan(src)).src

describe('multi-line receiver chains are found', () => {
  it('finds the audit repro — receiver, call, and consumer on three lines — and reports it MANUAL', () => {
    // The exact site from #752 item 6. It is consumed (`.length`) across
    // lines, so it must be REPORTED but not rewritten: the single-line wrap
    // `(await ...)` cannot be placed with line/column arithmetic here.
    const src = "const n = plur\n  .recall('q')\n  .length\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].method).toBe('recall')
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/multi-line/)
    // Anchored at the chain head, where the human will add `(await`.
    expect(f[0].line).toBe(1)
    expect(f[0].column).toBe(11)
    expect(applyFixes(src, f).src).toBe(src)
  })

  it('fixes a bare chain split across lines — await goes in front of the head', () => {
    const src = "async function g(plur) {\n  plur\n    .learn('x')\n}\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toBe("async function g(plur) {\n  await plur\n    .learn('x')\n}\n")
  })

  it('a comment between receiver and call does not hide the chain', () => {
    const line = "async function g(plur) {\n  plur\n    // engrams\n    .recall('q')\n}\n"
    expect(fix(line)).toContain('await plur\n')
    const block = "async function g(plur) {\n  plur /* engrams */.recall('q')\n}\n"
    expect(fix(block)).toContain("await plur /* engrams */.recall('q')")
  })

  it('a commented-OUT chain link is skipped, not matched', () => {
    // The `.recall(` inside the comment is literal text; the real call is
    // `.learn(`. One finding, and the comment rides along untouched.
    const src = "async function g(plur) {\n  plur\n    // .recall('old')\n    .learn('x')\n}\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].method).toBe('learn')
    expect(applyFixes(src, f).src).toBe("async function g(plur) {\n  await plur\n    // .recall('old')\n    .learn('x')\n}\n")
  })

  it('finds a multi-line optional chain — plur\\n  ?.recall(q)', () => {
    const src = "async function g(plur) {\n  plur\n    ?.recall('q')\n}\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(true)
    expect(applyFixes(src, f).src).toBe("async function g(plur) {\n  await plur\n    ?.recall('q')\n}\n")
  })

  it('finds a dot-at-line-end chain — plur.\\n  recall(q)', () => {
    const src = "async function g(plur) {\n  plur.\n    recall('q')\n}\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(applyFixes(src, f).src).toContain('await plur.\n')
  })
})

describe('multi-line chains that are already handled stay silent', () => {
  it('an await in front of the chain head covers the whole chain', () => {
    expect(scan("async function g(plur) {\n  await plur\n    .recall('q')\n}\n")).toEqual([])
    expect(scan("async function g(plur) {\n  const x = await plur\n    .recall('q')\n}\n")).toEqual([])
    expect(scan("async function g() {\n  await getStore().plur\n    .recall('q')\n}\n")).toEqual([])
  })

  it('a returned or voided chain is fine', () => {
    expect(scan("async function g(plur) {\n  return plur\n    .sync()\n}\n")).toEqual([])
    expect(scan("async function g(plur) {\n  void plur\n    .sync()\n}\n")).toEqual([])
  })

  it('a .then on the next line is a handled promise', () => {
    expect(scan("async function g(plur) {\n  plur\n    .sync()\n    .then(ok)\n}\n")).toEqual([])
  })

  it('a chain inside a Promise combinator array is still refused, not rewritten', () => {
    const src = "const r = await Promise.race([\n  plur\n    .learnRouted(s, ctx),\n  timeout(5000),\n])\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/combinator/)
  })

  it('a chain inside a non-async function is refused — await there does not parse', () => {
    const f = scanSource('t.mjs', "function g(plur) {\n  plur\n    .learn('x')\n}\n")
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/not `async`/)
  })
})

describe('findings anchor at the head of the chain', () => {
  it('a call-bearing receiver anchors before the call — the mid-chain anchor emitted unparseable source', () => {
    // Before #758: finding at `plur`, --write emitted
    // `getStore().await plur.recall('q')`. The assertion is the exact output.
    const src = "async function g() { getStore().plur.recall('q') }\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(applyFixes(src, f).src).toBe("async function g() { await getStore().plur.recall('q') }\n")
  })

  it('an ALREADY-awaited call-bearing receiver is silent — it used to be reported and then mangled', () => {
    expect(scan("async function g() { await getStore().plur.recall('q') }\n")).toEqual([])
    expect(scan("async function g() { await (getPlur()).recall('q') }\n")).toEqual([])
  })

  it('finds a factory-call receiver — getPlur().recall(q)', () => {
    const src = "async function g() { getPlur().recall('q') }\n"
    expect(fix(src)).toBe("async function g() { await getPlur().recall('q') }\n")
  })

  it('finds a fluent chain with a call in the middle — plur.scoped(s).recall(q)', () => {
    const src = "async function g(plur) { plur.scoped('team').recall('q') }\n"
    expect(fix(src)).toBe("async function g(plur) { await plur.scoped('team').recall('q') }\n")
  })

  it('wraps through a call-bearing receiver when the result is consumed', () => {
    const src = "async function g() { const n = getPlur().recall('q').length }\n"
    expect(fix(src)).toBe("async function g() { const n = (await getPlur().recall('q')).length }\n")
  })

  it('a `new` receiver puts the await before the new — `new await` does not parse', () => {
    const src = "async function g() { new Plur().recall('q') }\n"
    expect(fix(src)).toBe("async function g() { await new Plur().recall('q') }\n")
  })

  it('a parenthesised head takes the await in front of the paren', () => {
    const src = "async function g(store) { (store as Plur).recall('q') }\n"
    expect(fix(src)).toBe("async function g(store) { await (store as Plur).recall('q') }\n")
  })

  it('refuses a parenthesised head that ASI-splices onto the previous line', () => {
    // `let f = function () {}` + `(store).recall(q)` currently CALLS f — a
    // plain inserted `await` would cut that continuation and change what
    // runs. Same refusal as the leading-`(await ...)` wrap, other direction.
    const src = "let f = function () {}\n(store).recall('q')\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].fixable).toBe(false)
    expect(f[0].reason).toMatch(/ASI/)
    expect(applyFixes(src, f).src).toBe(src)
  })

  it('two newly-async methods on one chain produce ONE finding — two rewrites at one offset would collide', () => {
    const src = "async function g(plur) { plur.recall('q').learn('x') }\n"
    const f = scan(src)
    expect(f).toHaveLength(1)
    expect(f[0].method).toBe('recall')
  })
})

describe('consumption is read through comments and optional chains', () => {
  it('`?.` after the call is consumption — the plain form awaits .length of the promise', () => {
    const src = "async function g(plur) { const n = plur.recall('q')?.length }\n"
    expect(fix(src)).toBe("async function g(plur) { const n = (await plur.recall('q'))?.length }\n")
  })

  it('a comment between the call and its consumer does not un-consume it', () => {
    // Seen as bare, this would get a plain `await` — which awaits `.length`
    // OF THE PROMISE. The comment must be skipped, the wrap kept.
    const src = "async function g(plur) { const n = plur.recall('q') /* hits */ .length }\n"
    expect(fix(src)).toBe("async function g(plur) { const n = (await plur.recall('q')) /* hits */ .length }\n")
  })

  it('a ?.then across a comment is still a handled promise', () => {
    expect(scan("async function g(plur) { plur.sync() /* ok */ ?.then(done) }\n")).toEqual([])
  })
})

describe('idempotence over the new shapes', () => {
  it('a second pass over fixed chains finds nothing', () => {
    const src = [
      "async function g(plur) {",
      "  plur",
      "    .learn('a')",
      "  getPlur().recall('q')",
      "  new Plur().recall('r')",
      "}",
      "",
    ].join('\n')
    const once = applyFixes(src, scan(src)).src
    const twice = applyFixes(once, scanSource('t.ts', once))
    expect(twice.applied).toBe(0)
    expect(twice.src).toBe(once)
  })
})
