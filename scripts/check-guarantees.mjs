#!/usr/bin/env node
// Every hard rule the code states, and every promise, has a recorded backing.
//
// A "hard rule" is a comment in packages/*/src containing one of the words in
// HARD (never, always, at most once, ...). Rules are anchored by file and the
// declaration they belong to (`packages/core/src/sync.ts#restoreWithheld`), so
// rewording a comment does not disturb the inventory; adding a rule to a new
// declaration, or removing one, does.
//
// The inventory is spec/guarantees/*.yaml:
//
//   promises:                      # every promise in evals/promises.yaml
//     SYN-5: {lean: ["PlurSpec/R2Persist.lean:restore_keeps_both"]}
//   anchors:
//     "packages/core/src/sync.ts#restoreWithheld":
//       kind: guarantee            # or `note` (states no rule of its own; `why`)
//       rule: a held local record is never lost on pull
//       lean: ["PlurSpec/R2Persist.lean:restore_keeps_both"]   # file under spec/formal : theorem
//       tests: ["packages/core/test/sync.test.ts::keeps the held record"]   # file, or file::test name
//       promises: [SYN-5]
//       none: <why nothing backs it>  # only when lean, tests and promises are all empty
//
// Usage: node scripts/check-guarantees.mjs [--root DIR] [--json] [--write-skeleton]
//   --write-skeleton  add every missing anchor as `kind: unclassified` and every
//                     missing promise with `lean: []`, then check.
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', 'packages', 'core', 'package.json'))
const ts = require('typescript')
const yaml = require('js-yaml')

export const HARD = /\b(never|always|at most once|exactly once|must not|cannot be|guarantee[sd]?|is refused|refuses?|fails? closed|atomic(ally)?|idempotent|no two|only ever)\b/i

const args = process.argv.slice(2)
const opt = name => args.includes(name)
const root = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : path.join(here, '..'))
const INV_DIR = path.join(root, 'spec', 'guarantees')

/** file#symbol -> first line of a hard-rule comment, for every source file git tracks. */
function scan() {
  const files = execFileSync('git', ['ls-files', 'packages/*/src/*.ts', 'packages/*/src/**/*.ts'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(f => f && !f.endsWith('.d.ts'))
  const anchors = new Map()
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8')
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true)
    const seen = new Set()
    const visit = (n, owner) => {
      let name = owner
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)
        || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.name) {
        name = (owner && !ts.isClassDeclaration(n) ? owner.split('.')[0] + '.' : '') + n.name.getText(sf)
      } else if (ts.isVariableStatement(n)) name = n.declarationList.declarations[0].name.getText(sf)
      // The file node shares its leading comments with its first statement; let the statement own them.
      for (const r of ts.isSourceFile(n) ? [] : ts.getLeadingCommentRanges(text, n.getFullStart()) || []) {
        if (seen.has(r.pos)) continue
        seen.add(r.pos)
        if (!HARD.test(text.slice(r.pos, r.end))) continue
        const id = `${f}#${name || '(module)'}`
        if (!anchors.has(id)) anchors.set(id, sf.getLineAndCharacterOfPosition(r.pos).line + 1)
      }
      ts.forEachChild(n, ch => visit(ch, name))
    }
    visit(sf, '')
  }
  return anchors
}

function promiseIds() {
  const doc = yaml.load(fs.readFileSync(path.join(root, 'evals', 'promises.yaml'), 'utf8'))
  return (doc.capabilities || []).flatMap(c => (c.promises || []).map(p => p.id))
}

/** Shard a source path into an inventory file: packages/<pkg>/src/<dir>/... -> <pkg>-<dir>.yaml */
function shardOf(id) {
  const parts = id.split('#')[0].split('/')
  return parts.length > 4 ? `${parts[1]}-${parts[3]}.yaml` : `${parts[1]}.yaml`
}

function loadInventory(problems) {
  const shards = new Map()
  const anchors = new Map()
  const promises = new Map()
  if (!fs.existsSync(INV_DIR)) return { shards, anchors, promises }
  for (const name of fs.readdirSync(INV_DIR).filter(n => n.endsWith('.yaml')).sort()) {
    const doc = yaml.load(fs.readFileSync(path.join(INV_DIR, name), 'utf8')) || {}
    shards.set(name, doc)
    for (const [id, e] of Object.entries(doc.anchors || {})) {
      if (anchors.has(id)) problems.push(`${id}: listed in both ${anchors.get(id).file} and ${name}`)
      else anchors.set(id, { ...e, file: name })
    }
    for (const [id, e] of Object.entries(doc.promises || {})) {
      if (promises.has(id)) problems.push(`promise ${id}: listed in two inventory files`)
      else promises.set(id, { ...(e || {}), file: name })
    }
  }
  return { shards, anchors, promises }
}

function writeSkeleton(scanned, inv, ids) {
  const touched = new Set()
  for (const id of scanned.keys()) {
    if (inv.anchors.has(id)) continue
    const name = shardOf(id)
    const doc = inv.shards.get(name) || {}
    doc.anchors = { ...(doc.anchors || {}), [id]: { kind: 'unclassified' } }
    inv.shards.set(name, doc)
    touched.add(name)
  }
  const missing = ids.filter(p => !inv.promises.has(p))
  if (missing.length) {
    const doc = inv.shards.get('promises.yaml') || {}
    doc.promises = { ...(doc.promises || {}) }
    for (const p of missing) doc.promises[p] = { lean: [] }
    inv.shards.set('promises.yaml', doc)
    touched.add('promises.yaml')
  }
  fs.mkdirSync(INV_DIR, { recursive: true })
  for (const name of touched) {
    const doc = inv.shards.get(name)
    const sorted = {}
    if (doc.promises) sorted.promises = doc.promises
    if (doc.anchors) sorted.anchors = Object.fromEntries(Object.entries(doc.anchors).sort(([a], [b]) => a.localeCompare(b)))
    fs.writeFileSync(path.join(INV_DIR, name), yaml.dump(sorted, { lineWidth: 120, quotingType: '"' }))
  }
}

function leanProblem(ref) {
  const i = ref.lastIndexOf(':')
  if (i < 0) return `lean reference "${ref}" is not <file>:<theorem>`
  const file = path.join(root, 'spec', 'formal', ref.slice(0, i))
  const thm = ref.slice(i + 1)
  if (!fs.existsSync(file)) return `${ref.slice(0, i)} does not exist under spec/formal`
  const text = fs.readFileSync(file, 'utf8')
  const escaped = thm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\b(theorem|lemma)\\s+${escaped}\\b`).test(text)) return `theorem ${thm} not found in ${ref.slice(0, i)}`
  return null
}

/** `file` or `file::test name`; the name must appear in the file as written. */
function testProblem(ref) {
  const [file, name] = ref.split('::')
  if (!fs.existsSync(path.join(root, file))) return `test ${file} does not exist`
  // Titles are compared as the test runner shows them: escaped quotes read as plain quotes.
  const titles = fs.readFileSync(path.join(root, file), 'utf8').replace(/\\(['"`])/g, '$1')
  if (name && !titles.includes(name)) return `test "${name}" not found in ${file}`
  return null
}

function main() {
  const problems = []
  const scanned = scan()
  const ids = promiseIds()
  let inv = loadInventory(problems)
  if (opt('--write-skeleton')) {
    writeSkeleton(scanned, inv, ids)
    problems.length = 0
    inv = loadInventory(problems)
  }
  const known = new Set(ids)
  const cov = { anchors: 0, notes: 0, guarantees: 0, proved: 0, tested_only: 0, unbacked: 0, promises: ids.length, promises_proved: 0 }

  for (const [id, line] of scanned) {
    if (!inv.anchors.has(id)) problems.push(`${id} (line ${line}): states a hard rule but is not in spec/guarantees`)
  }
  for (const [id, e] of inv.anchors) {
    if (!scanned.has(id)) { problems.push(`${id}: in ${e.file}, but no comment there states a hard rule any more (moved, renamed or deleted?)`); continue }
    cov.anchors++
    if (e.kind === 'note') { cov.notes++; if (!e.why) problems.push(`${id}: a note needs \`why\``); continue }
    if (e.kind !== 'guarantee') { problems.push(`${id}: kind is ${e.kind ?? 'missing'}; classify it as guarantee or note`); continue }
    cov.guarantees++
    if (!e.rule) problems.push(`${id}: a guarantee needs \`rule\``)
    const lean = e.lean || [], tests = e.tests || [], prom = e.promises || []
    for (const ref of lean) { const p = leanProblem(ref); if (p) problems.push(`${id}: ${p}`) }
    for (const t of tests) { const p = testProblem(t); if (p) problems.push(`${id}: ${p}`) }
    for (const p of prom) if (!known.has(p)) problems.push(`${id}: promise ${p} is not in evals/promises.yaml`)
    if (lean.length) cov.proved++
    else if (tests.length || prom.length) cov.tested_only++
    else if (e.none) cov.unbacked++
    else problems.push(`${id}: a guarantee needs lean, tests or promises, or \`none\` saying why nothing backs it`)
  }
  for (const p of ids) {
    const e = inv.promises.get(p)
    if (!e) { problems.push(`promise ${p}: missing from spec/guarantees (give its Lean backing, or lean: [])`); continue }
    for (const ref of e.lean || []) { const q = leanProblem(ref); if (q) problems.push(`promise ${p}: ${q}`) }
    if ((e.lean || []).length) cov.promises_proved++
  }
  for (const p of inv.promises.keys()) if (!known.has(p)) problems.push(`promise ${p}: in spec/guarantees but not in evals/promises.yaml`)

  if (opt('--json')) console.log(JSON.stringify({ problems, coverage: cov }, null, 1))
  else {
    for (const p of problems) console.log(`FAIL ${p}`)
    console.log(`guarantees: ${cov.guarantees} (proved in Lean ${cov.proved}, tested only ${cov.tested_only}, unbacked with a reason ${cov.unbacked}); notes: ${cov.notes}`)
    console.log(`promises: ${cov.promises} (with a Lean proof ${cov.promises_proved})`)
    console.log(problems.length ? `${problems.length} problem(s)` : 'ok')
  }
  process.exit(problems.length ? 1 : 0)
}

main()
