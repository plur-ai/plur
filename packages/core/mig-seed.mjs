import { writeFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { createHash } from 'crypto'
import { PGLiteAdapter, engramSearchText } from '/Users/gregor/Data/5-plur/2-projects/plur/packages/core/dist/index.js'
const dir = process.argv[2]
const mk = (id, statement) => ({ id, statement, type: 'behavioral', scope: 'global', status: 'active', tags: [],
  activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-08-27' },
  feedback_signals: { positive: 0, negative: 0, neutral: 0 } })
const engrams = [mk('ENG-1','alpha'), mk('ENG-2','beta'), mk('ENG-3','gamma')]
writeFileSync(join(dir,'engrams.yaml'), yaml.dump({ engrams }))
const a = new PGLiteAdapter(join(dir,'engrams.yaml'), join(dir,'store.pglite'), { vectorDim: 384 })
await a.syncFromYaml()
for (const [i,e] of engrams.entries()) {
  const hash = i === 2 ? 'stale-hash' : createHash('md5').update(engramSearchText(e)).digest('hex')
  await a.upsertEmbedding(e.id, new Float32Array(384).fill(0.1*(i+1)), hash)
}
await a.close(); console.log('seeded'); process.exit(0)
