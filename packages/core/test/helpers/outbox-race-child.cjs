/**
 * A separate writer process for the outbox race tests
 * (test/outbox-claim-races.test.ts). Runs against the BUILT core
 * (dist/index.js), so every writer is a real, independent process: its own
 * pid, its own event loop, no shared memory with the test or with the other
 * writers. The only things they share are the store directory and the HTTP
 * stub — exactly what two agents on one machine share.
 *
 * argv[2] is a JSON job:
 *   { mode: 'flush', dist, store }
 *     One flushOutbox(); prints its result as JSON.
 *   { mode: 'learn', dist, store, statement, scope }
 *     One learn() to a remote scope (queued locally, pushed in the background), then waits until its background
 *     push has finished (its claim is released) before exiting.
 *   { mode: 'claim-race', dist, store, id, rounds, dir, index, impl }
 *     Long-lived. For each round r it waits for `<dir>/go-<r>` (which holds a
 *     start time), spins until that instant so all racers fire together,
 *     tries once to take the claim on `id`, and writes the outcome to
 *     `<dir>/res-<r>-<index>`. A winner keeps its claim (it never releases),
 *     so a later racer cannot mistake a released claim for a free one: every
 *     'claimed' in a round is a concurrent winner. `impl` is 'real' (core's
 *     _claimOutboxEntry) or 'mutant' (the pre-fix read-compare-rename
 *     takeover, kept here to prove the race harness can see a non-atomic
 *     takeover at all).
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { randomUUID } = require('crypto')

const job = JSON.parse(process.argv[2])
const { Plur } = require(job.dist)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(pred, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await sleep(5)
  }
}

function claimsFor(store, id) {
  try {
    return fs.readdirSync(path.join(store, 'cache', 'outbox-claims')).filter(f => f.startsWith(id))
  } catch { return [] }
}

/** The takeover as it was before the fix: read, compare, rename, read back. */
function mutantClaim(plur, id, keyFor) {
  const p = plur._outboxClaimPath(id)
  const readRaw = () => { try { return fs.readFileSync(p, 'utf8') } catch { return undefined } }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const stale = readRaw()
  if (stale !== undefined) {
    let held = {}
    try { held = JSON.parse(stale) } catch { /* lapsed */ }
    if (plur._outboxClaimHeld(held, Date.now())) return { status: 'busy' }
  }
  const token = randomUUID()
  const at = Date.now()
  const body = JSON.stringify({ key: keyFor(), token, pid: process.pid, host: os.hostname(), at, until: at + 60_000 })
  if (stale === undefined) {
    try { fs.writeFileSync(p, body, { flag: 'wx' }); return { status: 'claimed' } } catch { return { status: 'busy' } }
  }
  const tmp = `${p}.${process.pid}.${token}.tmp`
  fs.writeFileSync(tmp, body)
  if (readRaw() !== stale) { fs.rmSync(tmp, { force: true }); return { status: 'busy' } }
  fs.renameSync(tmp, p)
  try { if (JSON.parse(readRaw() ?? '{}').token !== token) return { status: 'busy' } } catch { return { status: 'busy' } }
  return { status: 'claimed' }
}

async function main() {
  const plur = new Plur({ path: job.store })
  if (job.mode === 'flush') {
    const r = await plur.flushOutbox()
    process.stdout.write(JSON.stringify(r))
    return
  }
  if (job.mode === 'learn') {
    const e = await plur.learn(job.statement, { scope: job.scope, type: 'behavioral' })
    // learn() takes the push claim before it returns; wait for the push
    // to record its outcome and let the claim go.
    await waitFor(() => claimsFor(job.store, e.id).length === 0)
    process.stdout.write(JSON.stringify({ id: e.id }))
    return
  }
  if (job.mode === 'claim-race') {
    const claim = job.impl === 'mutant'
      ? () => mutantClaim(plur, job.id, () => 'k')
      : () => plur._claimOutboxEntry(job.id, () => 'k')
    for (let r = 0; r < job.rounds; r++) {
      const go = path.join(job.dir, `go-${r}`)
      await waitFor(() => fs.existsSync(go))
      let at
      try { at = Number(fs.readFileSync(go, 'utf8')) } catch { at = 0 }
      if (!Number.isFinite(at) || at === 0) { await sleep(5); at = Number(fs.readFileSync(go, 'utf8')) }
      while (Date.now() < at) { /* spin: fire together */ }
      let status
      try { status = claim().status } catch (err) { status = `error:${err.message}` }
      // core falls back to an unrecorded claim when it cannot write one at
      // all; in this race that would be a failure, not a win.
      if (status === 'claimed' && job.impl !== 'mutant') {
        let owner
        try { owner = JSON.parse(fs.readFileSync(plur._outboxClaimPath(job.id), 'utf8')).pid } catch { owner = undefined }
        if (owner !== process.pid) status = 'claimed-unrecorded'
      }
      const res = path.join(job.dir, `res-${r}-${job.index}`)
      fs.writeFileSync(`${res}.tmp`, status)
      fs.renameSync(`${res}.tmp`, res)
    }
    // Stay alive until the test has every result: a winner that exited would
    // leave a dead owner's claim, which a slower racer may rightly take over.
    await waitFor(() => fs.existsSync(path.join(job.dir, 'done')))
    return
  }
  throw new Error(`unknown mode ${job.mode}`)
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1) })
