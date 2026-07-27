#!/usr/bin/env node
/**
 * fix-await-scopes — mark enclosing functions `async`, driven by tsc itself.
 *
 * The bulk async codemod propagates `await` correctly but its enclosing-function
 * detection is heuristic, so it leaves a tail of TS1308 ("'await' expressions
 * are only allowed within async functions"). Rather than improve the heuristic
 * — which is guessing — let the compiler point at every remaining site and fix
 * exactly those. tsc is the oracle: it cannot miss one, and it cannot invent one.
 *
 * For each TS1308 at line L, walk upward to the nearest enclosing function
 * header — an arrow (`... => {`), a function expression, or a class member at
 * two-space indent — and mark it async, rewriting an explicit return annotation
 * `T` to `Promise<T>` because TypeScript will not infer over an annotation.
 *
 * Iterates to a fixpoint: marking a method async usually reveals that ITS
 * callers now await, which surfaces the next layer. Bounded so a
 * non-converging case fails loudly instead of spinning.
 *
 * Usage: node scripts/fix-await-scopes.mjs <tsc-command...>
 */
import * as fs from 'fs'
import { execSync } from 'child_process'

const cmd = process.argv.slice(2).join(' ')
if (!cmd) { console.error('usage: fix-await-scopes.mjs <tsc command>'); process.exit(1) }

// Control-flow keywords sit at the same indent as class members and look
// identical to a zero-arg method. Marking `for (...)` async is a syntax error.
const KEYWORDS = new Set(['if','for','while','switch','catch','return','do','else','try','with','constructor'])
const MEMBER = /^ {2}(?:(?:private|public|protected|readonly)\s+)*(?:(async)\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/
const ARROW = /=>\s*\{\s*$/
const FUNCEXPR = /\bfunction\s*[\w$]*\s*\([^)]*\)\s*\{\s*$/

function tscErrors() {
  try { execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }); return [] }
  catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return out.split('\n')
      .map(l => /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map(m => ({ file: m[1], line: +m[2], code: m[4], msg: m[5] }))
  }
}

/** Walk up from `idx` to the header line of the function that encloses it. */
function enclosing(lines, idx) {
  let depth = 0
  for (let i = idx; i >= 0; i--) {
    const l = lines[i]
    // Count braces right-to-left; the first unmatched `{` opens our scope.
    for (let c = l.length - 1; c >= 0; c--) {
      if (l[c] === '}') depth++
      else if (l[c] === '{') {
        if (depth > 0) { depth--; continue }
        const head = l.slice(0, c + 1)
        if (ARROW.test(head) || FUNCEXPR.test(head)) return i
        const mm = MEMBER.exec(l)
        if (mm && !KEYWORDS.has(mm[2])) return i
        // A multi-line signature closes on its own line — `) {` or `): T {` —
        // so the member header is further up. Walk to it rather than treating
        // this as a plain block.
        if (/^\s*\)\s*(?::[^{]*)?\{\s*$/.test(head)) {
          for (let j = i - 1; j >= 0 && i - j < 40; j--) {
            if (MEMBER.test(lines[j])) return j
          }
        }
        // A plain block (if/try/for) — not a function boundary, keep going.
      }
    }
  }
  return -1
}

function markAsync(lines, i) {
  const l = lines[i]
  if (/^\s*(?:private |public |protected |readonly )*async\b/.test(l)) return false
  // Already async in any of its spellings: `async (a) =>`, `async a =>`,
  // `async function`. Re-marking produces `async async`, which is a parse error.
  if (/\basync\s*\(/.test(l) || /\basync\s+function\b/.test(l)) return false
  if (/\basync\s+[\w$]+\s*=>/.test(l)) return false

  if (ARROW.test(l)) {
    // `foo(bar, () => {`  /  `foo(bar, (a, b) => {`  /  `const f = x => {`
    const out = l.replace(/(\(([^()]*)\)|\b[\w$]+)(\s*)=>\s*\{\s*$/, (m, params, _inner, ws) => `async ${params}${ws}=> {`)
    if (out === l) return false
    lines[i] = out
    return true
  }
  if (FUNCEXPR.test(l)) { lines[i] = l.replace(/\bfunction\b/, 'async function'); return true }

  const m = MEMBER.exec(l)
  if (m && !m[1] && !KEYWORDS.has(m[2])) {
    let out = l.replace(new RegExp(`\\b${m[2].replace(/\$/g, '\\$')}\\s*(?=[(<])`), `async ${m[2]}`)
    const rt = /\)\s*:\s*([^{;]+?)\s*\{\s*$/.exec(out)
    if (rt && !/^Promise\s*</.test(rt[1].trim())) {
      out = out.replace(/\)\s*:\s*([^{;]+?)\s*\{\s*$/, `): Promise<${rt[1].trim()}> {`)
    } else if (!/\)\s*[:{]/.test(out)) {
      // Multi-line signature: the return annotation is on the closing line.
      for (let j = i + 1; j < lines.length && j - i < 40; j++) {
        const cm = /^(\s*\)\s*:\s*)([^{;]+?)(\s*\{\s*)$/.exec(lines[j])
        if (cm) {
          if (!/^Promise\s*</.test(cm[2].trim())) lines[j] = `${cm[1]}Promise<${cm[2].trim()}>${cm[3]}`
          break
        }
        if (/^\s*\)\s*\{\s*$/.test(lines[j])) break
      }
    }
    lines[i] = out
    return true
  }
  return false
}

let round = 0
for (;;) {
  round++
  if (round > 30) { console.error('did not converge in 30 rounds'); process.exit(1) }
  const errs = tscErrors().filter(e => e.code === 'TS1308')
  if (errs.length === 0) { console.log(`converged after ${round - 1} round(s)`); break }

  const byFile = new Map()
  for (const e of errs) {
    if (!byFile.has(e.file)) byFile.set(e.file, new Set())
    byFile.get(e.file).add(e.line - 1)
  }

  let fixed = 0
  for (const [file, lineSet] of byFile) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    // Bottom-up so earlier edits cannot shift later line numbers.
    for (const ln of [...lineSet].sort((a, b) => b - a)) {
      const fn = enclosing(lines, ln)
      if (fn >= 0 && markAsync(lines, fn)) fixed++
    }
    fs.writeFileSync(file, lines.join('\n'))
  }
  console.log(`round ${round}: ${errs.length} TS1308 -> marked ${fixed} function(s) async`)
  if (fixed === 0) { console.error('made no progress; remaining sites need a human'); process.exit(1) }
}
