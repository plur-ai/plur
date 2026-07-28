#!/usr/bin/env node
/**
 * async-mocks — make hand-written test doubles match the now-async contracts.
 *
 * The async flip changed interfaces (`AsyncPrimaryStore`, `LearnAsyncDeps`), and
 * every fake that implements one by hand is now the wrong shape:
 *
 *     hashDedup: () => null            // must return Promise<Engram | null>
 *     load: () => [...]                // must return Promise<Engram[]>
 *
 * Marking the arrow `async` is the whole fix — an async arrow returning `null`
 * returns `Promise<null>`, which is exactly what the contract now asks for.
 *
 * Scoped deliberately to the member NAMES that actually changed, rather than
 * every arrow-valued property, so an unrelated `load:` on some other object is
 * not swept up. Over-application would surface as a type error anyway; this
 * keeps the diff honest.
 *
 * Handles both spellings a fake can use:
 *     name: (args) => expr        ->  name: async (args) => expr
 *     name(args) { ... }          ->  async name(args) { ... }
 *
 * Usage: node scripts/async-mocks.mjs --members a,b,c <root...> [--dry]
 */
import * as fs from 'fs'
import * as path from 'path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const mi = args.indexOf('--members')
if (mi < 0) { console.error('--members is required'); process.exit(1) }
const MEMBERS = args[mi + 1].split(',').map(s => s.trim()).filter(Boolean)
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

const names = MEMBERS.map(m => m.replace(/\$/g, '\\$')).join('|')
// `name: (a, b) => ...` or `name: () => ...`, not already async.
const PROP_ARROW = new RegExp(String.raw`(^|[\s{,])((?:${names}))(\s*:\s*)(?!async\b)(\([^)]*\)|[A-Za-z_$][\w$]*)(\s*=>)`, 'gm')
// `name(args) {` shorthand method in an object literal, not already async.
const SHORTHAND = new RegExp(String.raw`(^\s*)(?!async\b)((?:${names}))(\s*\([^)]*\)\s*\{)`, 'gm')

let files = 0, hits = 0
for (const root of roots) {
  for (const f of walk(root)) {
    const src = fs.readFileSync(f, 'utf8')
    let out = src.replace(PROP_ARROW, (m, lead, name, colon, params, arrow) => {
      hits++
      return `${lead}${name}${colon}async ${params}${arrow}`
    })
    out = out.replace(SHORTHAND, (m, indent, name, rest) => {
      // Only inside what looks like an object literal / class body, and never a
      // call such as `load()` on its own line.
      hits++
      return `${indent}async ${name}${rest}`
    })
    if (out !== src) { files++; if (!DRY) fs.writeFileSync(f, out) }
  }
}
console.log(`${DRY ? '[dry] ' : ''}made ${hits} member(s) async across ${files} file(s)`)
