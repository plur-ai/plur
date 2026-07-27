#!/usr/bin/env node
/**
 * await-local-helpers — await calls to helpers that became async within a file.
 *
 * The flip propagated `async` into test-local helpers (`seedAndOpen`,
 * `makeStore`, ...) because they call the now-async API. Their call sites inside
 * the same file were left returning promises, which shows up as
 * `Property 'x' does not exist on type 'Promise<...>'`.
 *
 * Per file: discover every locally-declared async function, then await its
 * un-awaited calls in that same file. Purely local, so there is no cross-file
 * inference to get wrong.
 *
 * Parenthesises when the result is immediately consumed, and skips string and
 * template literals — the same two hazards the call-site codemod hit.
 *
 * Usage: node scripts/await-local-helpers.mjs <root...> [--dry]
 */
import * as fs from 'fs'
import * as path from 'path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const roots = args.filter(a => !a.startsWith('--'))

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue
      walk(p, out)
    } else if (/\.ts$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function matchParen(s, open) {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') { d--; if (d === 0) return i + 1 }
  }
  return -1
}

function inLiteral(src, idx) {
  const ls = src.lastIndexOf('\n', idx - 1) + 1
  const pre = src.slice(ls, idx).replace(/\\./g, '')
  const odd = ch => (pre.split(ch).length - 1) % 2 === 1
  return odd("'") || odd('"') || odd('`')
}

let files = 0, sites = 0
for (const root of roots) {
  for (const f of walk(root)) {
    let src = fs.readFileSync(f, 'utf8')
    const before = src

    const helpers = new Set()
    for (const m of src.matchAll(/\basync\s+function\s+([A-Za-z_$][\w$]*)/g)) helpers.add(m[1])
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g)) helpers.add(m[1])
    if (helpers.size === 0) continue

    const alt = [...helpers].map(h => h.replace(/\$/g, '\\$')).join('|')
    let guard = 0
    for (;;) {
      if (++guard > 4000) break
      const re = new RegExp(String.raw`(^|[^.\w$])(${alt})\s*\(`, 'g')
      let m, done = true
      while ((m = re.exec(src))) {
        const callStart = m.index + m[1].length
        const pre = src.slice(Math.max(0, callStart - 200), callStart)
        if (/\b(await|yield|function|async|new)\s*$/.test(pre)) continue
        if (/=>\s*$/.test(pre)) continue
        if (inLiteral(src, callStart)) continue
        const openIdx = src.indexOf('(', callStart + m[2].length)
        const close = matchParen(src, openIdx)
        if (close < 0) continue
        const after = src.slice(close, close + 4)
        const consumed = /^\s*[.[(]/.test(after)
        const call = src.slice(callStart, close)
        src = src.slice(0, callStart) + (consumed ? `(await ${call})` : `await ${call}`) + src.slice(close)
        sites++; done = false
        break
      }
      if (done) break
    }
    if (src !== before) { files++; if (!DRY) fs.writeFileSync(f, src) }
  }
}
console.log(`${DRY ? '[dry] ' : ''}awaited ${sites} local-helper call(s) across ${files} file(s)`)
