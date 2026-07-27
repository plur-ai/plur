#!/usr/bin/env node
/**
 * async-codemod — propagate `async` through a TypeScript class, transitively.
 *
 * Convergence Phase 2b flips core's primary store from sync to async. `async` is
 * contagious: a method that awaits must itself be async, and so must its
 * callers, and so on. Doing that by hand across ~50 methods is where a previous
 * attempt at this stalled, and hand-editing is also where subtle mistakes hide
 * (a missed `await` compiles fine and returns a Promise the caller treats as a
 * value).
 *
 * So: compute the fixpoint mechanically.
 *
 *   seed  = calls whose value became a Promise (the store's load/loadCached/save)
 *   step  = for every un-awaited call to something in the async set:
 *             - insert `await`, parenthesising when the result is immediately
 *               used (`.foo`, `[0]`, `(`), because `await x.y()` binds looser
 *               than the member access that follows
 *             - mark the enclosing FUNCTION async — which may be the method, or
 *               an arrow/function expression nested inside it
 *             - add the enclosing method to the async set
 *   until  = no further change
 *
 * Return-type annotations are rewritten `T` -> `Promise<T>` when a method is
 * marked async, since TypeScript will not infer over an explicit annotation.
 *
 * This is deliberately a text transform rather than an AST one: the file is a
 * single 5k-line class with a consistent 2-space member indent, the shapes
 * involved are narrow, and `tsc` is the oracle that proves the result. Every
 * run is followed by a typecheck; anything the codemod gets wrong shows up as
 * an error rather than as silent breakage.
 *
 * Usage:
 *   node scripts/async-codemod.mjs <file> [--seed name,name] [--dry]
 */
import * as fs from 'fs'

const [, , file, ...rest] = process.argv
if (!file) { console.error('usage: async-codemod.mjs <file> [--seed a,b] [--dry]'); process.exit(1) }
const DRY = rest.includes('--dry')
const seedArg = rest.includes('--seed') ? rest[rest.indexOf('--seed') + 1] : ''

let src = fs.readFileSync(file, 'utf8')

/** Class members are declared at exactly two spaces of indent in this codebase. */
const MEMBER = /^ {2}(?:(private|public|protected|readonly)\s+)*(?:(async)\s+)?(?:(get|set)\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/

function methodSpans(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = MEMBER.exec(lines[i])
    if (!m) continue
    const name = m[4]
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor'].includes(name)) continue
    out.push({ name, isAsync: !!m[2], line: i })
  }
  for (let k = 0; k < out.length; k++) out[k].end = k + 1 < out.length ? out[k + 1].line : lines.length
  return out
}

/** Index of the line that opens the function enclosing `line` — arrow, function expr, or method. */
function enclosingFunctionLine(lines, line, spans) {
  // Walk upward for a nested arrow / function expression that is still open.
  let depth = 0
  for (let i = line; i >= 0; i--) {
    const l = lines[i]
    for (let c = l.length - 1; c >= 0; c--) {
      if (l[c] === '}') depth++
      else if (l[c] === '{') {
        if (depth === 0) {
          const head = l.slice(0, c + 1)
          if (/=>\s*\{$/.test(head) || /\bfunction\s*[\w$]*\s*\([^)]*\)\s*\{$/.test(head)) return i
          const sp = spans.find(s => s.line === i)
          if (sp) return i
          // Some other block (if/try/for) — keep walking.
        } else depth--
      }
    }
  }
  return -1
}

function markAsync(lines, idx, spans) {
  const l = lines[idx]
  if (/\basync\b/.test(l)) return false
  if (/=>\s*\{$/.test(l)) {
    // (a, b) => {   /  async (a, b) => {
    lines[idx] = l.replace(/(\(?[^(]*\)?)(\s*)=>\s*\{$/, (mm, params, ws) =>
      /^\s*async\s/.test(params) ? mm : `${params.replace(/^(\s*)/, '$1')}${ws}=> {`.replace(/^(\s*)/, '$1'))
    // simpler: insert `async ` before the parameter list
    lines[idx] = l.replace(/^(\s*)(\(?)/, (mm, ws, paren) => `${ws}async ${paren}`)
    return true
  }
  if (/\bfunction\b/.test(l)) { lines[idx] = l.replace(/\bfunction\b/, 'async function'); return true }
  const sp = spans.find(s => s.line === idx)
  if (sp) {
    lines[idx] = l.replace(new RegExp(`(^ {2}(?:(?:private|public|protected|readonly)\\s+)*)(${sp.name}\\s*[(<])`), '$1async $2')
    // Explicit return annotation -> Promise<...>
    const rt = /\)\s*:\s*([^{;]+?)\s*\{\s*$/.exec(lines[idx])
    if (rt && !/^Promise</.test(rt[1].trim())) {
      lines[idx] = lines[idx].replace(/\)\s*:\s*([^{;]+?)\s*\{\s*$/, `): Promise<${rt[1].trim()}> {`)
    }
    return true
  }
  return false
}

const asyncSet = new Set(seedArg ? seedArg.split(',').filter(Boolean) : [])
const STORE_CALL = /(?<!await\s)this\._primaryStore\.(load|loadCached|save)\s*\(/g

let round = 0
let changedAny = true
while (changedAny && round < 40) {
  round++
  changedAny = false
  let lines = src.split('\n')
  const spans = methodSpans(src)
  for (const s of spans) if (s.isAsync) asyncSet.add(s.name)

  const targets = []
  for (const n of asyncSet) targets.push(n)
  const callRe = targets.length
    ? new RegExp(`(?<!await\\s)(?<!\\.)\\bthis\\.(${targets.map(t => t.replace(/\$/g, '\\$')).join('|')})\\s*\\(`, 'g')
    : null

  for (let i = 0; i < lines.length; i++) {
    const scan = [STORE_CALL, callRe].filter(Boolean)
    for (const re of scan) {
      re.lastIndex = 0
      if (!re.test(lines[i])) continue
      re.lastIndex = 0
      const before = lines[i]
      lines[i] = before.replace(re, (mm) => `await ${mm}`)
      if (lines[i] !== before) {
        changedAny = true
        const fnLine = enclosingFunctionLine(lines, i, methodSpans(lines.join('\n')))
        if (fnLine >= 0) {
          const sp2 = methodSpans(lines.join('\n')).find(s => s.line === fnLine)
          if (markAsync(lines, fnLine, methodSpans(lines.join('\n'))) && sp2) asyncSet.add(sp2.name)
        }
      }
    }
  }
  src = lines.join('\n')
}

// `await this.x().y` needs parens: `(await this.x()).y`
src = src.replace(/await (this\.[\w$]+\([^()]*\))\s*\./g, '(await $1).')
src = src.replace(/await (this\._primaryStore\.\w+\([^()]*\))\s*\./g, '(await $1).')

if (DRY) { console.log(`[dry] rounds=${round} asyncSet=${asyncSet.size}`); process.exit(0) }
fs.writeFileSync(file, src)
console.log(`rounds=${round}  async methods now: ${asyncSet.size}`)
console.log([...asyncSet].sort().join(', '))
