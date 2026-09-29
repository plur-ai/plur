# Data-loss audit (pass 1 of 3): write paths on the 2026-09-29 integration branch

**Target:** `origin/integration/field-report-2026-09-29` @ `baf6df61`, diffed against `origin/main` (merge base).
**Question:** can any path in this diff lose, duplicate, silently mis-scope or fail to deliver an engram, a feedback signal, an outbox entry, config.yaml / folders.yaml / trust.yaml content, or a session checkpoint?
**Method:** same as the 2026-08-02 and 2026-08-13 audits. A finding counts only if a probe ran against the built code of this branch (`packages/core/dist`, `packages/cli/dist`) and showed the before/after. Every probe ran in fresh temp dirs with a temp `HOME` and `PLUR_PATH`; the real `~/.plur` was never touched. Where the question was "is this new?", the same probe ran against `origin/main` (separate worktree). The remote is a small local HTTP server (`server.mjs`, below). It implements `docs/remote-store-contract.md` as written: a POST with an `Idempotency-Key` already seen **from the same token** returns the original response.
**Blind:** other passes' outputs were not read.

## Findings

| # | Severity | What happens | Where |
|---|---|---|---|
| F1 | **CRITICAL (latent)** | Every `learnRouted` POST carries `Idempotency-Key: __pending__`. A server that follows the contract we just published keeps the first team write and answers every later one with the first engram's id. The client reports `delivery: remote`, keeps no local copy and queues nothing. Every team write after the first is lost. | `core/src/index.ts:3712` (posts `localPlaceholder`), whose id is `'__pending__'` (`index.ts:3903`); the key is set at `store/remote-store.ts:779`; the contract is `docs/remote-store-contract.md` |
| F2 | **MEDIUM** | A hook's outer timer gives up on a flush whose POST already landed, while the merge-back waits on the store lock. The hook exits. The entry is not marked `in_doubt`, so the next flush POSTs it again and the server holds two copies. The contract doc says a server that ignores the key "is still safe, because the client also checks before retrying". That is not true on this path. | `cli/src/lib/hook-outbox-flush.ts:148` (outer timer), with the `_withStoreLock` merge-back in `core/src/index.ts` `_flushOutbox` |
| F3 | **MEDIUM** | The in-doubt probe treats **any** active row in the scope with the same statement as "ours". A teammate's same-sentence engram makes the flush count ours as delivered and delete the local copy. Our rationale, tags and type never reach the store. | `core/src/store/remote-store.ts:841`; `core/src/index.ts:8492` |
| F4 | **MEDIUM** | An in-doubt entry in a scope with more than 10,000 server rows can never be delivered. The probe stops at 50 pages and returns `unknown`, so every flush defers it, a forced one too. `plur outbox` shows it as `retrying`. | `core/src/store/remote-store.ts:845`; `core/src/index.ts:8492` |
| F5 | LOW | Automatic feedback is applied twice for one reply. `hook-auto-rate`'s watchdog (`process.exit`) can fire after one verdict was applied and before the `.rated` list is written, and the next turn applies it again. The design promises "at most one automatic verdict per session". | `cli/src/commands/hook-auto-rate.ts:78`; `cli/src/lib/auto-rate.ts:165` |
| F6 | LOW (was already on main, now covers more) | `folders.yaml` is read, changed and written back with no lock. Concurrent `plur trust` / `plur folders set` / ask-flow writes lose each other's entries: 8 concurrent grants kept 1. `trust.yaml` on main had the same race (8 kept 1–2). folders.yaml now also holds on/off/scope decisions. | `core/src/folders.ts:457` (`setFolderEntry`), `:281` |
| F7 | LOW | trust.yaml and folders.yaml drift apart after the one-time import. `plur untrust` clears only folders.yaml, so an older PLUR reading the same home (for example a pinned older MCP server) still trusts the folder. A grant an older writer adds to trust.yaml is never seen by the new code. | `core/src/folders.ts:256`; `core/src/trust.ts:57` |
| F8 | LOW (behaviour already on main) | A save to shared scope B, which has a writable url store, is absorbed when the same text exists in team scope A. B's store receives nothing. On this branch the first save is reported with a warning that names the wrong scope (A). The second save returns a local `global` copy with **no** warning. main absorbs too, and also broadens A's engram to `global` in the team file; this branch no longer does that. | `core/src/index.ts:3297`, `:2421-2426`, `deliveryOf` |

### F1: every routed team write shares one idempotency key (CRITICAL, latent)

`learnRouted` builds `localPlaceholder` with `_buildEngramShape`, whose id is `'__pending__'`. It posts that object through `appendAndGetServerId`, and #1269 made that method send `Idempotency-Key: engram.id`. So every direct team write from `plur_learn` (MCP `tools.ts:1273`), `plur learn` and auto-capture carries the same key. `docs/remote-store-contract.md` (new in this diff) says the key is "different for different writes" and asks servers to replay the original response for a repeated key. A server that implements the contract drops every routed write after the first. The client believes each one was delivered (`_remoteDelivered`, `deliveryOf` → `remote`), and there is no local copy and no outbox entry, so the loss is silent and cannot be recovered.

Latent because it needs a server that honours the header. The header ships now and the contract invites servers to honour it, so the first server that does will lose data. The same key scheme is also weak on the flush path: the key is the *local* id (`ENG-YYYY-MM-DD-NNN`, a per-day sequence), so two machines using one token mint the same key for different engrams on the same day.

**Expected:** three distinct keys, three server rows. **Actual (ran):**
```
learnRouted -> ENG-SRV-001 {"delivery":"remote"}
learnRouted -> ENG-SRV-001 {"delivery":"remote"}
learnRouted -> ENG-SRV-001 {"delivery":"remote"}
POST keys seen by server: [ '__pending__', '__pending__', '__pending__' ]
server rows: [ 'Deploys to staging need a green canary first' ]
local rows: [] outbox: 0
```
Repro: `node r1-idempotency-key.mjs` (script below).

### F2: an abandoned merge-back leads to a duplicate POST (MEDIUM)

`flushOutboxForHook` races the flush against `budgetMs + 500`. The network budget is honoured, but the merge-back runs under `engrams.yaml.lock` and nothing bounds it. When the lock is held by another writer (an MCP server rewriting a large store), the POST succeeds and the merge-back waits. The outer timer then wins, and the hook returns and exits. The entry is still queued, with no `in_doubt` marker, so the next flush POSTs it again. The hook prints "Queued writes stay queued and retry next time", which is literally true, but the write was already delivered.

**Expected:** one server row. **Actual (ran, real `plur hook-codex-session-end` process):**
```
hook exited code=0 after 1775ms; stderr: [plur] hook-codex-session-end: outbox flush still running after 1700ms — not waiting for it. Queued writes stay queued and retry next time.
POSTs after hook: 2 | server rows: 1
local entry still queued: true in_doubt: undefined
next flush: {"flushed":1,...}
server rows now: [ 'ENG-SRV-001 Page the secondary …', 'ENG-SRV-002 Page the secondary …' ]
```
(The server honours no key here. With F1's key scheme, a server that does honour it would collapse this retry, because the flush key is the local id.)

### F3: the in-doubt probe accepts someone else's engram as ours (MEDIUM)

`findByStatement` matches on `statement` alone, across every author in the scope. Sequence: a push is cut by the hook budget, the server never stored it, and the entry is marked `in_doubt`. A teammate then saves the same sentence. The next flush finds the teammate's row, counts ours as delivered and removes the local engram.

**Actual (ran):**
```
2. budget-cut flush -> {"flushed":0,"failed":0,"deferred":1,...}   in_doubt: true | server rows: 0
4. next flush -> {"flushed":1,...}
   local rows left: 0 | server rows: [ { rationale: 'teammate: staging only', tags: [ 'theirs' ] } ]
```
Our rationale ("audit finding 7, applies to prod AND staging"), tags and type are gone everywhere. Later `supersedes` edges get re-pointed at the teammate's id through the outbox id map.

### F4: an in-doubt entry can be stuck for good (MEDIUM)

`findByStatement` returns `unknown` once it has read 50 pages of 200 rows. A scope with more than 10,000 rows therefore never gets past the probe, and `unknown` means "do not post". `force: true` does not bypass it. The entry sits `deferred`, is listed as `retrying`, and after 7 days only raises the generic TTL warning. A list endpoint that keeps failing (5xx, unexpected body shape) gives the same result.

**Actual (ran, 10,050 rows in scope):**
```
hook-style flush (cut): {"flushed":0,...,"deferred":1,...}
forced flush #1..#3: {"flushed":0,...,"deferred":1,...}
entry still queued: true | in_doubt: true
plur outbox shows: [{"state":"retrying","last_error":"cut at the flush time budget …"}]
```

### F5: the same automatic verdict is applied twice (LOW)

`autoRateTurn` applies the verdicts one at a time and writes the `.rated` list only after the loop. The hook's 9 s watchdog calls `process.exit(0)`. If it fires while a later verdict waits (here, on a secondary store's lock), the verdicts already applied are never recorded, and the next turn applies them again.

**Actual (ran, real `plur hook-auto-rate claude`):**
```
A before: {"feedback_signals":{"positive":0,...},"strength":0.7}
turn 1 hook: exit 0 after 9072ms
A after turn 1: {"positive":1,...,"strength":0.75} | rated file exists: false
A after turn 2: {"positive":2,...,"strength":0.8}
feedback_received events for A: 2
```
Also a design note: a verdict whose `feedback()` throws for a transient reason (for example a lock timeout) is marked done anyway, so that signal is dropped for the session. The code does this on purpose; it is not probed as a finding.

### F6: folders.yaml loses concurrent updates (LOW, the same race existed on main)

**Actual (ran):** on this branch, 5 rounds × 8 concurrent `trustDirectory` calls each kept 1 entry, so 35 grants were lost. On main against trust.yaml, 31 were lost. The race is the same; the file now carries more kinds of decision, and the ask flow adds a writer.

### F7: trust.yaml / folders.yaml split after the import (LOW)

**Actual (ran, main's `trustDirectory`/`isDirectoryTrusted` as the "older reader"):**
```
new untrust X -> true
  new says X trusted: false | old (same home) says X trusted: true
  trust.yaml still lists: … r7-repoX-…
old grants Y -> new says Y trusted: false | listTrusted(new): []
```

### F8: a save to a second shared scope is absorbed (LOW, the absorption is on main too)

**Actual (ran):**
```
this branch: save #1 -> scope=group:t/eng, warning names "group:t/eng" (the store the user did NOT write to)
             save #2 -> scope=global {"delivery":"local"}   (no warning)
             POSTs to the group:t/ops store: 0
main:        save #1 -> group:t/eng; save #2 -> global (team file entry broadened in place); POSTs: 0
```
The branch fixes the in-place broadening of the team file. The rule it states, "a team save is never absorbed into a personal or global engram", still does not hold for a shared→shared save, and `deliveryOf` gives no warning for the global copy.

## Checked and held

- **Config loader duplicate handling (#1319) and writeback.** An entry naming the primary file, or repeating an earlier file and scope under a symlinked spelling, is ignored at load. That entry, and an unknown key on it, survived `addStore`, `addRemoteStore`, token rotation and `persistScopeMetadata`. `addStore(<primary>)` is refused. Probe `c1-config-writeback.mjs`, ran.
- **Copy-on-promote (#1268).** A queued team write (outbox) recurring from three other scopes kept `group:t/eng`. One global copy was made (`derived_from` set) and then credited, with no second copy. The flush pushed only the team engram, with its team scope, and the global copy stayed local. Probe `c2-copy-on-promote.mjs`, ran. Minor: after the flush, the copy's `derived_from` names the removed local id, not the server id.
- **Team re-save duplicates.** Three fresh-process `learnRouted` calls of one team statement give 3 server rows on this branch **and on main** (cold remote cache, no dedup). This is not introduced here. The branch also POSTs when a personal copy exists; main absorbed that case. That is the intended #1268 change. Probe `c3-team-resave.mjs`, ran on both.
- **Budget cut mid-POST (in-process).** `RemoteAbortedError` records the attempt, sets `in_doubt` and does not feed the breaker. The probe runs before any re-post (seen in F3/F4 runs).
- **Needs-action back-off (#1299) and breaker (#1308).** A held entry is only skipped, never changed or dropped. `force` bypasses the hold. Refusals do not feed the breaker (read, and covered by the branch's tests; not separately probed).
- **folders.yaml malformed.** Writes are refused (`FolderMapError('malformed')`) instead of overwriting the file. This is an improvement over the old trust.yaml, where a parse failure read as empty and the next write overwrote it.
- **Session checkpoint keys (#1278/#1301/#1314).** Writer (`hook-learn-check`) and both readers use `safeSessionKey(...).slice(0,64)` first. Claude session ids are UUIDs, so the stripped fallback form never collides. Read, not probed.
- **hook-inject session marker.** It is written only after stdout confirms the write, so a failed injection leaves the session unmarked and the next prompt retries. Read, not probed.

## Probe scripts

Script per finding: F1 `r1-idempotency-key.mjs`, F2 `r4-hook-outer-timeout.mjs`, F3 `r3-in-doubt-probe.mjs`, F4 `r8-in-doubt-stuck.mjs`, F5 `r5-auto-rate-double.mjs`, F6 `r6-folders-race.mjs` (+ child), F7 `r7-trust-split.mjs`, F8 `r2-shared-absorb.mjs`.

All scripts live in one directory next to `server.mjs`. `node_modules` is symlinked to `packages/core/node_modules` of the worktree under test (for `js-yaml`). `CORE=` / `WT=` select the build. Run each with `node <script>`.

```js
// server.mjs
// Minimal remote store that follows docs/remote-store-contract.md as written:
// "for a key it has already accepted from the same token, return the original
// response (status and id) instead of creating a second engram."
import http from 'http'
export function startServer({ honourIdempotency = true, postDelayMs = 0, dropWhileDelayed = false, failFirst = 0 } = {}) {
  const rows = new Map(); const idem = new Map(); const log = []
  const ctl = { postDelayMs, dropWhileDelayed, failFirst }
  let n = 0
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const json = (s, o) => { if (res.writableEnded || res.destroyed) return; res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      const tok = req.headers.authorization ?? ''
      if (req.method === 'GET' && url.pathname === '/api/v1/me') return json(200, { username: 'u', org_id: 'o', role: 'developer', scopes: ['group:t/eng', 'group:t/ops'], capabilities: ['feedback.source'] })
      if (req.method === 'POST' && url.pathname === '/api/v1/engrams') {
        const b = JSON.parse(body || '{}'); const key = req.headers['idempotency-key']
        log.push({ key, statement: b.statement, scope: b.scope })
        if (ctl.failFirst > 0) { ctl.failFirst--; res.writeHead(503); return res.end('unavailable') }
        const postDelayMs = ctl.postDelayMs, dropWhileDelayed = ctl.dropWhileDelayed
        const k = `${tok}\0${key}`
        if (honourIdempotency && key && idem.has(k)) return json(201, idem.get(k))
        const id = `ENG-SRV-${String(++n).padStart(3, '0')}`
        const row = { id, scope: b.scope, status: 'active', data: { ...b, id } }
        const store = () => { rows.set(id, row); if (key) idem.set(k, { id, scope: b.scope, status: 'active', data: row.data }) }
        if (!(postDelayMs && dropWhileDelayed)) store()
        const respond = () => { if (postDelayMs && dropWhileDelayed && !res.destroyed) store(); json(201, { id, scope: b.scope, status: 'active', data: row.data }) }
        return postDelayMs ? setTimeout(respond, postDelayMs) : respond()
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/engrams') {
        const scope = url.searchParams.get('scope'); const all = [...rows.values()].filter(r => !scope || r.scope === scope)
        const off = +(url.searchParams.get('offset') ?? 0), lim = +(url.searchParams.get('limit') ?? 200)
        return json(200, { rows: all.slice(off, off + lim), total_count: all.length })
      }
      return json(200, { rows: [], results: [], total_count: 0 })
    })
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, rows, log, ctl, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close() } })))
}
```

```js
// r1-idempotency-key.mjs
// R1: learnRouted sends Idempotency-Key "__pending__" on every write.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(process.env.CORE ?? '../wt-dataloss/packages/core/dist/index.js')
const s = await startServer({ honourIdempotency: true })
const home = mkdtempSync(join(tmpdir(), 'r1-home-')); process.env.HOME = home
const dir = mkdtempSync(join(tmpdir(), 'r1-plur-'))
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: s.url, token: 'tok-1', scope: 'group:t/eng', shared: true }] }))
const plur = new Plur({ path: dir, autoDiscover: false })
const statements = ['Deploys to staging need a green canary first', 'The billing service retries webhooks three times', 'Use pnpm, never npm, in the monorepo']
for (const st of statements) {
  const e = await plur.learnRouted(st, { scope: 'group:t/eng', type: 'behavioral' })
  console.log('learnRouted ->', e.id, JSON.stringify(plur.deliveryOf(e)))
}
console.log('POST keys seen by server:', s.log.map(l => l.key))
console.log('server rows:', [...s.rows.values()].map(r => r.data.statement))
const local = existsSync(join(dir, 'engrams.yaml')) ? (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8'))?.engrams ?? []) : []
console.log('local rows:', local.map(e => e.statement), 'outbox:', local.filter(e => e.structured_data?._outbox).length)
s.close()
```

```js
// r4-hook-outer-timeout.mjs
// R4: the hook's outer timer abandons a flush whose POST already landed but
// whose local merge-back is waiting on the store lock; the process exits, the
// entry is not marked in_doubt, and the next flush POSTs it again.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'; import { tmpdir, hostname } from 'os'; import { spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const WT = process.env.WT ?? new URL('../wt-dataloss', import.meta.url).pathname
const { Plur } = await import(`${WT}/packages/core/dist/index.js`)
const s = await startServer({ honourIdempotency: false, failFirst: 1 })
const home = mkdtempSync(join(tmpdir(), 'r4-home-')); process.env.HOME = home
const dir = mkdtempSync(join(tmpdir(), 'r4-plur-'))
const proj = mkdtempSync(join(tmpdir(), 'r4-proj-')); writeFileSync(join(proj, '.plur.yaml'), 'domain: probe\n')
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: s.url, token: 'tok', scope: 'group:t/ops', shared: true }] }))
const plur = new Plur({ path: dir, autoDiscover: false })
const e = await plur.learnRouted('Page the secondary after 15 minutes without ack', { scope: 'group:t/ops', type: 'procedural' })
console.log('queued:', e.id, !!e.structured_data?._outbox, '| POSTs so far:', s.log.length)
// Another writer (an MCP server mid-write) holds the store lock for 6s.
const lock = join(dir, 'engrams.yaml.lock')
writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
setTimeout(() => rmSync(lock, { force: true }), 6000).unref()
// Run the real Codex SessionEnd hook (1.2s budget + 0.5s grace, then force-exit).
const r = await new Promise(res => {
  import('child_process').then(({ spawn }) => {
    const c = spawn(process.execPath, [`${WT}/packages/cli/dist/index.js`, 'hook-codex-session-end'], { cwd: proj, env: { ...process.env, PLUR_PATH: dir, HOME: home } })
    let err = ''; c.stderr.on('data', d => err += d); c.stdin.end('{"session_id":"s1"}')
    const t0 = Date.now(); c.on('exit', code => res({ code, ms: Date.now() - t0, err }))
  })
})
console.log(`hook exited code=${r.code} after ${r.ms}ms; stderr:`, r.err.trim().slice(0,600))
console.log('POSTs after hook:', s.log.length, '| server rows:', s.rows.size)
await new Promise(res => setTimeout(res, 6500))
const row = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams.find(x => x.id === e.id)
console.log('local entry still queued:', !!row?.structured_data?._outbox, 'in_doubt:', row?.structured_data?._outbox?.in_doubt)
const plur2 = new Plur({ path: dir, autoDiscover: false })
console.log('next flush:', JSON.stringify(await plur2.flushOutbox()))
console.log('server rows now:', [...s.rows.values()].map(x => `${x.id} ${x.data.statement}`))
s.close()
```

```js
// r3-in-doubt-probe.mjs
// R3: an in-doubt outbox entry is "delivered" by a teammate's engram that has
// the same statement; the local engram is deleted and its content never reaches the store.
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(process.env.CORE ?? '../wt-dataloss/packages/core/dist/index.js')
const s = await startServer({ honourIdempotency: false, failFirst: 1 })
process.env.HOME = mkdtempSync(join(tmpdir(), 'r3-home-'))
const dir = mkdtempSync(join(tmpdir(), 'r3-plur-'))
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: s.url, token: 'tok-me', scope: 'group:t/ops', shared: true }] }))
const plur = new Plur({ path: dir, autoDiscover: false })
const S = 'Rotate the on-call pager key every quarter'
const mine = await plur.learnRouted(S, { scope: 'group:t/ops', type: 'procedural', rationale: 'MY rationale: audit finding 7, applies to prod AND staging', tags: ['mine'] })
console.log('1. learnRouted (503) ->', mine.id, 'outbox:', !!mine.structured_data?._outbox)
// 2. a hook flush is cut mid-POST: the slow server drops the write when the client gives up.
s.ctl.postDelayMs = 1500; s.ctl.dropWhileDelayed = true
console.log('2. budget-cut flush ->', JSON.stringify(await plur.flushOutbox({ timeoutMs: 200 })))
await new Promise(r => setTimeout(r, 1700))
let row = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams.find(e => e.id === mine.id)
console.log('   in_doubt:', row.structured_data._outbox.in_doubt, '| server rows:', s.rows.size)
// 3. a teammate independently saves the same sentence (different rationale/tags).
s.ctl.postDelayMs = 0; s.ctl.dropWhileDelayed = false
await fetch(`${s.url}/api/v1/engrams`, { method: 'POST', headers: { authorization: 'Bearer tok-teammate', 'content-type': 'application/json' }, body: JSON.stringify({ statement: S, scope: 'group:t/ops', type: 'behavioral', rationale: 'teammate: staging only', tags: ['theirs'] }) })
// 4. next flush probes, finds the teammate's row, treats it as delivered.
console.log('4. next flush ->', JSON.stringify(await plur.flushOutbox()))
const local = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams
console.log('   local rows left:', local.length, '| server rows:', [...s.rows.values()].map(r => ({ rationale: r.data.rationale, tags: r.data.tags })))
s.close()
```

```js
// r8-in-doubt-stuck.mjs
// R8: an in-doubt entry in a scope with more than 10,000 server rows can never
// be delivered: the probe gives up at 50 pages ("unknown") on every flush,
// including an explicit forced flush.
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(new URL('../wt-dataloss/packages/core/dist/index.js', import.meta.url).pathname)
const s = await startServer({ honourIdempotency: false, failFirst: 1 })
for (let i = 0; i < 10_050; i++) s.rows.set(`ENG-OLD-${i}`, { id: `ENG-OLD-${i}`, scope: 'group:t/eng', status: 'active', data: { id: `ENG-OLD-${i}`, statement: `older team fact number ${i}`, type: 'behavioral', scope: 'group:t/eng' } })
process.env.HOME = mkdtempSync(join(tmpdir(), 'r8-home-'))
const dir = mkdtempSync(join(tmpdir(), 'r8-plur-'))
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: s.url, token: 't', scope: 'group:t/eng', shared: true }] }))
const plur = new Plur({ path: dir, autoDiscover: false })
const e = await plur.learnRouted('Incidents get a written review within five days', { scope: 'group:t/eng', type: 'behavioral' })
s.ctl.postDelayMs = 1000; s.ctl.dropWhileDelayed = true
console.log('hook-style flush (cut):', JSON.stringify(await plur.flushOutbox({ timeoutMs: 100 })))
await new Promise(r => setTimeout(r, 1200)); s.ctl.postDelayMs = 0; s.ctl.dropWhileDelayed = false
for (let i = 1; i <= 3; i++) console.log(`forced flush #${i}:`, JSON.stringify(await plur.flushOutbox({ force: true })))
const row = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams.find(x => x.id === e.id)
console.log('entry still queued:', !!row.structured_data._outbox, '| in_doubt:', row.structured_data._outbox.in_doubt, '| POSTs of it:', s.log.filter(l => l.statement.startsWith('Incidents')).length)
console.log('plur outbox shows:', JSON.stringify((await plur.listOutbox()).map(o => ({ state: o.state, last_error: o.last_error }))))
s.close()
```

```js
// r5-auto-rate-double.mjs
// R5: hook-auto-rate's watchdog (process.exit) fires after one verdict was
// applied but before the "rated" list is written; the next turn applies the
// same automatic verdict again.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'; import { tmpdir, hostname } from 'os'; import { spawn } from 'child_process'
import yaml from 'js-yaml'
const WT = new URL('../wt-dataloss', import.meta.url).pathname
const { Plur } = await import(`${WT}/packages/core/dist/index.js`)
const home = mkdtempSync(join(tmpdir(), 'r5-home-')); process.env.HOME = home
const dir = mkdtempSync(join(tmpdir(), 'r5-plur-'))
const proj = mkdtempSync(join(tmpdir(), 'r5-proj-')); writeFileSync(join(proj, '.plur.yaml'), 'domain: probe\n')
const teamDir = mkdtempSync(join(tmpdir(), 'r5-team-')); const teamFile = join(teamDir, 'engrams.yaml')
const A = 'Run the integration suite before tagging a release'
const B = 'Staging secrets live in the vault under the ops path'
await new Plur({ path: teamDir, autoDiscover: false }).learn(B, { scope: 'project:x', type: 'behavioral' })
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ path: teamFile, scope: 'project:x', shared: false }] }))
const plur = new Plur({ path: dir, autoDiscover: false })
const a = await plur.learn(A, { scope: 'global', type: 'behavioral' })
const b = (await plur.list()).find(e => e.statement === B)
console.log('A id', a.id, '| B id (as served)', b.id)
const session = `r5-${process.pid}`
const rateDir = join(tmpdir(), 'plur-auto-rate'); mkdirSync(rateDir, { recursive: true, mode: 0o700 })
writeFileSync(join(rateDir, `claude-${session}.injected`), `${a.id}\n${b.id}\n`, { mode: 0o600 })
const aState = () => { const e = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams.find(x => x.id === a.id); return JSON.stringify({ feedback_signals: e.feedback_signals, strength: e.activation?.retrieval_strength }) }
console.log('A before:', aState())
const reply = `Done. ${A}. Also: ${B}.`
const runHook = (env = {}) => new Promise(res => {
  const c = spawn(process.execPath, [`${WT}/packages/cli/dist/index.js`, 'hook-auto-rate', 'claude'], { cwd: proj, env: { ...process.env, PLUR_PATH: dir, HOME: home, ...env } })
  let err = ''; c.stderr.on('data', d => err += d)
  c.stdin.end(JSON.stringify({ session_id: session, last_assistant_message: reply, cwd: proj }))
  const t0 = Date.now(); c.on('exit', code => res({ code, ms: Date.now() - t0, err: err.trim() }))
})
// Turn 1: another writer holds the secondary store's lock, so B's feedback waits; the 9s watchdog fires.
const lock = `${teamFile}.lock`; writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
let r = await runHook()
rmSync(lock, { force: true })
console.log(`turn 1 hook: exit ${r.code} after ${r.ms}ms`, r.err ? `stderr: ${r.err}` : '')
console.log('A after turn 1:', aState(), '| rated file exists:', existsSync(join(rateDir, `claude-${session}.rated`)))
// Turn 2: same reply content quoted again (or any later reply quoting A).
r = await runHook()
console.log(`turn 2 hook: exit ${r.code} after ${r.ms}ms`)
console.log('A after turn 2:', aState())
const h = (await import('fs')).readdirSync(join(dir,'history')).map(f=>readFileSync(join(dir,'history',f),'utf8')).join(''); console.log('feedback_received events for A:', h.split('\n').filter(l => l.includes('feedback_received') && l.includes(a.id)).length)
```

```js
// r6-folders-race.mjs
// R6: folders.yaml is load-modify-write with no lock; concurrent `plur trust` /
// `plur folders set` runs lose each other's entries.
import { mkdtempSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import { spawn } from 'child_process'
import yaml from 'js-yaml'
const root = mkdtempSync(join(tmpdir(), 'r6-root-')); const base = mkdtempSync(join(tmpdir(), 'r6-dirs-'))
const N = 8; let lost = 0
for (let round = 0; round < 5; round++) {
  const r = join(root, `round${round}`); mkdirSync(r)
  const startAt = Date.now() + 1500
  await Promise.all(Array.from({ length: N }, (_, i) => {
    const d = join(base, `r${round}-repo${i}`); mkdirSync(d)
    return new Promise(res => spawn(process.execPath, ['r6-folders-race-child.mjs', r, d, String(startAt)], { stdio: 'inherit' }).on('exit', res))
  }))
  const kept = (yaml.load(readFileSync(join(r, 'folders.yaml'), 'utf8'))?.folders ?? []).length
  console.log(`round ${round}: ${N} concurrent trust grants -> ${kept} in folders.yaml`)
  lost += N - kept
}
console.log('grants lost in total:', lost)
```

```js
// r6-folders-race-child.mjs
const WT = new URL('../wt-dataloss', import.meta.url).pathname
const { trustDirectory } = await import(`${WT}/packages/core/dist/index.js`)
const [root, folder, startAt] = process.argv.slice(2)
while (Date.now() < +startAt) {} // line up the writers
trustDirectory(folder, root)
```

```js
// r7-trust-split.mjs
// R7: after the one-time import, trust.yaml and folders.yaml diverge. A revoke
// through the new code leaves the grant in trust.yaml (still honoured by an
// older reader on the same PLUR home); a grant written by an older writer is
// never seen by the new code.
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import { realpathSync } from 'fs'
const NEW = await import(new URL('../wt-dataloss/packages/core/dist/index.js', import.meta.url).pathname)
const OLD = await import(new URL('../wt-main/packages/core/dist/index.js', import.meta.url).pathname)
const root = mkdtempSync(join(tmpdir(), 'r7-root-'))
const X = realpathSync(mkdtempSync(join(tmpdir(), 'r7-repoX-'))), Y = realpathSync(mkdtempSync(join(tmpdir(), 'r7-repoY-')))
OLD.trustDirectory(X, root)                         // granted before upgrade
console.log('new reads X trusted (import):', NEW.isDirectoryTrusted(X, root))
console.log('new untrust X ->', NEW.untrustDirectory(X, root))
console.log('  new says X trusted:', NEW.isDirectoryTrusted(X, root), '| old (same home) says X trusted:', OLD.isDirectoryTrusted(X, root))
console.log('  trust.yaml still lists:', readFileSync(join(root, 'trust.yaml'), 'utf8').trim().replace(/\n/g, ' '))
OLD.trustDirectory(Y, root)                         // e.g. an older MCP server / CLI on the same home
console.log('old grants Y -> new says Y trusted:', NEW.isDirectoryTrusted(Y, root), '| listTrusted(new):', NEW.listTrustedDirectories(root))
```

```js
// r2-shared-absorb.mjs
// R2: a save to shared scope B (url store) whose text already lives in team
// scope A is absorbed; B's store never receives it.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(process.env.CORE ?? '../wt-dataloss/packages/core/dist/index.js')
const s = await startServer({ honourIdempotency: false })
process.env.HOME = mkdtempSync(join(tmpdir(), 'r2-home-'))
const dir = mkdtempSync(join(tmpdir(), 'r2-plur-'))
const teamFile = join(mkdtempSync(join(tmpdir(), 'r2-team-')), 'engrams.yaml')
const S = 'Every schema migration ships with a rollback script'
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [
  { path: teamFile, scope: 'group:t/eng', shared: true },
  { url: s.url, token: 'tok', scope: 'group:t/ops', shared: true },
] }))
// Seed team store A via a second instance pointed at that file.
const seedDir = teamFile.replace(/engrams\.yaml$/, '')
const seed = new Plur({ path: seedDir, autoDiscover: false })
await seed.learn(S, { scope: 'group:t/eng', type: 'behavioral' })
const plur = new Plur({ path: dir, autoDiscover: false })
for (const i of [1, 2]) {
  const e = await plur.learnRouted(S, { scope: 'group:t/ops', type: 'behavioral' })
  console.log(`save #${i} to group:t/ops -> id=${e.id} scope=${e.scope}`, JSON.stringify(plur.deliveryOf?.(e) ?? "n/a on this build"))
}
console.log('POSTs to the group:t/ops store:', s.log.length)
const local = existsSync(join(dir, 'engrams.yaml')) ? yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams : []
console.log('local primary:', local.map(e => `${e.id} ${e.scope}`))
console.log('team file A:', yaml.load(readFileSync(teamFile, 'utf8')).engrams.map(e => `${e.id} ${e.scope} rec=${e.recurrence_count}`))
s.close()
```

```js
// c1-config-writeback.mjs
// Check: ignored duplicate store entries survive every config writeback.
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(new URL('../wt-dataloss/packages/core/dist/index.js', import.meta.url).pathname)
const s = await startServer()
process.env.HOME = mkdtempSync(join(tmpdir(), 'c1-home-'))
const dir = mkdtempSync(join(tmpdir(), 'c1-plur-')); const aDir = mkdtempSync(join(tmpdir(), 'c1-a-'))
const link = aDir + '-link'; symlinkSync(aDir, link)
writeFileSync(join(aDir, 'engrams.yaml'), 'engrams: []\n')
const raw0 = { index: false, auto_learn: true, stores: [
  { path: join(dir, 'engrams.yaml'), scope: 'project:home', shared: true, custom_key: 'keep-me' },
  { path: join(aDir, 'engrams.yaml'), scope: 'project:a' },
  { path: join(link, 'engrams.yaml'), scope: 'project:a', custom_key: 'dup-spelling' },
] }
writeFileSync(join(dir, 'config.yaml'), yaml.dump(raw0))
const plur = new Plur({ path: dir, autoDiscover: false })
console.log('ignored at load:', plur.ignoredDuplicateStores().map(e => e.scope + ' ' + e.path))
const show = tag => console.log(tag, (yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')).stores ?? []).map(e => `${e.scope}${e.url ? ' url' : ''}${e.custom_key ? ' [' + e.custom_key + ']' : ''}`))
plur.addStore(join(mkdtempSync(join(tmpdir(), 'c1-b-')), 'engrams.yaml'), 'project:b'); show('after addStore:')
await plur.addRemoteStore({ url: s.url, token: 't1', scope: 'group:t/eng' }); show('after addRemoteStore:')
await plur.addRemoteStore({ url: s.url, token: 't2', scope: 'group:t/eng' }); show('after token rotation:')
plur.persistScopeMetadata([{ url: s.url, scope: 'group:t/eng', metadata: { covers: ['plur.eng'] } }]); show('after persistScopeMetadata:')
try { plur.addStore(join(dir, 'engrams.yaml'), 'project:again') } catch (e) { console.log('addStore(primary) refused:', e.message.slice(0, 80)) }
show('final:')
s.close()
```

```js
// c2-copy-on-promote.mjs
// Check: a queued team write that recurs from other scopes keeps its scope,
// the global copy is never pushed, and nothing is duplicated.
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(new URL('../wt-dataloss/packages/core/dist/index.js', import.meta.url).pathname)
const s = await startServer({ honourIdempotency: false, failFirst: 1 })
process.env.HOME = mkdtempSync(join(tmpdir(), 'c2-home-'))
const dir = mkdtempSync(join(tmpdir(), 'c2-plur-'))
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: s.url, token: 't', scope: 'group:t/eng', shared: true }] }))
const plur = new Plur({ path: dir, autoDiscover: false })
const S = 'Feature flags are removed within two sprints of full rollout'
const e = await plur.learnRouted(S, { scope: 'group:t/eng', type: 'behavioral' })
for (const sc of ['project:z', 'project:y', 'project:w']) { const r = await plur.learn(S, { scope: sc, type: 'behavioral' }); console.log(`learn(${sc}) ->`, r.id, r.scope) }
const rows = () => yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).engrams.map(x => `${x.id} ${x.scope} rec=${x.recurrence_count ?? 0} outbox=${!!x.structured_data?._outbox} derived_from=${x.derived_from ?? '-'}`)
console.log('local before flush:', rows())
console.log('flush:', JSON.stringify(await plur.flushOutbox()))
console.log('server:', [...s.rows.values()].map(r => `${r.id} ${r.scope}`), '| local after:', rows())
s.close()
```

```js
// c3-team-resave.mjs
// Check: re-saving the same team statement from fresh processes.
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'; import yaml from 'js-yaml'
import { startServer } from './server.mjs'
const { Plur } = await import(process.env.CORE ?? new URL('../wt-dataloss/packages/core/dist/index.js', import.meta.url).pathname)
const s = await startServer({ honourIdempotency: false })
process.env.HOME = mkdtempSync(join(tmpdir(), 'c3-home-'))
const dir = mkdtempSync(join(tmpdir(), 'c3-plur-'))
writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: s.url, token: 't', scope: 'group:t/eng', shared: true }] }))
const S = 'Database backups are verified by a weekly restore drill'
if (process.env.WITH_LOCAL) await new Plur({ path: dir, autoDiscover: false }).learn(S, { type: 'behavioral' })
for (let i = 0; i < 3; i++) await new Plur({ path: dir, autoDiscover: false }).learnRouted(S, { scope: 'group:t/eng', type: 'behavioral' })
console.log(`${process.env.WITH_LOCAL ? 'with' : 'without'} a personal copy: 3 fresh-process team saves -> ${s.rows.size} server rows`)
s.close()
```
