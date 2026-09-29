import { readdirSync } from 'fs'
import { join } from 'path'

/**
 * Wait until learn()'s fire-and-forget pushes have finished and recorded their
 * outcome.
 *
 * Tests that queue with learn() and then flush used a fixed sleep (60ms). A
 * flush and a background push of the same entry are now mutually exclusive
 * (2026-09-29 panel, M6): a flush that starts while the push is still running
 * correctly leaves that entry to it. So a test that assumes the push is over
 * must wait for that condition, not for a duration. On a loaded machine 60ms
 * was never a guarantee anyway.
 *
 * A background push holds a claim file (`<root>/cache/outbox-claims/`) from
 * before its request until its outcome is written, so an empty claims
 * directory means every push has settled.
 */
export async function backgroundPushesSettled(root: string, timeoutMs = 10_000): Promise<void> {
  const claims = join(root, 'cache', 'outbox-claims')
  const until = Date.now() + timeoutMs
  for (;;) {
    let held: string[] = []
    try { held = readdirSync(claims) } catch { /* none yet */ }
    if (held.length === 0) return
    if (Date.now() > until) throw new Error(`background pushes still running after ${timeoutMs}ms: ${held.join(', ')}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
