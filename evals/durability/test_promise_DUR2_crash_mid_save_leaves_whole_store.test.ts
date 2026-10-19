// DUR-2: A crash in the middle of saving never leaves a half-written or empty store.
//
// A child process saves memories in a loop on a simulated slow disk (see the
// child script) and is killed with SIGKILL at set moments, five times. After
// every kill the store must open, be complete (every save that was acknowledged
// before the kill is there) and never be empty.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

const coreRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url))
const CHILD = fileURLToPath(new URL('../helpers/sync-packs-durability-history-crash-child.mts', import.meta.url))
// Milliseconds after the child's first acknowledged save of a round. Fixed, not
// random, so a failure can be re-run; spread so they land at different points
// of a ~200 ms write.
const KILL_AFTER_MS = [40, 95, 150, 230, 310]

function runAndKill(storeDir: string, round: number, killAfterMs: number): Promise<{ acked: string[]; stderr: string }> {
  let tsxLoader: string
  try { tsxLoader = coreRequire.resolve('tsx') } catch {
    throw new Error('DUR-2 needs tsx (a dev dependency of packages/core) to run the crashing child process; it was not found. Run pnpm install.')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, CHILD, storeDir, String(round)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const acked: string[] = []
    let out = ''
    let stderr = ''
    let armed = false
    const giveUp = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`round ${round}: the child never acknowledged a save within 60 s. stderr: ${stderr.slice(-2000)}`)) }, 60_000)
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1)
        if (line.startsWith('ACK ')) acked.push(line.slice(4))
      }
      if (!armed && acked.length > 0) {
        armed = true
        setTimeout(() => child.kill('SIGKILL'), killAfterMs)
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('exit', () => { clearTimeout(giveUp); resolve({ acked, stderr }) })
    child.on('error', reject)
  })
}

describe('DUR-2 a crash in the middle of saving never leaves a half-written or empty store', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('five hard kills during saves, and after each the store opens whole', async () => {
    s = await tempStore({ embedder: 'off' })
    const seeded: string[] = []
    for (let i = 0; i < 10; i++) {
      const st = `Seed memory ${i}: the archive shelf ${i} holds volume ${i * 7}`
      await s.plur.learn(st, { scope: 'global' })
      seeded.push(st)
    }
    const acknowledged = [...seeded]

    for (let round = 0; round < KILL_AFTER_MS.length; round++) {
      const { acked, stderr } = await runAndKill(s.dir, round, KILL_AFTER_MS[round])
      expect(acked.length, `precondition (round ${round + 1}): the child acknowledged at least one save before it was killed. stderr: ${stderr.slice(-1500)}`).toBeGreaterThan(0)
      acknowledged.push(...acked)

      let statements: string[] = []
      let openError: unknown = null
      try {
        const reopened = new Plur({ path: s.dir, autoDiscover: false })
        statements = (await reopened.list()).map(e => e.statement)
      } catch (e) { openError = e }
      expect(openError, `after kill ${round + 1} (${KILL_AFTER_MS[round]} ms into a save) the store would not open: ${String(openError).slice(0, 300)}`).toBeNull()
      expect(statements.length, `after kill ${round + 1} the store opened empty`).toBeGreaterThan(0)
      const lost = acknowledged.filter(st => !statements.includes(st))
      expect(lost, `after kill ${round + 1} (${KILL_AFTER_MS[round]} ms into a save), ${lost.length} acknowledged memories were missing`).toEqual([])
    }
  }, 300_000)
})
