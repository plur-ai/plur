/**
 * Regenerates golden.json from the schemas as they are NOW. Run only to record
 * a deliberate behaviour change:
 *
 *   pnpm --filter @plur-ai/core exec tsx test/fixtures/zod-compat/generate.ts
 *
 * The committed golden.json was generated on @plur-ai/core 0.22.1 with
 * zod 3.25.76, before the zod 4 migration.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { runCorpus } from './run.js'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden.json')
fs.writeFileSync(out, JSON.stringify(runCorpus(), null, 2) + '\n')
console.log(`wrote ${out}`)
