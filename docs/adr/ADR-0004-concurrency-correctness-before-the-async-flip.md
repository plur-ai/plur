# ADR-0004: Concurrency correctness before the async flip

Status: **Accepted** — implemented in 0.16
Date: 2026-07-27
Authors: convergence programme, Phase 2
Related: ADR-0003 (primary store capability)

## Context

ADR-0003 moved the persistence seam (`PrimaryStore`) but deliberately left it
**synchronous**, deferring the flip to this phase with a specific warning:

> flipping ~20 methods to async turns every `await` into an interleaving point
> and invalidates the implicit atomicity the current code relies on
> (`_sessionScope`, `_activeSessionId`, `autoDiscoverStores()`, the process-wide
> LLM circuit breaker).

Phase 2 is therefore two jobs that look like one:

1. **The mechanical flip** — `withLock` → async, `loadEngrams`/`saveEngrams` →
   `fs.promises`, ~20 methods follow. Contagious but logic-preserving.
2. **Concurrency correctness** — making the class behave when several sessions
   are in flight at once.

The second is the real project. The first is what makes it urgent.

## Decision

**Land the concurrency correctness first, on its own, with the parts of the
async plumbing that can land behind it.** Defer the public sync→async API flip.

Two reasons, and the second is the one that decided it.

### The bugs are already live

They are not hypothetical consequences of a future refactor. `learnRouted()`,
`learnAsync()`, `feedback()`, `forget()`, `updateEngramAsync()`,
`setPinnedAsync()` and `injectHybrid()` are **already `async`** and already
await. Any consumer sharing one `Plur` across concurrent sessions — which the
ContextEngine plugin does today, and which a server deployment does by
definition — is already exposed. Shipping the fixes behind a large API break
would have delayed a live correctness fix behind a refactor.

### The flip cannot be done halfway, and this seam is where it splits cleanly

`PrimaryStore.load()` going async makes `_loadAllEngrams()` async, which makes
`_filterEngrams` async, which makes `recall()`, `inject()`, `list()`,
`getById()` and `status()` async. It is not a write-path change; it is the
whole public API. Measured on this branch: **~100 call sites in `packages/*/src`
and ~1000 in `packages/*/test` across 77 files**, plus a hard breaking change
for every published consumer of `@plur-ai/core`.

That is a coherent piece of work. It is not a piece that can be *partially*
landed, and mixing it with the concurrency fixes would have produced one change
where a reviewer cannot tell which line fixed which bug.

## What this ADR covers

### 1. Per-session write scope — `SessionScopeRegistry`

`Plur._sessionScope` was one field, set by `setSessionScope()`, read by
`_guardSensitiveScope()` on every unscoped write. Safe under exactly one
condition: one session per instance, no interleaving.

`learnRouted()` awaits a network round-trip between reading that field and
persisting the engram. So two concurrent sessions race, and the loser's engram
is written **into the winner's scope** — a write crossing a scope boundary,
which is the one outcome scoping exists to prevent. Silent, and directionally
worse for exactly the deployments that care: the more scopes an installation
has, the more places a leaked write can land.

Replaced with a registry:

- a session that registers a scope always gets its own;
- a session that has not inherits the process-wide slot;
- registering `null` for a session pins it to "no session scope" (auto-route),
  which is distinct from never registering.

Single-session callers are unchanged: `setSessionScope(scope)` with no key still
sets the process slot, and unkeyed writes still read it. `LearnContext.session`
threads the key. The shape follows `packages/claw/src/context-engine.ts`, which
already runs one shared `Plur` across concurrent sessions using per-session
state maps and explicit threading.

`clearSessionScope({ session })` exists because a long-lived deployment would
otherwise retain one map entry per session it has ever served.

### 2. LLM dedup circuit breaker — sliding window, not a resettable counter

The sequence is `isLlmAvailable()` → `await llm(prompt)` →
`record{Success,Failure}()`: a read-modify-write straddling an await.
`recordLlmSuccess()` set the failure count to **zero**. With more than one call
in flight, a success returning from one call erased the failures the others had
just recorded, so a breaker meant to trip after 3 failures never tripped at all
and every subsequent call kept paying for a doomed round-trip.

Now a window of failure timestamps (3 within 5 minutes trips it for an hour). A
success does not reset anything; failures age out. Nothing a concurrent call
does can erase a failure another call recorded, because nothing subtracts.

The threshold is unchanged. The window is what makes it concurrency-safe.

### 3. `withAsyncLock` — an in-process queue in front of the file lock

`O_EXCL` hands a losing caller `EEXIST` and nothing else, so the only recovery
is retry-with-backoff. That is the right shape for **cross-process** contention,
which is rare, and the wrong shape for **in-process** contention, which becomes
the normal case as soon as one instance serves concurrent sessions. Without a
queue, 25 concurrent writers put 24 of them through an exponential backoff and,
past the default 5 retries, make them throw `Failed to acquire lock`.

`withAsyncLock` now queues in-process (FIFO, keyed by resolved path, entries
evicted when idle) and only then contends for the lock file. `AsyncMutex` moved
from `storage-pglite.ts` to a leaf module so the locking layer can use it
without importing the PGLite adapter; `storage-pglite` re-exports it unchanged.

The already-`async` write paths in `index.ts` and `learn-async.ts` were switched
to it. This also fixed a latent self-deadlock in `learn-async.ts`: the
UPDATE/MERGE "target vanished" branch called `deps.learn()` **from inside** the
lock, and `Plur.learn()` takes the same lock on the same path — resolved only by
the inner acquire exhausting its retries and throwing. The fallback now runs
outside the critical section.

The synchronous `withLock()` in `sync.ts` remains for the still-synchronous
callers. Its backoff is a `Date.now()` spin that blocks the whole event loop —
see "What remains".

### 4. Constructor auto-discovery is opt-out

`new Plur()` walks up from `process.cwd()` looking for `.plur/engrams.yaml` and,
on a hit, **writes the discovered store into config.yaml**. For a CLI, whose cwd
is the user's intent, that is the feature. For an instance shared by concurrent
sessions it is not: the process cwd expresses nobody's intent, and the store
lands in the shared config where every session sees it. Constructing an object
should not silently reconfigure a deployment.

`new Plur({ autoDiscover: false })` opts out; `PLUR_AUTO_DISCOVER=0` does the
same for a consumer that does not own the construction call site. `cwd` is now
an explicit option rather than an implicit read of process state. The default is
unchanged.

### 5. MCP injection telemetry is attributed, not guessed

`plur_inject` / `plur_inject_hybrid` recorded pack counts against a module-level
`_activeSessionId`, assigned by session_start, justified in a comment by "MCP
sessions are sequential within a process". Concurrent sessions make that false:
the second session_start overwrites the variable, an inject belonging to the
first session is recorded against the second, and the first session's
end-of-session summary reports someone else's numbers.

Both tools now accept an explicit `session_id`. The implicit fallback is
*derived* rather than stored, and answers only when unambiguous — exactly one
open session. With none or several there is no right answer, and **recording
nothing is better than recording against the wrong session**: absent telemetry
is visibly absent, misattributed telemetry is invisibly wrong.

Accepted cost: a session that never calls `session_end` (crash, forced kill)
stays "open" until the 8-hour TTL evicts it, and suppresses implicit attribution
for that window. Deliberate — a leak should cost telemetry, not correctness —
and avoidable by passing `session_id`.

## Consequences

### Behaviour changes callers can observe

- **`feedback()` / `forget()` / `setPinnedAsync()` / `updateEngramAsync()` now
  genuinely need `await`.** They were always declared `Promise`-returning, but
  an `async` function runs synchronously up to its first `await` and, with the
  synchronous lock, there was none — so an un-awaited call took effect
  immediately. There is now a real await in the write path. No production call
  site in this repo relied on the accident; one test did, and now awaits.
- Implicit MCP injection attribution is conservative (above).
- Nothing changes for a single-session caller: unkeyed `setSessionScope`,
  default auto-discovery, single open session.

### What is enabling rather than fixing

The `withLock` → `withAsyncLock` conversion inside the already-async methods is
**behaviour-neutral today**, and the tests say so: 5 of the 7 write-path
concurrency tests pass on the parent commit too. They are regression guards for
the flip, not evidence of a fix. The two that do fail beforehand
(`feedback` / `setPinnedAsync` waiting out a lock held across an `await`) are
the part that changed: the sync lock spun for ~3.1s of blocked event loop and
then threw; the async lock queues.

Being precise about this matters more than the line count: the value of the
conversion is that it makes the store-level flip *possible*, not that it fixes
something users see today.

## What remains — the flip itself

Deferred, in dependency order:

| Remaining | Why it is still open |
|---|---|
| `PrimaryStore` → async (`load`/`loadCached`/`save`) | The seam. Everything below follows from it. |
| `loadEngrams`/`saveEngrams` → `fs.promises` | The synchronous root under the seam. |
| `learn`, `getById`, `list`, `recall`, `inject`, `status`, `compact`, `saveMetaEngrams`, `recordTensions`, `installPack`, `setPinned`, `listPinned`, plus `_loadCached` / `_loadAllEngrams` / `_writeEngrams` / `_filterEngrams` / `_formatInjection` / `_recordCrossScopeRecurrence` | Async is contagious: the store seam reaches all of them. ~100 src + ~1000 test call sites, 77 files. A hard breaking change for `@plur-ai/core` consumers. |
| The remaining 13 synchronous `withLock` sites | They are inside the methods above and cannot convert before those do. |
| Removing the `Date.now()` busy-wait in `sync.ts` | Only possible once no synchronous caller needs the lock. |

### The invariant that keeps the current mix safe

Until then, synchronous and asynchronous callers share the same lock file. That
is safe **only because no async lock body holds the lock across an `await`** —
every converted critical section is synchronous inside, so the lock is never
held while other code can run, and a sync caller can never meet a held lock.

Break that invariant and a synchronous `withLock` caller will spin on
`Date.now()` — blocking the event loop, therefore preventing the async holder
from ever finishing, therefore burning its full ~3.1s backoff and throwing. It
is demonstrated in `concurrency-write-path.test.ts`: `learnRouted`'s local route
still delegates to the synchronous `learn()` and still fails that scenario.

**Practical rule for anyone touching the write path before the flip lands: do
not `await` inside a `withAsyncLock` body on `paths.engrams`.** The flip removes
the constraint by removing the synchronous callers.

## Verification

- 2878 → 2918 tests, 0 failures, 44 skipped (`pnpm test` from the worktree
  root). PGLite serial project: 40 passed, 1 skipped.
- Every behaviour change has a test verified failing on the parent commit and
  passing here: 4 session-scope tests (`expected 'project:beta' to be
  'project:alpha'` — the bleed itself), 2 breaker tests, 3 lock-contention
  tests, 2 write-path lock tests, 5 auto-discovery tests, 3 MCP attribution
  tests (`expected 2 to be 1` — session B charged with session A's injection).
- The concurrency tests interleave rather than awaiting in sequence. A
  sequential test passes either way here and proves nothing.
