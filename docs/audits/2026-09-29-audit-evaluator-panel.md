# Evaluator panel audit — field-report integration branch (2026-09-29)

Blind pass 3 of 3. Four lenses (critic, dijkstra, popper, taleb), after the
precedent in `docs/audits/2026-08-13-post-merge-audit.md`.

- **Target:** `origin/integration/field-report-2026-09-29` @ `baf6df61`, diffed against `origin/main`.
- **Intent read against:** the field-report triage note, the decision brief of 2026-09-29, and the
  folder-map design note r3, all on `origin/docs/field-report-triage`.
- **Method:** a detached worktree, a full `pnpm build`, and every repro run with a temp `HOME`,
  `PLUR_PATH`, `XDG_CONFIG_HOME` and `TMPDIR`. The real `~/.plur` was never touched.
- **Remote stores:** the in-repo `StubServer` (`packages/core/test/helpers/stub-server.ts`), run
  standalone, plus a small echo server for the token-leak probes.
- **Evidence rule:** a defect counts only if it was reproduced. Everything else is in
  "Not reproduced".
- **Blindness:** no fixes, no commits, and no other pass's audit file was read.

Severity scale: **high** leaves a field-report item unmet, or silently loses or corrupts the
signal the item was about. **Medium** is a reproduced wrong behaviour with a realistic trigger.
**Low** is cosmetic, needs a contrived trigger, or only affects docs.

---

## Unmet done conditions (end to end)

| Field-report item | Done condition (from intent docs) | Status on `baf6df61` | Evidence |
|---|---|---|---|
| 3 — unconfigured folders | A fresh install in a never-registered folder asks once | **Unmet** | C1: `hook-inject` in an unmapped folder prints nothing; no hook calls `resolveFolderPolicy` |
| 3 | On "yes", an engram reaches a configured url store | **Unmet** | C1/C2: `folders set --scope group:test` is recorded, then `plur learn` in that folder lands `scope: global, delivery: local`. `plur remote` (r3) does not exist |
| 3 | `off` is silent, `on` injects (hook tests, four editors) | **Unmet** | C1: `off` recorded and resolver says off, yet `hook-inject` injects; `on` recorded, yet it stays silent |
| 3 | Manual check on macOS and Windows | Not done | nothing in the branch; `CHANGELOG` says "No hook reads the map yet" |
| 4 — auto-rate | An injected engram gets a feedback outcome | **Met for local engrams, unmet for team (url-store) engrams** | C3 (local: positive, `source: auto`, commitment unchanged). H1 (team: 0 feedback requests) |
| 4 | At most one automatic verdict per engram per session | **Unmet on large stores** | M1: 3 verdicts for one engram in one session |
| 1 — delivery field | `local` + warning / `remote` / `outbox` | Met | P1 |
| 2 — `stores add --url` | Verifies `/me`, idempotent, token never printed | **Partly met** | Idempotent and verified (P2). Token printed in the `authorised` field (L1) |
| 8a — shared recurrence | A shared-scope learn is never absorbed into a personal engram | Met | P4: a global twin exists; the group save still reached the stub |
| 8c — correction detect | Registered, folded into `hook-inject` | Met, with false positives | P9 / L7 |
| 8d — outbox flush | Session-end hooks flush (bounded); `plur sync` flushes | Met on the YAML store, small scale | P6. Large scopes: M5. Postgres: not reproduced |
| 6 — opencode | `plur init` writes MCP + plugin when an opencode dir exists | Met on macOS | P8. The real opencode codeword check is not verified |
| 7 — Windows | Quoted hooks, one hook set, `node.exe` entry | Not verified | no Windows host (see Not reproduced) |
| Decision 5 — first prompt sync | Memory arrives on the first reply, later prompts are cheap | Met functionally; slow on large stores | M2: 14.1 s per session start on a 20k-engram store |

---

## CRITIC — does it meet each item end to end?

**C1 — High — The folder map is recorded but consulted by nothing (item 3).**
`resolveFolderPolicy` is exported from core (`packages/core/src/index.ts:10022`), but no hook
calls it.
- Every hook still gates on `isPlurConfigured()` (`packages/cli/src/commands/hook-inject.ts:446`,
  `hook-auto-rate.ts:95-96`, `hook-cursor-stop.ts:29`, and others).
- Nothing calls `issueFolderNonce` or `endFolderNonceSession`, so no ask flow exists and every
  `--nonce` is "unknown".
- The CLI's empty-state text says the opposite: "No folder decisions recorded. Unmapped folders ask
  once per session." (`packages/cli/src/commands/folders.ts:33`).

Repro (temp HOME, after `plur init --global`):
1. `hook-inject` with a `UserPromptSubmit` payload in `lab/e2e1/fresh`. Stdout is empty, and
   `resolveFolderPolicy` → `{mode:'ask'}`.
2. `plur folders set fresh --on`. The resolver now says `{mode:'on', source:'map'}`, and
   `hook-inject` is still empty (two sessions).
3. In a folder with `.plur.yaml`, run `plur folders set withyaml --off`. The resolver says
   `{mode:'off'}`, and `hook-inject` still returns
   `[PLUR Memory — session started, 2 engrams injected]`.

The CHANGELOG says so ("First half of #1347 … No hook reads the map yet"). The field-report item is
still open, and the CLI already accepts decisions it does not enforce.

**C2 — High — A map `scope` does not route writes.**
- Repro: `plur folders set fresh --scope group:test` (accepted: the stub store is configured), then
  `plur learn "Team rule: …"` in `fresh`.
- Result: `{"scope":"global","delivery":"local"}`.
- The same statement with `--scope group:test` gives `delivery: "remote"` and reaches the stub
  (`ENG-SRV-001`).
- "On yes, an engram reaches a configured url store" therefore holds only when the caller names the
  scope by hand.

**C3 — Met (local) — An automatic rating is written for a local engram.**
- Repro: `hook-inject` (session `s-rate-1`), then `hook-auto-rate claude`, with a reply that quotes
  the engram.
- `engrams.yaml`: the engram's feedback count went `positive: 1`, `retrieval_strength` rose
  0.70 → 0.75, and `commitment` stayed `leaning`.
- History gained `feedback_received` and `injection_outcome` events with `source: "auto"`.
- So decision 1 (A′: automatic feedback changes ranking, never commitment) holds for local
  engrams.

**H1 — High — Team (url-store) engrams injected by a hook are never rated, silently (item 4).**
`autoRateTurn` looks up injected ids with `plur.getByIds(pending)`
(`packages/cli/src/lib/auto-rate.ts:133`).
- `getByIds` falls back to `_loadAllEngrams()` (`packages/core/src/index.ts:4746-4755`).
- For url stores, that reads only the remote driver's in-memory cache (`_loadRemoteCached`,
  `index.ts:1544-1550`: "no background refresh").
- The Stop hook is a fresh process, so the cache is always empty.
- Every team id is then treated as "no longer exists anywhere" and written to the `.rated` file
  (`auto-rate.ts:161-165`). It is never rated, and nothing is printed.

Repro:
1. Stub advertising `capabilities: ["feedback.source"]`, seeded with a valid team engram, served
   through remote recall.
2. `hook-inject` in a `.plur.yaml scope: group:test` folder injects `[ENG-GTE-SRV-900] Release
   notes must list every breaking change…`. The id is recorded in `claude-s-rate-4.injected`.
3. `hook-auto-rate claude` with a reply that quotes the statement verbatim.

Result:
- Stub `feedbackBodies: []`, `meCalls: 0`.
- `claude-s-rate-4.rated` contains `ENG-GTE-SRV-900`.
- No local history event.

Control, the same process calling `plur.feedback('ENG-GTE-SRV-900','positive',undefined,{source:'auto'})`
directly: the stub receives `{"signal":"positive","source":"auto"}`. The feedback path works; the
lookup in front of it drops the id.

The core tests (`feedback-source-remote.test.ts`) call `feedback()` with a known id and never go
through inject → hook. So the CHANGELOG line "Remote stores get automatic feedback only if they say
they can handle it" is, in practice, "never from editor hooks". Team stores are the enterprise
case the field report came from.

---

## DIJKSTRA — invariants relied on but not enforced

| # | Invariant the code assumes | Where | Enforced? | Evidence |
|---|---|---|---|---|
| D1 | Every id an inject hook recorded can be resolved by `getByIds` in a later process | `auto-rate.ts:133,161-165` | No: url-store engrams resolve only from a warm in-process cache | H1 |
| D2 | "Feedback applied" and "id recorded as rated" happen together | `auto-rate.ts:150-165` (`.rated` appended after all verdicts) | No: an exit between them loses the record, and the engram is rated again next turn | M1 |
| D3 | The 9 s watchdog bounds the hook | `hook-auto-rate.ts:37,78-79` (`setTimeout(...process.exit)`) | No: synchronous YAML parse and save starve the timer | M1 (12.5–30.5 s) |
| D4 | The folder-map scope guard uses the same predicate as write routing | `folders.ts:462` vs learn routing (writable url store, exact scope) | No: the guard accepts any configured store scope | L2 |
| D5 | A trust revocation persists | `folders.ts:255-270` (missing `folders.yaml` → re-import `trust.yaml`) | No: `trust.yaml` is never updated, so a revoked grant comes back | M4 |
| D6 | `folders.yaml` read-modify-write is not concurrent | `folders.ts:469-483` (no store lock) | No | L3 (12 concurrent sets → 7 entries) |
| D7 | The in-doubt probe can always reach a definite answer | `remote-store.ts:831-846` (50-page cap), `index.ts:8489-8501` (`unknown` → defer) | No: above 10,000 rows it is `unknown` forever | M5 |
| D8 | No other writer pushes an outbox entry while a flush pushes it | `index.ts:3425-3431` (fire-and-forget immediate push in `learn()`) vs `flushOutbox` | No | M6 |
| D9 | Wall-clock time is monotonic between runs | `hook-outbox-flush.ts:69-75` (throttle mtime); `index.ts:8183-8185` (24 h hold from `last_attempt`); nonce TTL `folders.ts:597` | No | L4 (throttle); the others are reasoning only |
| D10 | The ask-flow nonce protects map writes from a repo | `folders.ts:470` (nonce checked only if present); `commands/folders.ts:69-81` | No: `--nonce` is optional, and the design accepts writes without it as the user's own | Design-level; see Not reproduced |

---

## POPPER — what would falsify each CHANGELOG claim, and did it?

| Claim (CHANGELOG entry) | Falsifying observation tried | Result |
|---|---|---|
| "Remote stores get automatic feedback only if they say they can handle it" (#1310) | A capable stub, an injected team engram quoted in the reply | **Falsified in practice**: 0 requests (H1) |
| "Each injected engram gets at most one automatic verdict per session" (#1310) | 20k-engram store, the same Stop repeated | **Falsified**: 3 `feedback_received` events for one id in one session (M1) |
| "the run is capped at 9s, below the 10s budget each editor gives it" (#1310) | Time `hook-auto-rate` on 20 MB YAML | **Falsified**: 12.46 s, 30.5 s, 22.4 s (M1) |
| One sentence must "correct something … and contain at least two of the engram's distinctive words" gives a negative (#1310) | An agreeing reply that starts "Actually," or "No, the tests passed" | **Falsified as a correction detector**: both negative, 0.65 (M3) |
| "The token is never printed … not in `--json`, and not in an error, including an error that echoes the server's reply" (#1265) | A server whose `/me` scope list and error bodies contain the token | **Falsified**: the full token is in the `authorised` array (L1). Plain echoes are redacted (held) |
| "A rejected token … leaves config.yaml as it was"; "a token the server rejects never overwrites a working one" (#1265) | Re-add the same url and scope with a wrong token | Held (config md5 unchanged, exit 1) |
| Running the same command twice exits 0 (#1265) | Twice; also with a trailing slash | Held |
| Every learn carries `delivery`; shared → local has a warning (#1264) | `group:nostore`, `project:foo`, readonly store, file-path store, 403 store | Held. The warning also fires on every `project:` learn (L6) |
| "A shared-scope save now always writes its team copy" (#1268) | Global twin first, then `--scope group:test` | Held (`delivery: remote`, on the stub) |
| "`set` refuses a shared scope that no store in config.yaml serves" (#1347) | A readonly url store; a non-shared file-path store | **Weakened**: both accepted, and learn then lands `local` (L2) |
| "The first read … imports the trust.yaml entries … trust.yaml is never rewritten, so a downgrade still works" (#1347) | `untrust`, then lose `folders.yaml` | **Falsified for revocations**: the grant reappears (M4) |
| "The secret guard now recognises … AWS temporary keys" (#1317) | Geographic uppercase prose; a URL-encoded token | **Over-matches and under-matches**: `ASIAPACIFICNORTHEAST1` blocks a learn; `access_token%3Dghp_…` is not flagged (M7) |
| "a 401/403/404/422 answer to an outbox push neither counts toward the breaker" (#1308) | 4 × 403 to `group:a`, then writes to `group:b` on the same host | Held (`group:b` remote twice, 4 `needs_action` in `plur status`) |
| "A push cut mid-flight is not delivered twice" (#1269) | Large scope; concurrent immediate push | **Falsified in two ways**: stuck forever above 10k rows (M5); duplicate in 5 of 10 runs via `learn()` (M6) |
| Cursor stop "retries at most once every five minutes" (#1269) | Throttle marker dated in the future | Suppressed until the clock passes it (L4) |
| opencode auto-detected; `OPENCODE_CONFIG_DIR` / XDG honoured (#1311) | `~/.config/opencode` only; XDG pointing elsewhere with a leftover `~/.config/opencode` | Held |
| "Later prompts do not re-run the injection" (#1278/#1313) | Same session id, second prompt | Held (no second injection) |
| Correction reminder only on correction-shaped prompts (#1312) | "No worries", "Nope, that's fine", "Actually, can you also add a README?" | First two held; the third fires (L7) |
| `plur-mcp init` rehydrate "`async: true`, `timeout: 90`, the same as `plur init`" (#1279); "`UserPromptSubmit` stays `async: true`" (#1274) | Read the installed hooks and `packages/mcp/src/index.ts:128` | **Falsified (doc)**: both are sync, 20 s, per #1313. The release notes contradict themselves (L5) |

---

## TALEB — fragility

**M1 — Medium — `hook-auto-rate` overruns its ceiling on a large store, leaves a dead-pid lock, and re-rates.**
Setup: a 20,000-engram, 20 MB `engrams.yaml`.
- Wall time: 12.46 s, then 30.5 s and 22.4 s on repeat runs. The hook is registered with a 10 s
  timeout, and its own ceiling is 9 s.
- The watchdog is a `setTimeout` (`hook-auto-rate.ts:78`) that synchronous parse and save starve.
- The run left `engrams.yaml.lock` owned by a dead pid (`mac:93050:…`). The next writer took it over.
- `.rated` was never written, so the same engram (`ENG-2025-01-01-009X8`) got
  `feedback_received … source: auto` 3 times in one session.
- A real Claude Code harness kills the hook at 10 s instead. Whether the feedback write lands
  before the kill then varies from run to run.

**M2 — Medium — On a large store every session starts with a ~14 s blocking wait, and it never improves.**
- `hook-inject` on the first prompt of each new session: 14.11 s, 14.10 s, 14.09 s, 14 s.
- stderr says `hybrid injection exceeded 8000ms — falling back to BM25`.
- No `.embeddings-cache.json` is ever written, because the hook exits before embedding finishes.
  With hooks alone the cost repeats every session.
- The decision brief assumed "~5 s on a large store" when it chose synchronous first-prompt
  delivery. The measured headroom is 14 s against the 15 s hook ceiling and the 20 s registered
  timeout, so a store about 10–20% larger crosses the ceiling. It then injects nothing after the
  wait (extrapolation, not verified).
- Not verified: whether a long-running MCP server would warm this cache.

**M5 — Medium — An in-doubt outbox entry is never delivered in a team scope above 10,000 rows.**
- `findByStatement` pages at most 50 × 200 rows (`remote-store.ts:831-846`), and `unknown` means
  "defer" (`index.ts:8495-8499`).
- Repro (in-process stub, 10,050 rows in `group:big`): queue by 503, then a cut push (3 s delay,
  500 ms budget), then three forced flushes.
- Each flush result: `deferred: 1`. The list requests added up to 50, 100 and 150.
- The engram was already on the server; the local entry stays queued forever.
- Control with 500 rows: delivered on the next flush.

**M6 — Medium — Duplicate delivery when a flush runs while `learn()`'s background push is in flight.**
- Repro (in-process stub): `Plur.learn(... group:big)` with the server at 503, the error cleared at
  once, then a cut flush and a normal flush.
- The server ended with **2 copies in 5 of 10 runs**. `learnRouted()`: 0 of 10.
- Mechanism: the fire-and-forget immediate push (`index.ts:3425-3431`) and the flush both POST.
  The in-doubt probe only covers the flush's own earlier cut.
- This diff makes concurrent flushes more common: session-end hooks, Cursor `stop` on every turn,
  and `plur sync`.
- The stub ignores `Idempotency-Key`. Whether the production server honours it is not verified.
  Whether this is pre-existing on main is not established.

**M4 — Medium — A trust revocation does not survive losing `folders.yaml`.**
- Repro: `trust.yaml` lists `repo` → `plur trust --list` shows it (imported) → `plur untrust repo`
  → list empty → `rm folders.yaml` → `plur trust --list` shows `repo` again, re-imported as
  `trusted: true`.
- A downgrade has the same effect: the old version reads the never-updated `trust.yaml`.
- This is a security revocation, and it quietly undoes itself.

**M7 — Medium — The new AWS temporary-key pattern blocks ordinary prose.**
- `plur learn "Deploy the Tokyo cluster to region ASIAPACIFICNORTHEAST1 first"` →
  `Secret detected … aws_access_key`, exit 1.
- The pattern `/(?:AKIA|ASIA)[0-9A-Z]{16}/` has no boundary (`secrets.ts:9`).
- The GitHub patterns use a leading `(?<![A-Za-z0-9])`, so a token after a URL-encoded `=`
  (`%3Dghp_…`) is missed.

**M3 — Medium — The auto-rate heuristic mis-labels common replies.**
`rateInjectedEngrams` against the engram "Always run pnpm build before running the claw tests":
- Agreeing replies score negative 0.65:
  - "Actually, let me also run the claw tests right after the pnpm build."
  - "No, the claw tests passed after the pnpm build, all green."
- A reply that quotes the engram in order to reject it scores positive 0.95.
- This is on by default and reaches team stores that opt in. The brief's own −0.10 / +0.05 asymmetry
  makes the false negatives costlier.

**L1 — Low — The token leaks through the `authorised` field.**
- A `/me` that returns `scopes: ["group:<token>"]` makes `plur stores add --url` exit 1 with
  `"authorised":["group:tok_SuperSecret_…"]` in both text and `--json` output
  (`packages/cli/src/commands/stores.ts:65`). The message text is redacted; the array is not.
- A server that echoes a base64 form or a prefix also passes through.
- The trigger needs a buggy or hostile server, but the claim is absolute.

**L2 — Low — The folder-map scope guard is weaker than write routing.**
- `setFolder` passes every configured store scope (`index.ts:10038`).
- A readonly url store's scope and a non-shared file-path store's scope are both accepted.
- `plur learn --scope` into either lands `delivery: local`.
- Latent until hooks read the map; then a folder's default scope could silently stay local, as
  the design meant to prevent.

**L3 — Low — Concurrent `plur folders set` loses updates.** Twelve parallel `set --on` calls on
twelve folders leave 7 entries. The same applies to `plur trust` and `untrust`.

**L4 — Low — Clock skew stalls the Cursor `stop` flush.**
- A throttle marker dated two days ahead: the flush was skipped.
- The same marker dated 10 minutes back: the flush ran (`0 delivered, 1 failed`).
- Session-end hooks are not throttled.

**L5 — Low — The CHANGELOG contradicts itself.**
- The #1274 entry says `UserPromptSubmit` "stays `async: true`".
- The #1279 entry says `plur-mcp init` uses "`async: true`, `timeout: 90`, the same as `plur init`".
- Code and installed hooks are synchronous with a 20 s timeout, per #1313 (`CHANGELOG.md:419`,
  `:428`; `packages/mcp/src/index.ts:128`).

**L6 — Low — The delivery warning is noisy and points at the old path.**
- Every `project:` learn warns "No one else will see it", although this repo's own guidance uses
  `project:<name>` for per-project details.
- The advice names `plur_stores_add` and hand-editing `config.yaml`, not the new
  `plur stores add --url` (`index.ts:3831`).

**L7 — Low — A correction-detection false positive.** "Actually, can you also add a README?"
gets the `CORRECTION SIGNAL DETECTED` reminder.

**L8 — Low (stub only) — Repeated identical team saves from separate processes create server
duplicates.**
- Three `plur learn … --scope group:test` runs gave `ENG-SRV-001` and `-002`, identical text.
- Within one process the second save is absorbed.
- The cause is the same cold remote cache as H1.
- Whether the production server dedupes this is not verified, and whether it happens on main is
  not verified.

---

## Not reproduced (concerns only)

- **Windows**: quoted hook commands, single hook set after two inits, `node.exe` MCP entry, the
  folder-map win32 path matching, and `canonicalize` case on NTFS. No Windows host was available.
- **Postgres-backed primary store**: `outboxMayHaveEntries` reads only `<root>/engrams.yaml`
  (`hook-outbox-flush.ts:94-102`), so hooks would never flush there. This is from reading the
  code only.
- **Real editors**: Claude Code, opencode, Codex, Cursor and Antigravity codeword or delivery
  checks, including whether the published opencode plugin 0.1.1 loads memories.
- **The ladder guard** (decision 4: never promote a team-bound engram to `global`) was not
  exercised.
- **The 24 h `needs_action` hold** counts from `last_attempt` (`index.ts:8183-8185`). A future
  timestamp would extend it, the same class as L4. Reasoning only.
- **Nonce design**: nothing issues nonces yet, and `--nonce` is optional. A repo that talks the
  agent into running `plur folders set . --trusted` needs no nonce. A mechanical run without a
  nonce succeeds; whether that counts as "the user's own action" is a design question.
- **`findByStatement` matches any row with the same statement**, for example a teammate's, and
  records the local in-doubt write as delivered. Its rationale, domain and provenance never
  arrive.
- **`globToRegex`** turns each `*` into `[^/]*`. A user-written pattern with many stars could
  backtrack heavily. It is only reachable from the user's own file.
- **Auto-rate bookkeeping** lives in `os.tmpdir()/plur-auto-rate`, keyed by editor and session id,
  not by PLUR home. Two stores seeing the same session id would share state.
- **Pre-existing, outside the diff**: on the 20k-engram store, `plur learn` printed
  `learnRouted timed out after 5s — remote store slow/unreachable` with no remote configured, yet
  the engram was written (`packages/cli/src/commands/learn.ts:218`, identical on main).

## Held up under test (for balance)

- The delivery field in all three states.
- The token replace guard and idempotency in `stores add --url`.
- Plain-text token redaction in error echoes.
- A shared save with a personal twin still reaching the team store.
- 403 not tripping the breaker, and `needs_action` reporting in `plur status` / `plur outbox`.
- opencode detection, including `OPENCODE_CONFIG_DIR` / XDG.
- One injection per session.
- The correction reminder on "No, from now on …".
- Local auto-rate with commitment left unchanged.
- The folder resolver itself: off wins over `.plur.yaml`, `ask` by default, glob and literal
  matching on the paths tried.

Repro artefacts (scripts and stub runner) live in the auditor's scratchpad `lab/` directory. None
touch `~/.plur`.
