/**
 * P04 — cross-process concurrency on the PRIMARY store (safety claim).
 *
 * Every primary write is _withStoreLock(paths.engrams) → withAsyncLock →
 * O_EXCL <path>.lock. If that holds, N processes × M learns must yield N*M
 * engrams and no id collisions.
 */
import { Plur } from '../src/index.js'
import { loadEngrams } from '../src/engrams.js'
import { fork } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, tag, nStr] = process.argv
  process.env.PLUR_PATH = root
  const plur = new Plur({ storagePath: root, autoDiscover: false })
  for (let i = 0; i < Number(nStr); i++) {
    await plur.learn(`${tag} distinct statement number ${i}`, { scope: 'local' })
  }
  process.exit(0)
} else {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p04-'))
  process.env.PLUR_PATH = root
  const enPath = join(root, 'engrams.yaml')
  const PROCS = 4, PER = 15
  await Promise.all(Array.from({ length: PROCS }, (_, i) =>
    new Promise<void>(res => fork(self, ['child', root, `w${i}`, String(PER)], { stdio: 'inherit' }).on('exit', () => res()))))
  const engrams = loadEngrams(enPath)
  const ids = engrams.map(e => e.id)
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)
  console.log(`engrams.yaml: expected ${PROCS * PER}, found ${engrams.length}`)
  console.log(`duplicate ids: ${dupIds.length} ${[...new Set(dupIds)].slice(0, 5).join(',')}`)
  console.log(`leftover .lock files: ${fs.readdirSync(root).filter(f => f.endsWith('.lock'))}`)
  console.log(engrams.length === PROCS * PER && dupIds.length === 0 ? 'SAFE — no loss, no id collision' : 'LOSS/COLLISION')
  fs.rmSync(root, { recursive: true, force: true })
}
