/**
 * P08 — packs/registry.yaml: non-atomic write + corrupt-is-empty loader.
 *
 * saveRegistry() is a plain writeFileSync full replace (no tmp+rename, no
 * lock); loadRegistry() returns [] on any parse failure. So a registry
 * truncated by a crash (or by a concurrent writer) is silently reduced to
 * whatever the next install writes — every other pack's integrity hash and
 * provenance is gone.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { installPack, listPacks } from '../src/packs.js'

const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p08-'))
const packsDir = join(root, 'packs')
fs.mkdirSync(packsDir, { recursive: true })

function makePack(name: string): string {
  const dir = join(root, 'src-' + name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\ndescription: probe pack\n---\n\n# ${name}\n`)
  fs.writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({
    engrams: [{
      id: `ENG-2026-08-02-${name.slice(-1)}01`, version: 2, status: 'active', consolidated: false,
      type: 'behavioral', scope: 'global', visibility: 'public', statement: `pack ${name} knowledge`,
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-02' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
      abstract: null, derived_from: null, polarity: null, content_hash: `h${name}`,
      commitment: 'leaning', reference_count: 1, sources: [], recurrence_count: 0,
      summary: name, engram_version: 1, episode_ids: [],
    }],
  }))
  return dir
}

for (const n of ['packA', 'packB', 'packC']) await installPack(packsDir, makePack(n))
const regPath = join(packsDir, 'registry.yaml')
console.log('registry before:', listPacks(packsDir).map(p => p.name).join(','))

// Crash signature of a non-atomic writeFileSync: a half-written file.
const raw = fs.readFileSync(regPath, 'utf8')
fs.writeFileSync(regPath, raw.slice(0, Math.floor(raw.length * 0.6)) + '  bad: "')
console.log('registry parses after truncation:', (() => { try { yaml.load(fs.readFileSync(regPath, 'utf8')); return true } catch { return false } })())

// FIXED (#805, F11): refuse rather than start from an empty registry. The old
// behaviour let this install rewrite the file with packD alone, taking the
// install record and integrity baseline of A, B and C with it.
let refused = false
try {
  await installPack(packsDir, makePack('packD'))
} catch (err) {
  refused = (err as Error).name === 'PackRegistryUnreadableError'
}
console.log('install against corrupt registry refused:', refused)

// Restore the file (the documented operator fix) and confirm nothing was lost.
fs.writeFileSync(regPath, raw)
const survivors = listPacks(packsDir).map(p => p.name)
console.log('registry after:', survivors.join(','))
const lost = ['packA', 'packB', 'packC'].filter(n => !survivors.includes(n))
console.log(lost.length ? `FAIL: integrity/provenance lost for ${lost.join(',')}` : 'PASS: no pack lost its integrity baseline')
fs.rmSync(root, { recursive: true, force: true })
