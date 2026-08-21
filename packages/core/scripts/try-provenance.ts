/**
 * See a provenance record built from your own memories.
 *
 *   pnpm --filter @plur-ai/core try:provenance                # a recent engram
 *   pnpm --filter @plur-ai/core try:provenance ENG-2026-…    # a specific one
 *   pnpm --filter @plur-ai/core try:provenance -- --write    # also save it
 *
 * READ-ONLY by default. It opens your store, reads one engram and its history,
 * and prints a record. It writes nothing unless you pass --write, and even then
 * only into a temporary directory.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { buildProvenanceRecord, serializeProvenanceRecord } from '../src/provenance.js'
import type { HistoryEvent } from '../src/history.js'

const HOME = process.env.PLUR_PATH ?? join(homedir(), '.plur')
const args = process.argv.slice(2)
const write = args.includes('--write')
const wanted = args.find(a => !a.startsWith('--'))

function bail(message: string): never {
  console.error(`\n${message}\n`)
  process.exit(1)
}

// --- load, read-only ---------------------------------------------------------
const engramsPath = join(HOME, 'engrams.yaml')
if (!existsSync(engramsPath)) bail(`No memory store found at ${HOME}. Set PLUR_PATH to point at one.`)

const parsed = yaml.load(readFileSync(engramsPath, 'utf8')) as { engrams?: any[] }
const engrams = parsed?.engrams ?? []
if (!engrams.length) bail(`No engrams found in ${engramsPath}.`)

const engram = wanted
  ? engrams.find(e => e.id === wanted) ?? bail(`No engram with id ${wanted}.`)
  : [...engrams].reverse().find(e => e.status === 'active') ?? engrams[engrams.length - 1]

// History for this engram, from the append-only log.
const events: HistoryEvent[] = []
const historyDir = join(HOME, 'history')
if (existsSync(historyDir)) {
  for (const file of readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(historyDir, file), 'utf8').split('\n')) {
      if (!line.includes(engram.id)) continue
      try { events.push(JSON.parse(line)) } catch { /* skip a malformed line */ }
    }
  }
}

// --- build -------------------------------------------------------------------
const record = buildProvenanceRecord(engram, events, { mode: 'portable' })
const text = serializeProvenanceRecord(record)
const graph = (record as any)['@graph'] as any[]
const subject = graph.find(n => String(n['@id']) === `engram:${engram.id}`)

const has = (key: string) => subject?.[key] !== undefined
const yes = (ok: boolean) => (ok ? 'yes' : 'NO ')

console.log(`
Reading from   ${HOME}   (nothing is written)
Engram         ${engram.id}
Statement      ${String(engram.statement).slice(0, 70)}${String(engram.statement).length > 70 ? '…' : ''}
History        ${events.length} event(s) found
`)

console.log('The record has ' + graph.length + ' nodes.\n')
console.log('Can a stranger who receives this answer the five questions?\n')
console.log(`   ${yes(has('prov:wasAttributedTo'))}  who made it`)
console.log(`   ${yes(has('engram:claimClass'))}  what kind of claim it is`)
console.log(`   ${yes(has('prov:generatedAtTime'))}  when`)
console.log(`   ${yes(has('prov:hadPrimarySource') || has('engram:sourceNote'))}  what it came from`)
console.log(`   ${yes(has('engram:license'))}  whether they may use it`)

if (!has('prov:wasAttributedTo') || !has('engram:claimClass')) {
  console.log(`
   The "NO" answers above are expected for an engram written before this
   feature existed. Nothing recorded who asserted it or what kind of claim
   it was, so the record does not guess. That gap is what the capture work
   closes going forward.`)
}

console.log('\nThe record itself:\n')
console.log(text)

if (write) {
  const dir = mkdtempSync(join(tmpdir(), 'plur-provenance-'))
  const file = join(dir, `${engram.id}.jsonld`)
  writeFileSync(file, text)
  console.log(`Saved to ${file}\n`)
  console.log('Check it against two outside implementations with:')
  console.log(`   python3 spec/examples/conformance.py ${file}\n`)
}
