/**
 * P03 — per-entry schema skip becomes permanent deletion on the next write.
 *
 * loadEngrams() skips entries that fail EngramSchemaPassthrough with a warning
 * and returns the rest. Every writer then persists that filtered array as the
 * WHOLE corpus, so a skipped entry is deleted from disk by an unrelated write.
 * The file parses perfectly — the corrupt-store throw never fires.
 */
import { Plur } from '../src/index.js'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'

const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p03-'))
process.env.PLUR_PATH = root
const enPath = join(root, 'engrams.yaml')

const plur = new Plur({ storagePath: root, autoDiscover: false })
for (let i = 0; i < 5; i++) await plur.learn(`valuable fact ${i}`, { scope: 'local' })

// Damage ONE entry in a way a future schema tightening, a hand-edit, or a
// partial third-party writer plausibly produces: an out-of-range number.
const doc = yaml.load(fs.readFileSync(enPath, 'utf8')) as { engrams: any[] }
doc.engrams[2].activation.retrieval_strength = 1.4       // > 1 → schema violation
doc.engrams[3].statement = 42                            // wrong type
fs.writeFileSync(enPath, yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' }))

const before = yaml.load(fs.readFileSync(enPath, 'utf8')) as { engrams: any[] }
console.log('on disk before:', before.engrams.length, before.engrams.map(e => e.id).join(','))

// An ordinary unrelated write.
const plur2 = new Plur({ storagePath: root, autoDiscover: false })
await plur2.learn('an unrelated new fact', { scope: 'local' })
await new Promise(r => setTimeout(r, 50))

const after = yaml.load(fs.readFileSync(enPath, 'utf8')) as { engrams: any[] }
console.log('on disk after :', after.engrams.length, after.engrams.map(e => e.id).join(','))
const lost = before.engrams.map(e => e.id).filter(id => !after.engrams.some(e => e.id === id))
console.log(lost.length > 0 ? `LOSS — permanently deleted: ${lost.join(',')}` : 'no loss')
console.log('backup files present:', fs.readdirSync(root).filter(f => f.includes('.bak')))
fs.rmSync(root, { recursive: true, force: true })
