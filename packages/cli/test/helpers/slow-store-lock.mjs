/**
 * Test preload (`node --import <this> cli.js ...`): make acquiring the store
 * lock SLOW, so a hook that force-exits while its process is inside a store
 * write is caught doing it every time rather than 1 run in N (#1343).
 *
 * The lock is taken by `writeFile(lock, token, { flag: O_EXCL })` in core's
 * async-lock. This splits that call into its two halves — the O_EXCL create
 * (an EMPTY file) and the token write — and sleeps between them for
 * PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS — a comma list, one delay per acquisition
 * in order, the last one repeating ("6000,1500": the first holder is slow, so
 * a second writer in the same process queues behind it; the second is quick
 * enough to finish inside a bounded wait). That is the exact state measured on a
 * 10,000-engram store when the Claude Code hook exited mid-write (#1313): an
 * empty lock, which core cannot attribute to anyone and so waits out for 60s.
 *
 * PLUR_TEST_LOCK_PRE_OPEN_DELAYS_MS (same list shape) models the step BEFORE
 * that: the O_EXCL create has been issued but has not landed yet. A real
 * create issued to libuv's threadpool can still land after `process.exit()`
 * has been called, with no JS left to release it — so if the process exits
 * inside this window, an exit handler lands the create (an empty lock), as the
 * kernel would. A check that only looks at the disk sees no lock here.
 *
 * Nothing in production reads these env vars; without this preload they are inert.
 */
import fsp from 'node:fs/promises'
import { constants, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const DELAYS = String(process.env.PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS ?? '')
  .split(',').filter(s => s.trim() !== '').map(Number).filter(n => Number.isFinite(n) && n >= 0)
const PRE_OPEN = String(process.env.PLUR_TEST_LOCK_PRE_OPEN_DELAYS_MS ?? '')
  .split(',').filter(s => s.trim() !== '').map(Number).filter(n => Number.isFinite(n) && n >= 0)
const pick = (list, i) => list.length === 0 ? 0 : list[Math.min(i, list.length - 1)]
let acquisitions = 0
/** Creates issued but not landed — landed by the exit handler if the process dies first. */
const inFlight = new Set()
process.on('exit', () => {
  for (const file of inFlight) { try { writeFileSync(file, '', { flag: 'wx' }) } catch { /* exists */ } }
})
const realWriteFile = fsp.writeFile

fsp.writeFile = async function slowLockWriteFile(file, data, options) {
  const flag = options && typeof options === 'object' ? options.flag : undefined
  if ((DELAYS.length > 0 || PRE_OPEN.length > 0) && typeof file === 'string' && file.endsWith('engrams.yaml.lock')
    && typeof flag === 'number' && (flag & constants.O_EXCL)) {
    const n = acquisitions++
    const preOpen = pick(PRE_OPEN, n)
    if (preOpen > 0) {
      inFlight.add(file)
      try { await new Promise(r => setTimeout(r, preOpen)) } finally { inFlight.delete(file) }
    }
    const handle = await fsp.open(file, flag) // throws EEXIST exactly as before
    const delay = pick(DELAYS, n)
    try {
      await new Promise(r => setTimeout(r, delay))
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    return
  }
  return realWriteFile.call(this, file, data, options)
}
syncBuiltinESMExports()
