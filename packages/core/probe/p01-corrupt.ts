/**
 * P01 — corrupt-store wipe probe.
 *
 * Populate a store, corrupt engrams.yaml in several distinct ways, then run
 * each write path and report the resulting on-disk engram count.
 */
import { Plur } from '../src/index.js'
import { loadEngrams } from '../src/engrams.js'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

type Corruptor = { name: string; apply: (p: string) => void }

const corruptors: Corruptor[] = [
  {
    name: 'truncate-mid-document (50% bytes)',
    apply: p => {
      const b = fs.readFileSync(p)
      fs.writeFileSync(p, b.subarray(0, Math.floor(b.length / 2)))
    },
  },
  {
    name: 'git merge-conflict markers',
    apply: p => {
      const s = fs.readFileSync(p, 'utf8')
      fs.writeFileSync(p, `<<<<<<< HEAD\n${s}=======\nengrams: []\n>>>>>>> origin/main\n`)
    },
  },
  {
    name: 'invalid UTF-8 bytes injected',
    apply: p => {
      const b = fs.readFileSync(p)
      const bad = Buffer.from([0xff, 0xfe, 0xff, 0xfe])
      fs.writeFileSync(p, Buffer.concat([b.subarray(0, 40), bad, b.subarray(40)]))
    },
  },
  {
    name: 'half-written YAML (tail cut inside a value)',
    apply: p => {
      const s = fs.readFileSync(p, 'utf8')
      fs.writeFileSync(p, s.slice(0, s.length - 30) + '    statement: "unterminated')
    },
  },
  {
    name: 'zero-length file (interrupted writer)',
    apply: p => fs.writeFileSync(p, ''),
  },
  {
    name: 'valid YAML, engrams key lost (scalar top level)',
    apply: p => fs.writeFileSync(p, 'engrams_TYPO: []\n'),
  },
]

async function seed(root: string, n: number): Promise<Plur> {
  const plur = new Plur({ storagePath: root, autoDiscover: false })
  for (let i = 0; i < n; i++) await plur.learn(`seeded engram number ${i} about topic ${i}`, { scope: 'local' })
  return plur
}

function diskCount(p: string): number | string {
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const m = raw.match(/^  - id:/gm)
    return m ? m.length : 0
  } catch (e) { return `unreadable(${(e as Error).message})` }
}

const ops: Array<{ name: string; run: (plur: Plur, ids: string[]) => Promise<unknown> }> = [
  { name: 'learn()', run: p => p.learn('a brand new fact after corruption', { scope: 'local' }) },
  { name: 'feedback()', run: (p, ids) => p.feedback(ids[0], 'positive') },
  { name: 'forget(force)', run: (p, ids) => p.forget(ids[0], 'probe', { force: true }) },
  { name: 'setPinned()', run: (p, ids) => p.setPinned(ids[0], true) },
  { name: 'compact()', run: p => p.compact() },
  { name: 'recall() [read-only path, reactivation write]', run: p => p.recall('topic') },
  { name: 'saveMetaEngrams()', run: async p => { try { return await p.saveMetaEngrams([]) } catch (e) { return e } } },
]

for (const c of corruptors) {
  for (const op of ops) {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p01-'))
    process.env.PLUR_PATH = root
    const enPath = join(root, 'engrams.yaml')
    const plur = await seed(root, 5)
    const ids = (await plur.list()).map(e => e.id)
    const before = diskCount(enPath)
    c.apply(enPath)
    // Baseline AFTER the corruptor ran. Without this the report cannot tell
    // "the corruptor destroyed 5 engrams" from "PLUR destroyed 5 engrams" — a
    // zero-length corruptor leaves 0 on disk by construction, so `after <
    // before` is true no matter how correctly the write path behaves. The
    // question the guards must answer is whether PLUR made it WORSE.
    const corrupted = diskCount(enPath)
    // Fresh instance — the realistic case: a new process picks up the corrupt file.
    const plur2 = new Plur({ storagePath: root, autoDiscover: false })
    let outcome = 'ok'
    try {
      await op.run(plur2, ids)
    } catch (e) {
      outcome = `THREW ${(e as Error).name}: ${(e as Error).message.split('\n')[0].slice(0, 90)}`
    }
    // let background tasks settle
    await new Promise(r => setTimeout(r, 60))
    const after = diskCount(enPath)
    let loaderSays: string
    try { loaderSays = String(loadEngrams(enPath).length) } catch (e) { loaderSays = `throws ${(e as Error).name}` }
    // The finding is PLUR-caused loss: fewer engrams after the operation than
    // the corrupted file already held. Loss caused by the corruptor alone is
    // reported as DAMAGE — real, but not something the write path can undo.
    const plurLost = typeof corrupted === 'number' && typeof after === 'number' && after < corrupted
    const corruptorLost = typeof before === 'number' && typeof corrupted === 'number' && corrupted < before
    const label = plurLost ? 'LOSS  ' : corruptorLost ? 'DAMAGE' : '      '
    console.log(
      `${label} [${c.name}] ${op.name}: disk ${before} -> (corrupt) ${corrupted} -> ${after} | loader: ${loaderSays} | ${outcome}`,
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
}
