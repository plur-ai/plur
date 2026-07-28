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
// Receiver may itself contain a call — `getEngine(p).plur.learn(...)` — and a
// method may be a bare module function with no receiver at all
// (`listImportSources()`). Both appear in real call sites; a receiver pattern
// that only allows identifier chains silently skips them.
const RECV = String.raw`(?:this|[A-Za-z_$][\w$]*(?:\([^()]*\))?(?:\.[A-Za-z_$][\w$]*(?:\([^()]*\))?)*)`
const CALL = new RegExp(
  String.raw`(^|[^.\w$])((?:${RECV}\.)?(?:${METHODS.join('|')}))\s*\(`,
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

/** Line-start offsets, so we can tell whether an index sits in a comment line. */
function lineStarts(src) {
  const out = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') out.push(i + 1)
  return out
}
function lineStartOf(src, starts, idx) {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 }
  return starts[lo]
}
function lineTextAt(src, starts, idx) {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 }
  const end = src.indexOf('\n', starts[lo])
  return src.slice(starts[lo], end < 0 ? src.length : end)
}

for (const root of roots) {
  for (const file of walk(root)) {
    let src = fs.readFileSync(file, 'utf8')
    const before0 = src
    // Whole-file scan: a call may span lines, so a line-based pass misses the
    // closing paren and silently skips exactly the multi-line sites that matter.
    let guard = 0
    for (;;) {
      if (++guard > 5000) break
      const starts = lineStarts(src)
      const re = new RegExp(CALL.source, 'g')
      let m, done = true
      while ((m = re.exec(src))) {
        const lead = m[1]
        const callStart = m.index + lead.length
        const pre = src.slice(Math.max(0, callStart - 220), callStart)
        if (/\b(await|yield|function|async)\s*$/.test(pre)) continue
        // `new Plur({...}).getById(...)` — the receiver is a constructor call.
        // Inserting after `new` yields `new await Plur(...)`, a parse error;
        // the await belongs in front of the whole expression instead.
        if (/\bnew\s*$/.test(pre)) continue
        // Ambiguous member names (load/save/list/status/sync) also exist on
        // stdlib and third-party objects. `yaml.load(...)` is synchronous and
        // awaiting it is wrong — harmless at runtime, but it corrupts the code
        // and, inside a non-async helper, breaks the parse. Never rewrite a call
        // whose receiver is a known-sync module.
        if (/\b(yaml|JSON|fs|fsp|path|os|crypto|util|process|console|Math|Object|Array)\.$/.test(
              src.slice(Math.max(0, callStart - 40), callStart + m[2].length).replace(/[\w$]+\($/, ''))) continue
        if (/\b(yaml|JSON|fs|path|os|crypto|util|process|console|Math|Object|Array)\.[\w$]*$/.test(src.slice(Math.max(0, callStart - 40), callStart + m[2].length))) continue
        if (/=>\s*$/.test(pre)) continue
        // Never rewrite inside a string or template literal. Assertion messages
        // routinely contain method names — `expect(x, `learn(shared) should
        // demote`)` — and inserting `await` there corrupts the message and, in a
        // template, can break the parse. Count unescaped quotes before the match
        // on its own line: an odd count means we are inside one.
        {
          const ls = lineStartOf(src, starts, callStart)
          const pre = src.slice(ls, callStart)
          const stripped = pre.replace(/\\./g, '')
          const odd = (ch) => (stripped.split(ch).length - 1) % 2 === 1
          if (odd("'") || odd('"') || odd('`')) continue
        }
        const lt = lineTextAt(src, starts, callStart).trim()
        if (lt.startsWith('//') || lt.startsWith('*') || lt.startsWith('/*')) continue
        if (DEF.test(lineTextAt(src, starts, callStart))) continue

        const openIdx = src.indexOf('(', callStart + m[2].length)
        if (openIdx < 0) continue
        const close = matchParen(src, openIdx)
        if (close < 0) continue
        const after = src.slice(close, close + 4)
        const consumed = /^\s*[.[(]/.test(after) || /^\s*\?\./.test(after)
        const call = src.slice(callStart, close)
        const repl = consumed ? `(await ${call})` : `await ${call}`
        src = src.slice(0, callStart) + repl + src.slice(close)
        sites++
        done = false
        break
      }
      if (done) break
    }
    if (src !== before0) { files++; if (!DRY) fs.writeFileSync(file, src) }
  }
}
console.log(`${DRY ? '[dry] ' : ''}rewrote ${sites} call site(s) across ${files} file(s)`)
