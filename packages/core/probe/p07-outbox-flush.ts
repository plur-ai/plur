/**
 * P07 — flushOutbox() merge-back window.
 *
 * flushOutbox loads the corpus WITHOUT the store lock, does network round
 * trips, then re-loads under the lock and overlays `survivorsById` — the
 * PRE-NETWORK copies of every engram it considered. Any mutation another
 * writer made to one of those engrams during the flight window is silently
 * reverted.
 *
 * The stub remote is slow on purpose, to make the window visible.
 */
import { Plur } from '../src/index.js'
import { loadEngrams } from '../src/engrams.js'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

const DELAY_MS = 1500
let served = 0
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    setTimeout(() => {
      served++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: `SRV-${served}` }))
    }, DELAY_MS)
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as any).port
const url = `http://127.0.0.1:${port}`

const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p07-'))
process.env.PLUR_PATH = root
const enPath = join(root, 'engrams.yaml')

// Register a remote store for scope team:alpha; queue two engrams into the
// outbox by making the immediate push fail (server not yet reachable for
// that first attempt is hard to stage, so write outbox metadata directly).
const plur = new Plur({ storagePath: root, autoDiscover: false })
plur.addStore('unused', 'team:alpha', { url, token: 't' })

const a = await plur.learn('outbox engram alpha', { scope: 'local' })
const b = await plur.learn('outbox engram beta', { scope: 'local' })
const bystander = await plur.learn('a bystander engram nobody flushes', { scope: 'local' })

// Stamp outbox metadata on a and b (what a failed immediate push leaves).
const stamp = (e: any) => ({
  ...e,
  structured_data: {
    ...(e.structured_data ?? {}),
    _outbox: { target_url: url, target_scope: 'team:alpha', queued_at: new Date().toISOString(), last_attempt: new Date().toISOString(), attempt_count: 1, last_error: 'boom' },
  },
})
await plur.updateEngram(stamp(a) as any)
await plur.updateEngram(stamp(b) as any)

console.log('before flush:', loadEngrams(enPath).map(e => `${e.id}(fb+${e.feedback_signals.positive})`).join(' '))

// Start the flush, and mid-flight rate BOTH a flushed engram and a bystander.
const flushing = plur.flushOutbox()
await new Promise(r => setTimeout(r, DELAY_MS / 2))
const plur2 = new Plur({ storagePath: root, autoDiscover: false })
await plur2.feedback(a.id, 'positive')          // engram that the flush is pushing
await plur2.feedback(bystander.id, 'positive')  // engram the flush never considered
const midFlight = await plur2.learn('learned DURING the flush window', { scope: 'local' })

const result = await flushing
await new Promise(r => setTimeout(r, 200))

const after = loadEngrams(enPath)
console.log('flush result:', JSON.stringify(result))
console.log('after flush :', after.map(e => `${e.id}(fb+${e.feedback_signals.positive})`).join(' '))
console.log('mid-flight learn survived:', after.some(e => e.id === midFlight.id))
const bystanderAfter = after.find(e => e.id === bystander.id)
console.log('bystander feedback preserved:', bystanderAfter?.feedback_signals.positive === 1)
console.log('flushed engrams removed locally:', !after.some(e => e.id === a.id || e.id === b.id))
server.close()
fs.rmSync(root, { recursive: true, force: true })
