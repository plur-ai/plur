#!/usr/bin/env node
/**
 * fix-throw-assertions — convert sync throw assertions to rejection assertions.
 *
 * A method that was synchronous and threw now returns a rejected promise. The
 * assertion has to change with it:
 *
 *     expect(() => plur.learn(bad)).toThrow(/x/)
 *  -> await expect(plur.learn(bad)).rejects.toThrow(/x/)
 *
 *     expect(() => plur.learn(ok)).not.toThrow()
 *  -> await expect(plur.learn(ok)).resolves.toBeDefined()
 *
 * This matters more than it looks. `expect(() => p).toThrow()` on a function
 * that returns a rejected promise does NOT fail loudly — the arrow returns
 * normally, so the assertion reports "expected [Function] to throw an error"
 * while the real rejection escapes as an unhandled rejection. The negative form
 * is worse: `.not.toThrow()` PASSES, so a test that was asserting "this input is
 * accepted" keeps passing even if the call now rejects for an unrelated reason.
 *
 * Only rewrites when the arrow body actually calls one of the named methods, so
 * genuinely synchronous throw assertions are left alone.
 *
 * Usage: node scripts/fix-throw-assertions.mjs --methods a,b,c <root...> [--dry]
 */
import * as fs from 'fs'
import * as path from 'path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const mi = args.indexOf('--methods')
if (mi < 0) { console.error('--methods is required'); process.exit(1) }
const METHODS = args[mi + 1].split(',').map(s => s.trim()).filter(Boolean)
const roots = args.filter((a, i) => !a.startsWith('--') && i !== mi + 1)

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

const NAMES = METHODS.map(m => m.replace(/\$/g, '\\$')).join('|')
const CALLS_ASYNC = new RegExp(String.raw`\.(?:${NAMES})\s*\(`)

function matchParen(s, open) {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') { d--; if (d === 0) return i }
  }
  return -1
}

let files = 0, pos = 0, neg = 0
for (const root of roots) {
  for (const f of walk(root)) {
    let src = fs.readFileSync(f, 'utf8')
    const before = src
    let guard = 0
    for (;;) {
      if (++guard > 2000) break
      const m = /expect\(\s*(?:async\s*)?\(\s*\)\s*=>\s*/.exec(src)
      if (!m) break
      const openIdx = src.lastIndexOf('(', m.index + 'expect'.length)
      const close = matchParen(src, openIdx)
      if (close < 0) break
      const body = src.slice(m.index + m[0].length, close).trim()
      const tail = src.slice(close + 1)
      const isNeg = /^\s*\.\s*not\s*\.\s*toThrow/.test(tail)
      const isPos = /^\s*\.\s*toThrow/.test(tail)
      if (!CALLS_ASYNC.test(body) || (!isNeg && !isPos)) {
        // Not ours — step past this `expect(` so the scan can continue.
        src = src.slice(0, m.index) + 'expectSKIP(' + src.slice(m.index + 'expect('.length)
        continue
      }
      const cleanBody = body.replace(/^await\s+/, '')
      if (isNeg) {
        const rest = tail.replace(/^\s*\.\s*not\s*\.\s*toThrow\s*\([^)]*\)/, '')
        src = src.slice(0, m.index) + `await expectSKIP(${cleanBody}).resolves.toBeDefined()` + rest
        neg++
      } else {
        const tm = /^\s*\.\s*toThrow\s*\(/.exec(tail)
        const targClose = matchParen(tail, tail.indexOf('(', tm[0].length - 1))
        const argTxt = tail.slice(tail.indexOf('(', tm[0].length - 1) + 1, targClose)
        const rest = tail.slice(targClose + 1)
        src = src.slice(0, m.index) + `await expectSKIP(${cleanBody}).rejects.toThrow(${argTxt})` + rest
        pos++
      }
    }
    src = src.replace(/expectSKIP\(/g, 'expect(')
    if (src !== before) { files++; if (!DRY) fs.writeFileSync(f, src) }
  }
}
console.log(`${DRY ? '[dry] ' : ''}converted ${pos} toThrow + ${neg} not.toThrow across ${files} file(s)`)
