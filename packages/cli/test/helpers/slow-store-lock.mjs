/**
 * Test preload (`node --import <this> cli.js ...`): make acquiring the store
 * lock SLOW, so a hook that force-exits while its process is inside a store
 * write is caught doing it every time rather than 1 run in N (#1343).
 *
 * Core publishes the lock complete (#1354): the owner token is written to a
 * private sibling (`engrams.yaml.lock.publish.<token>`) and hard-linked into
 * place with `link(private, lock)`. This wraps that `link` call and sleeps
 * after it lands for PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS — a comma list, one
 * delay per acquisition in order, the last one repeating ("6000,1500": the
 * first holder is slow, so a second writer in the same process queues behind
 * it; the second is quick enough to finish inside a bounded wait). A process
 * that exits inside that window leaves `engrams.yaml.lock` naming its own
 * (now dead) pid.
 *
 * PLUR_TEST_LOCK_PRE_OPEN_DELAYS_MS (same list shape) models the step BEFORE
 * that: the `link` has been issued but has not landed yet. A real link issued
 * to libuv's threadpool can still land after `process.exit()` has been called,
 * with no JS left to release it — so if the process exits inside this window,
 * an exit handler lands the link, as the kernel would. A check that only looks
 * at the disk sees no lock here.
 *
 * Before #1354 the lock was an O_EXCL create followed by a token write, and
 * this preload split those two halves instead. It must follow core's publish
 * primitive: a preload that wraps a call core no longer makes is inert, and
 * every test using it passes without exercising the race.
 *
 * Nothing in production reads these env vars; without this preload they are inert.
 */
import fsp from 'node:fs/promises'
import { linkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const DELAYS = String(process.env.PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS ?? '')
  .split(',').filter(s => s.trim() !== '').map(Number).filter(n => Number.isFinite(n) && n >= 0)
const PRE_OPEN = String(process.env.PLUR_TEST_LOCK_PRE_OPEN_DELAYS_MS ?? '')
  .split(',').filter(s => s.trim() !== '').map(Number).filter(n => Number.isFinite(n) && n >= 0)
const pick = (list, i) => list.length === 0 ? 0 : list[Math.min(i, list.length - 1)]
let acquisitions = 0
/** Links issued but not landed — landed by the exit handler if the process dies first. */
const inFlight = new Map()
process.on('exit', () => {
  for (const [target, source] of inFlight) { try { linkSync(source, target) } catch { /* exists, or source gone */ } }
})
const realLink = fsp.link

fsp.link = async function slowLockLink(existingPath, newPath) {
  if ((DELAYS.length > 0 || PRE_OPEN.length > 0) && typeof newPath === 'string' && newPath.endsWith('engrams.yaml.lock')) {
    const n = acquisitions++
    const preOpen = pick(PRE_OPEN, n)
    if (preOpen > 0) {
      inFlight.set(newPath, existingPath)
      try { await new Promise(r => setTimeout(r, preOpen)) } finally { inFlight.delete(newPath) }
    }
    await realLink.call(this, existingPath, newPath) // throws EEXIST exactly as before
    await new Promise(r => setTimeout(r, pick(DELAYS, n)))
    return
  }
  return realLink.call(this, existingPath, newPath)
}
syncBuiltinESMExports()
