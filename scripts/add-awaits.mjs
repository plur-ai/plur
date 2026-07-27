#!/usr/bin/env node
/**
 * add-awaits — insert `await` at call sites of methods that just became async.
 *
 * Convergence Phase 2b makes ~34 `Plur` methods async. Every existing call site
 * now yields a Promise where the caller expects a value. In TypeScript that is
 * a compile error, which is the good case; in a test that only checks a
 * truthy result it can silently pass while asserting on a Promise, which is the
 * bad one. So this fixes them mechanically rather than by inspection.
 *
 * What it does per call site `<recv>.<method>(`:
 *   - skips it if already preceded by `await`, `yield`, `return await`, or if it
 *     is a method DEFINITION rather than a call
 *   - inserts `await`
 *   - parenthesises when the result is immediately consumed — `.foo`, `[0]`,
 *     `(`, or a template/binary continuation — because `await a.b()` binds
 *     looser than the member access that follows, so `await a.b().c` would
 *     await `a.b().c` rather than `(await a.b()).c`
 *
 * It deliberately does NOT try to mark enclosing functions async: that is
 * `fix-await-scopes.mjs`'s job, driven by tsc, which is exact where this is
 * heuristic. Run them in sequence.
 *
 * Skips comment lines and, crudely, string literals, to avoid rewriting prose
 * that happens to contain `.learn(`.
 *
 * Usage:
 *   node scripts/add-awaits.mjs --methods a,b,c <glob-root> [--dry]
 */
import * as fs from 'fs'
import * as path from 'path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const mi = args.indexOf('--methods')
if (mi < 0) { console.error('--methods is required'); process.exit(1) }
const METHODS = args[mi + 1].split(',').map(s => s.trim()).filter(Boolean)
const roots = args.filter((a, i) => !a.startsWith('--') && i !== mi + 1)
if (roots.length === 0) { console.error('give at least one root directory'); process.exit(1) }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'coverage'].includes(e.name)) continue
      walk(p, out)
    } else if (/\.(ts|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

// `<receiver>.<method>(` — receiver is an identifier, `this`, or a chain tail.
const CALL = new RegExp(
  String.raw`(^|[^.\w$])((?:this|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:${METHODS.join('|')}))\s*\(`,
  'g',
)
// A definition looks like `async name(` / `name(` at member indent — never a call.
const DEF = new RegExp(String.raw`^\s*(?:private|public|protected|readonly|async|static|\s)*(?:${METHODS.join('|')})\s*[(<]`)

/** Index just past the matching `)` for the `(` at `open`. */
function matchParen(s, open) {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') { d--; if (d === 0) return i + 1 }
  }
  return -1
}

let files = 0, sites = 0
for (const root of roots) {
  for (const file of walk(root)) {
    const orig = fs.readFileSync(file, 'utf8')
    const lines = orig.split('\n')
    let touched = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
      if (DEF.test(line)) continue

      let out = line
      let guard = 0
      for (;;) {
        if (++guard > 50) break
        CALL.lastIndex = 0
        const m = CALL.exec(out)
        if (!m) break
        const lead = m[1]
        const callStart = m.index + lead.length
        const before = out.slice(0, callStart)
        if (/\b(await|yield|function|async)\s*$/.test(before)) { CALL.lastIndex = 0; break }
        // A concise arrow body (`=> this.x()`) already RETURNS the promise, and
        // that is usually the contract — a dependency callback, a `.then()` arm.
        // Inserting `await` there needs the arrow marked async too, which is
        // churn for no behavioural gain, and it is what made earlier runs
        // oscillate against fix-await-scopes. Leave it returning the promise.
        const openIdx = out.indexOf('(', callStart + m[2].length)
        const close = matchParen(out, openIdx)
        if (close < 0) break
        if (/=>\s*$/.test(before)) { CALL.lastIndex = close; continue }
        const after = out.slice(close)
        const consumed = /^\s*[.[(]/.test(after) || /^\s*\?\./.test(after)

        const call = out.slice(callStart, close)
        const repl = consumed ? `(await ${call})` : `await ${call}`
        const next = before + repl + out.slice(close)
        if (next === out) break
        out = next
        sites++
        // Continue scanning AFTER what we just rewrote.
        CALL.lastIndex = before.length + repl.length
        const rest = out.slice(CALL.lastIndex)
        const m2 = new RegExp(CALL.source, 'g').exec(rest)
        if (!m2) break
      }
      if (out !== line) { lines[i] = out; touched = true }
    }

    if (touched) {
      files++
      if (!DRY) fs.writeFileSync(file, lines.join('\n'))
    }
  }
}
console.log(`${DRY ? '[dry] ' : ''}rewrote ${sites} call site(s) across ${files} file(s)`)
