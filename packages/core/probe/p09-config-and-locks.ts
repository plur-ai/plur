/**
 * P09 — three smaller writers.
 *
 * A. migrations/runner.setSchemaVersion(): read-modify-write of config.yaml
 *    with NO lock and a bare `catch {}` on the read. persistStores() rethrows
 *    anything that isn't ENOENT precisely so a transient read failure cannot
 *    truncate a live config; this one swallows it.
 * B. sync withLock() vs async withAsyncLock() on the SAME lock file, in the
 *    same process: the sync busy-wait blocks the event loop, so the async
 *    holder can never release.
 * C. history JSONL appendHistory(): concurrent appends from many processes.
 */
import { setSchemaVersion, getSchemaVersion } from '../src/migrations/runner.js'
import { withLock } from '../src/sync.js'
import { withAsyncLock } from '../src/store/async-lock.js'
import { appendHistory, readHistory } from '../src/history.js'
import { fork } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { fileURLToPath } from 'url'

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === 'histchild') {
  const [, , , root, tag, nStr] = process.argv
  for (let i = 0; i < Number(nStr); i++) {
    appendHistory(root, {
      event: 'engram_created', engram_id: `${tag}-${i}`,
      timestamp: new Date().toISOString(),
      data: { filler: 'y'.repeat(600), tag, i },
    })
  }
  process.exit(0)
}

const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p09-'))

// ---- A: config clobber ----
const cfg = join(root, 'config.yaml')
fs.writeFileSync(cfg, yaml.dump({
  stores: [{ url: 'https://plur.datafund.io', scope: 'group:plur/engineering', token: 'SECRET-TOKEN' }],
  auto_learn: true, unscoped_default: 'local', schema_version: 2,
}))
console.log('A. config keys before:', Object.keys(yaml.load(fs.readFileSync(cfg, 'utf8')) as object).join(','))
fs.chmodSync(cfg, 0o000)                       // transient read failure (EACCES)
let threw = ''
try { setSchemaVersion(cfg, 5) } catch (e) { threw = (e as Error).message }
fs.chmodSync(cfg, 0o600)
const afterA = yaml.load(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>
console.log('A. config keys after :', Object.keys(afterA).join(','), threw ? `(threw ${threw})` : '(no throw)')
console.log(afterA.stores ? 'A. SAFE — stores survived' : 'A. LOSS — store registrations + token wiped by setSchemaVersion')

// ---- B: sync/async lock interplay ----
const lockTarget = join(root, 'engrams.yaml')
fs.writeFileSync(lockTarget, 'engrams: []\n')
let asyncReleased = false
const holder = withAsyncLock(lockTarget, async () => {
  await new Promise(r => setTimeout(r, 1200))   // well under the 10s stale threshold
  asyncReleased = true
})
await new Promise(r => setTimeout(r, 50))
const t0 = Date.now()
let syncOutcome = 'acquired'
try { withLock(lockTarget, () => { /* would write here */ }) } catch (e) { syncOutcome = (e as Error).message }
const waited = Date.now() - t0
await holder
console.log(`B. sync withLock: ${syncOutcome} after ${waited}ms; async holder had released=${asyncReleased} at that point`)
console.log(waited > 2000 && syncOutcome !== 'acquired'
  ? 'B. BLOCKED — busy-wait starved the async holder, sync write refused'
  : 'B. sync/async interplay tolerated this case')

// ---- C: history JSONL concurrency ----
const PROCS = 4, PER = 60
await Promise.all(Array.from({ length: PROCS }, (_, i) =>
  new Promise<void>(res => fork(self, ['histchild', root, `w${i}`, String(PER)], { stdio: 'inherit' }).on('exit', () => res()))))
const month = new Date().toISOString().slice(0, 7)
const raw = fs.readFileSync(join(root, 'history', `${month}.jsonl`), 'utf8')
const rawLines = raw.split('\n').filter(l => l.length > 0)
const parsed = readHistory(root, month)
console.log(`C. history: expected ${PROCS * PER}, lines on disk ${rawLines.length}, parseable ${parsed.length}`)
console.log(parsed.length === PROCS * PER ? 'C. SAFE — O_APPEND held, no interleaving' : 'C. LOSS/CORRUPTION in history JSONL')

fs.rmSync(root, { recursive: true, force: true })
