/**
 * Test preload (`node --import <this> cli.js hook-inject`) that lines up
 * concurrent hook-inject processes AT the inject lock.
 *
 * Process start-up jitter (tens of ms) is far wider than any lock's
 * check-to-create window, so hooks spawned together would otherwise reach the
 * lock one after another and even a racy lock would look exclusive. Only
 * calls on a `*.injecting` path (statSync, openSync, writeFileSync) are
 * gated, and each process counts its own:
 *   1. before its FIRST call: wait until PLUR_TEST_BARRIER_N processes have
 *      arrived, so they all make that call together;
 *   2. after it: wait until all N have made it;
 *   3. if that first call SUCCEEDED (this process created the lock), wait
 *      until the other N-1 have finished a SECOND call. For an exclusive lock
 *      that second call is the loser's look at the live lock, so the holder
 *      cannot finish and release before every other process has seen it held.
 *      That isolates mutual exclusion from the separate marker-before-lock
 *      ordering. A lock whose first call is a check (stat-then-write) has no
 *      successful first call, so nobody waits there — as in production.
 * Each wait is bounded at 30s. Nothing in production reads these env vars;
 * without this preload they are inert.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const DIR = process.env.PLUR_TEST_BARRIER_DIR
const N = Number(process.env.PLUR_TEST_BARRIER_N || 0)
const SLEEP = new Int32Array(new SharedArrayBuffer(4))
let calls = 0

function count(prefix) {
  return fs.readdirSync(DIR).filter(f => f.startsWith(`${prefix}-`) && f !== `${prefix}-${process.pid}`).length
}
function mark(prefix) { fs.writeFileSync(join(DIR, `${prefix}-${process.pid}`), '') }
function waitOthers(prefix, n) {
  const until = Date.now() + 30_000
  while (Date.now() < until && count(prefix) < n) {
    Atomics.wait(SLEEP, 0, 0, 5) // yield: a busy spin starves the slowest process on a loaded machine
  }
}

for (const name of ['statSync', 'openSync', 'writeFileSync']) {
  const real = fs[name]
  fs[name] = function (path, ...rest) {
    const gated = DIR && N && typeof path === 'string' && path.endsWith('.injecting')
    if (!gated) return real.call(this, path, ...rest)
    const call = ++calls
    if (call === 1) {
      mark('arrived')
      waitOthers('arrived', N - 1)
      let ok = false
      try { const r = real.call(this, path, ...rest); ok = true; return r } finally {
        mark('tried')
        waitOthers('tried', N - 1)
        if (ok) waitOthers('second', N - 1)
      }
    }
    try { return real.call(this, path, ...rest) } finally { if (call === 2) mark('second') }
  }
}
syncBuiltinESMExports()
