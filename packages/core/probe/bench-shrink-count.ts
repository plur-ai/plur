/** Cost of the unconditional shrink-guard count vs the old full parse. */
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { saveEngrams } from '../src/engrams.js'

const N = 20000
const dir = fs.mkdtempSync(join(os.tmpdir(), 'plur-bench-'))
const file = join(dir, 'engrams.yaml')
const engrams = Array.from({ length: N }, (_, i) => ({
  id: `ENG-2026-08-03-${String(i).padStart(6, '0')}`,
  statement: `statement number ${i} ` + 'x'.repeat(i % 7 === 0 ? 40 : 400),
  type: 'behavioral', scope: 'global', status: 'active', tags: ['a', 'b'],
  rationale: i % 7 === 0 ? undefined : 'because '.repeat(30),
  activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-08-03' },
  feedback_signals: { positive: 0, negative: 0, neutral: 0 },
}))
fs.writeFileSync(file, yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' }))
const sizeMb = (fs.statSync(file).size / 1e6).toFixed(1)

function median(xs: number[]): number { const a=[...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)] }
function timeN(label: string, n: number, fn: () => void): number {
  const runs: number[] = []
  fn() // warm
  for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); fn(); runs.push(Number(process.hrtime.bigint() - t) / 1e6) }
  const m = median(runs)
  console.log(`${label}: median ${m.toFixed(0)}ms  (runs ${runs.map(r => r.toFixed(0)).join(', ')})`)
  return m
}

console.log(`store: ${N} engrams, ${sizeMb} MB (heterogeneous record sizes)`)
const parse = timeN('OLD exact count (full yaml.load)', 5, () => { yaml.load(fs.readFileSync(file, 'utf8')) })
const guarded = timeN('saveEngrams WITH unconditional count', 5, () => { saveEngrams(file, engrams as any) })
const unguarded = timeN('saveEngrams allowShrink (count skipped)', 5, () => { saveEngrams(file, engrams as any, { allowShrink: true }) })
console.log(`\nguard overhead: ${(guarded - unguarded).toFixed(0)}ms on a ${sizeMb}MB save`)
console.log(`vs the old parse-based count, which would have added: ${parse.toFixed(0)}ms`)
fs.rmSync(dir, { recursive: true, force: true })
