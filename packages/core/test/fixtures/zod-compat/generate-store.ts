/**
 * Writes store-0.22.1/: a PLUR store, an exported pack and a config file
 * produced by the real write paths of @plur-ai/core 0.22.1 (zod 3.25.76).
 * zod-compat.test.ts loads them with the current code, so a store written by
 * that release must keep loading after a schema-library upgrade.
 *
 * Kept for provenance; regenerating it with newer code defeats its purpose.
 *
 *   pnpm --filter @plur-ai/core exec tsx test/fixtures/zod-compat/generate-store.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { Plur } from '../../../src/index.js'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'store-0.22.1')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-zod-fixture-'))
const storeDir = path.join(work, 'store')
fs.mkdirSync(storeDir, { recursive: true })
fs.writeFileSync(path.join(storeDir, 'config.yaml'), yaml.dump({
  auto_learn: true,
  injection: { spread_cap: 4 },
  dedup: { mode: 'off' },
  index: false,
  stores: [{ path: path.join(work, 'team'), scope: 'group:example/team', shared: true, description: 'Example team store', covers: ['example'] }],
}))

const plur = new Plur({ path: storeDir })
const a = await plur.learn('Run pnpm -r build after switching branches', {
  type: 'procedural', scope: 'global', domain: 'software.build', tags: ['pnpm', 'build'],
  rationale: 'A partial rebuild leaves stale dist imports',
  knowledge_anchors: [{ path: 'docs/build.md', relevance: 'primary', snippet: 'pnpm -r build' }],
  dual_coding: { example: 'pnpm -r build' }, commitment: 'decided', visibility: 'public',
  attribution: { asserted_by: 'unidentified', runtime: { name: 'fixture', version: '0.22.1' } },
})
const b = await plur.learn('Never commit generated dist folders', {
  type: 'behavioral', scope: 'project:example', domain: 'software.git', tags: ['git'],
})
await plur.learn('An engram is the atomic unit of learned knowledge', {
  type: 'terminological', scope: 'global', domain: 'plur.terms', memory_class: 'semantic',
})
await plur.feedback(a.id, 'positive')
await plur.feedback(b.id, 'negative')
plur.capture('Fixture session: learned three engrams', { agent: 'fixture', tags: ['fixture'] } as any)
const packDir = path.join(work, 'pack')
plur.exportPack([a], packDir, { name: 'fixture-pack', version: '1.0.0', description: 'Fixture pack', creator: 'fixture', license: 'cc0-1.0', tags: ['fixture'] } as any)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(storeDir)) {
  if (!f.endsWith('.yaml')) continue
  // The temp directory name is not reproducible; the test substitutes its own.
  const text = fs.readFileSync(path.join(storeDir, f), 'utf8').split(work).join('__WORK__')
  fs.writeFileSync(path.join(OUT, f), text)
}
fs.cpSync(packDir, path.join(OUT, 'pack'), { recursive: true })
console.log(`wrote ${OUT}:`, fs.readdirSync(OUT).join(', '))
