# Post-merge audit — `03f441b..82e50d2`

**Scope:** 27 PRs merged 2026-08-13, 82 files, +6150/−233.
**Method:** three independent passes, run in parallel and blind to each other —
a data-loss audit of the write paths (precedent:
`2026-08-02-store-write-path-data-loss.md`), an adversarial pass on the diff
(precedent: `2026-08-03-fix-diff-adversarial.md`), and an evaluator panel
(critic / dijkstra / popper / taleb).

Every finding below was **reproduced before being fixed**, and every fix carries
a test that **fails when the fix is reverted**. Where a first draft of a test
passed with its fix reverted, that is recorded in the test file rather than
quietly corrected — three tests in this batch needed a second attempt.

## Why so much was found

The day's stated through-line was that most defects *report success while doing
the wrong thing*. The diagnosis was right; the execution reproduced the same
class **inside three of the fixes**:

| Fix | How it reported success while doing the wrong thing |
|---|---|
| #897 `reindex-hashes` | printed "every content_hash matches its statement" on a store silently collapsing all non-Latin memory into one row, and destroyed concurrent writes while doing it |
| #855 `forget` scope guard | accepted `scope: "local"` — meaning "the local one" — and issued a remote DELETE, reporting success |
| #863 supersedes flush | printed "flush again once X has been pushed" for an X that had already been pushed and could never be pushed again |

Twenty-seven PRs in a day is more than they can review each other.

## Findings and dispositions

Severity is blast radius, not effort.

### 1. Non-Latin statements collapse into a single engram — CRITICAL, shipped

`normalizeStatement` used ASCII `\w`, so `[^\w\s]` stripped every letter outside
unaccented Latin. Measured on the shipped build:

```
'データベースの設定を確認'  → ''  → e3b0c442…   (SHA-256 of the empty string)
'도커를 사용해야 한다'       → ''  → e3b0c442…
'развертывание должно'    → ''  → e3b0c442…
```

Every non-Latin statement carried the **same** `content_hash`, so
`findActiveByContentHash` matched them to each other and dedup absorbed them.
End to end: four unrelated facts written, one engram stored, `write_count: 4`,
four reported successes. For a product whose job is memory, this is the worst
failure available.

**Fixed** — `\p{L}\p{N}\p{M}_` (`\p{M}` is load-bearing: Devanagari and Thai
vowel signs are nonspacing marks). Plus `isHashable()`, wired into all three
dedup entry points, so a statement with no hashable content can never match
another. Filed as #896 the same day; the repair command shipped ten minutes
later without it.

*Migration:* ASCII statements hash identically, so most stored hashes do not
move. A statement in any other script now hashes differently — which makes its
stored hash stale, which is what `plur reindex-hashes` repairs. Run it after
upgrading.

### 2. `reindex-hashes --apply` destroyed concurrent writes — CRITICAL, shipped

Unlocked whole-corpus read-modify-write: load without a lock, hash, save the
pre-load snapshot back. Reproduced **6/6** on a 4,642-engram store — a correctly
locked writer appends between the two and its engram is gone. Three protections
every other whole-corpus writer has were all absent: no lock, no daily backup
(`_maybeDailyBackup` fires from *inside* `_withStoreLock`), and the shrink guard
cannot see it because the same count goes out that came in. Zero tests on the
destructive path.

**Fixed** — the scan and write moved into `Plur.repairContentHashes()`, behind
`_withStoreLock` and the `_loadTargeted`/`_updateEngrams` capability pair. This
also fixes a false all-clear: reading `paths.engrams` directly reported "0
engrams, all clean" for an injected non-YAML primary store. `--apply` now also
**refuses** to write a hash for a statement that normalizes to nothing, and
reports those separately — the previous version would have stamped the shared
empty-string hash onto the 961 rows it had just called inert.

### 3. A local scope routed to a remote DELETE — CRITICAL, shipped

`forget()` validated `primary | local | global | project:*` as targets and then
guarded only `targetScope === 'primary'` before the remote walk:

```
scope="global"      threw=null  remote DELETEs=1   ← wrong-target retire, reported success
scope="local"       threw=null  remote DELETEs=1
scope="project:foo" threw=null  remote DELETEs=1
scope="primary"     threw        remote DELETEs=0  (control)
```

Three of the four targets its own error message advertises destroyed a remote
engram when the caller had said "the local one". `feedback()` had no such guard
at all. This is #831 verbatim, reached from the direction #855 documented itself
as closing — and #855 explicitly asked for a shared helper that was never built.
**The drift was the bug.**

**Fixed** — `src/scope-target.ts` owns the predicate and the validation; both
call sites use it and neither can drift again.

### 4. Unbounded network call inside the store lock — HIGH

`RemoteStore.existsById` used a bare `fetch` with no `AbortSignal`, and both
callers run it *inside* the primary store lock, one probe per remote. undici's
default `headersTimeout` is 300s; `DEFAULT_ACQUIRE_TIMEOUT` is 180s. A host that
completes its handshake and stalls therefore makes every waiting `plur_learn`
throw "Failed to acquire lock" — the engram silently never stored.

**Fixed** — bounded with the same `LOAD_FETCH_TIMEOUT_MS` budget `load()` uses,
and an abort surfaces as "cannot tell" rather than "absent", which is the whole
point of the method.

### 5. Supersedes flush order was not a sort — HIGH

`pending.sort((a, b) => aDependsOnB - bDependsOnA)` returns non-zero only for
directly related pairs, so it is not a strict weak ordering. All four of #863's
fixtures used exactly two pending engrams — the one size at which a comparator
and a topological sort cannot disagree. With three, the flush pushed a
correction before its own target, then failed **identically on every subsequent
flush**, printing a remediation that could not be followed: the target *had*
been pushed, its local row spliced out, and `localToServer` was per-flush.

**Fixed** — `src/outbox-order.ts` (Kahn's algorithm, stable, cycles appended
rather than dropped so they are refused out loud), plus a bounded persisted
local→server id map so an edge whose target left in an earlier flush still
resolves.

### 6. `inject()` became a whole-corpus writer — MEDIUM

The #866 `injection_count` block loaded and rewrote the entire corpus, under the
global lock, on a path that runs at **every session start**:

| corpus | with | without | overhead |
|---|---|---|---|
| 200 | 48 ms | 11 ms | 4.4× |
| 2,000 | 442 ms | 42 ms | 10.5× |
| 10,000 | **2,804 ms** | 142 ms | **19.7×** |

Its `catch {}` also swallowed `EngramStoreShrinkError` and
`EngramStoreUnreadableError` — the #795/#800 integrity guards, muted on the most
frequently run write path.

**Fixed** — targeted update via the capability pair; integrity errors warn
instead of vanishing.

### 7. Outbox merge-back reverted concurrent changes — MEDIUM

`merged = fresh.map(e => survivorsById.get(e.id) ?? e)` replaced the fresh row
with a snapshot taken *before* the network round-trips, so any concurrent change
to a queued engram — feedback counter, activation bump, pin, rescope — was
reverted. Pre-existing; #785's cooldown narrows the window without closing it.

**Fixed** — field merge (`_outbox`, `_demoted`, and `scope`/`visibility` for the
ids this flush actually demoted) onto the fresh row.

### 8. Circuit breaker wrote to two different files — MEDIUM

The recall leg passes `remoteHealthStatePath()` (from `paths.root`); the write
leg took the default (from `PLUR_PATH`). Different files for `new Plur({ path
})`, `plur --path`, and every embedded consumer — so #785's "one host, one
opinion" held only by coincidence of a fixture that set both to the same
directory.

**Fixed**, with a test that sets them differently.

### 9. Tokenizer split Japanese loanwords — MEDIUM

`SPACELESS_RUN` used `\p{Script=…}`. U+30FC ー, the prolonged sound mark in
essentially every Japanese loanword, is `Script=Common`, so it terminated the
run: `コンピューター` → `["ーター","コン","ンピ","ピュ"]`, and a query for
`ベース` did not match a document containing it. #833's before/after table
happened to use a word with no prolonged mark.

**Fixed** — `Script_Extensions`, which also covers the Han iteration mark 々.
`TOKENIZER_VERSION` 3 → 4, and the version history now records entry 3, which
#833 bumped without documenting.

### 10. `searchBM25Exhaustive` missing from the readonly whitelist — MEDIUM

#753 added it to the query-adapter surface hours after #830's whitelist landed.
`ReadonlyStoreGuard` dropped it, so a read-only Postgres store kept widening 3L
→ 9L → 27L and re-ranked the same rows twice more. The file's own argument for
the whitelist shape — "a missed entry loses functionality **and someone
notices**" — was falsified in the same batch, because a silent 2–3× cost
regression is not a crash.

**Fixed**, and the header claim corrected. The test now enumerates the surface
so the next member fails on the day it lands.

### 11. Quarantine re-read documented but not implemented — LOW

`saveEngrams` re-attaches quarantine from the module map populated by the last
`loadEngrams` *in this process*; the comment claimed it re-reads the file.
Every in-tree writer satisfies the implied precondition, so this was a
documentation defect, not a live one — but the invariant was a comment rather
than code.

**Fixed** — restated as the precondition it actually is.

## Verified sound

Attacked and did not break: `reindex-hashes` quarantine round-trip (byte
identical); `normalizeEngramInput` never applied to quarantined entries; the
#866 `reference_count` → `write_count` rename cannot newly quarantine a row;
PGLite and Postgres `parseRow` cannot drop a row; `RemoteStore.reshape` cannot
newly return null; `rescope` outbox cancellation loses no other structured-data
keys; no `flushOutbox` `continue` drops an engram or its `_outbox`; `forget`'s
already-retired short-circuit skips no write that should have happened; the
historical unreadable-as-empty and undeclared-empty-corpus failure modes are not
reintroduced.

**Revert-checks spot-checked independently:** six of six honest, including the
exact claimed failure counts (#883, #884, #886, #888, #891, #879).

## Left open

- **#816 — id reuse.** Ids derive from the store's high-water mark, which is not
  persisted, so an outbox flush that empties the local store lets the next
  engram be minted the id a flushed one had. Surfaced while writing the
  cross-flush supersedes test, which has to hold the sequence up by hand.
- **`plur_learn`'s hardcoded `decision: 'ADD'`.** #894 deferred it as a
  "response-shape change"; #895 changed that exact response shape 40 minutes
  later. Tracked in #878.
- **`reactivate()` is `x = x`** at its only production call site. Dead code
  after #888, and the ranking blast radius of freezing `retrieval_strength` for
  unrated engrams is not yet characterised.
- **ADR-0006 is still `Proposed`.** It correctly names the class this audit kept
  finding; the same day's merges violated two of its three clauses, which is an
  argument for ratifying it.
