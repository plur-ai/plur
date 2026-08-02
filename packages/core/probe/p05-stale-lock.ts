/**
 * P05 — stale-lock stealing (10 s, mtime-based, no liveness check).
 *
 * Part A: primitive level. Holder takes the lock for 12 s; a second process
 *   steals it after the 10 s stale threshold and both run their critical
 *   sections concurrently. The holder's `finally` then unlinks the THIEF's
 *   lock file, so a third writer walks straight in.
 * Part B: how big a corpus does a single locked save have to be for the
 *   critical section to exceed 10 s on this machine?
 */
import { withAsyncLock } from '../src/store/async-lock.js'
import { saveEngrams, loadEngrams } from '../src/engrams.js'
import { fork } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Engram } from '../src/schemas/engram.js'

const self = fileURLToPath(import.meta.url)
const target = process.argv[3]

function mkEngram(i: number): Engram {
  return {
    id: `ENG-2026-08-02-${String(i).padStart(3, '0')}`,
    version: 2, status: 'active', consolidated: false, type: 'behavioral', scope: 'local',
    visibility: 'private', statement: `synthetic engram ${i} ` + 'lorem ipsum dolor sit amet '.repeat(60),
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-02' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null, content_hash: `h${i}`,
    commitment: 'leaning', reference_count: 1, sources: [], recurrence_count: 0,
    summary: `s${i}`, engram_version: 1, episode_ids: [],
  } as unknown as Engram
}

if (process.argv[2] === 'holder') {
  await withAsyncLock(target, async () => {
    fs.writeFileSync(target + '.holder-in', '1')
    await new Promise(r => setTimeout(r, 12_000))
    fs.writeFileSync(target + '.holder-out', String(Date.now()))
  })
  process.exit(0)
} else if (process.argv[2] === 'thief') {
  const t0 = Date.now()
  await withAsyncLock(target, async () => {
    const overlap = fs.existsSync(target + '.holder-in') && !fs.existsSync(target + '.holder-out')
    fs.writeFileSync(target + '.thief-in', `waited=${Date.now() - t0}ms overlappingHolder=${overlap}`)
    await new Promise(r => setTimeout(r, 3000))
  })
  process.exit(0)
} else {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p05-'))
  const path = join(root, 'engrams.yaml')
  fs.writeFileSync(path, 'engrams: []\n')

  // --- Part A ---
  const holder = fork(self, ['holder', path], { stdio: 'inherit' })
  await new Promise(r => setTimeout(r, 300))
  const thief = fork(self, ['thief', path], { stdio: 'inherit' })
  await new Promise<void>(res => { let n = 0; const done = () => { if (++n === 2) res() }; holder.on('exit', done); thief.on('exit', done) })
  const thiefNote = fs.existsSync(path + '.thief-in') ? fs.readFileSync(path + '.thief-in', 'utf8') : '(thief never entered)'
  console.log('PART A thief:', thiefNote)
  console.log('PART A lock file left behind after both exited:', fs.existsSync(path + '.lock'))

  // --- Part B ---
  for (const n of [1_000, 5_000, 20_000, 50_000]) {
    const engrams = Array.from({ length: n }, (_, i) => mkEngram(i))
    const t0 = Date.now()
    saveEngrams(path, engrams)
    const wrote = Date.now() - t0
    const t1 = Date.now()
    loadEngrams(path)
    const read = Date.now() - t1
    const bytes = fs.statSync(path).size
    console.log(`PART B ${n} engrams: save ${wrote}ms, load ${read}ms, ${(bytes / 1e6).toFixed(1)} MB — locked section ~${wrote + read}ms`)
  }
  fs.rmSync(root, { recursive: true, force: true })
}
