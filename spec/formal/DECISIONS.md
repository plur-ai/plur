# Owner decisions — formal verification run 2026-09-23

Collected from the modelling agents' NEEDS-OWNER questions. Each will become one row on the decision board.
Nothing here is applied until the owner decides.

## WritePath (findings/writepath.md)

- **WP-Q1 — remote copy left behind when forget/rescope lands mid-push.** Now: kept locally, reported with server id; remote copy remains.
  (a) report only [current] · (b) auto `driver.remove(serverId)` (learn() must keep the server id) · (c) queue a "retire on remote" outbox entry.
- **WP-Q1b — two processes flushing the same store** can both push (fix is single-process).
  (a) accept · (b) on-disk lease on outbox rows (persisted-format change).
- **WP-Q2 — cross-scope recurrence on a row still queued for a team store.**
  (a) hold back with warning [current] · (b) never widen a queued row to global · (c) widen and cancel team delivery · (d) widen locally, deliver to team under original scope.
- **WP-Q3 — updateEngram changing the scope of a queued row.**
  (a) hold back at flush with warning [current] · (b) behave like rescope (cancel for local-family, retarget for writable url store) · (c) reject scope changes in updateEngram, point to rescope.
- **WP-Q4 — auto-route into a remote-backed personal scope** (user:*/agent:* with url; covers may come from the server). #1115 refuses only shared.
  (a) keep [current] · (b) refuse unless new opt-in `allow_remote_auto_route` · (c) route but ask for confirmation.
- **WP-Q5 — what the default `private` visibility means for a team-scope write.** Store write path pushes it; git sync excludes it; MCP schema says private never leaves the machine.
  (a) only explicit private stays local [current] · (b) honour the default too (team writes need `public`) · (c) default `public` for remote-backed/shared scopes · (d) reword the MCP description.
  Sub-question: should an explicitly private group:* engram kept locally be rewritten to scope `local`?

## ScopeInject (findings/scopeinject.md)

- **SI-Q3a — `isLocalOnlyScope('project:*')`.** (A) keep · (B) drop `project:` from the local family · (C) config-driven: local only if no url store's scope contains it.
- **SI-Q3b — scope case drift.** (A) case-fold the local family · (B) lower-case scopes at the API boundary · (C) keep (fails closed).
- **SI-Q3c — auto-route into url-backed personal scopes. SAME QUESTION AS WP-Q4 — one board row.** Extra option from this agent: allow only the user's own `/me` namespace.
- **SI-Q3d — provenance `withheld` checks only `scope === 'local'`** (provenance.ts). (A) isLocalOnly ∧ ¬remote-backed · (B) "does not leave the machine" predicate · (C) keep.
- **SI-Q5b — `injection_budget` total (replayed 823 used vs 500 budget).** (A) budget covers consider + spread · (B) document as directives+constraints budget, report only that part · (C) cap the sum by shrinking consider/spread.
- **SI-Q6 — renderMemoryBlock over budget (replayed 5469 vs 499); must stay identical to claw.** (A) drop sections that don't fit · (B) cut per entry · (C) keep, fix docstring.
- **SI-Q7a — miss floor 0.015 makes `low_score` unreachable.** (A) keep (effectively off) · (B) move between 1/61 and 2/61 · (C) drop `low_score`.
- **SI-Q7b — PGLite null topScore classified no_results (pinned by telemetry-miss-signal.test.ts:60).** (A) return an RRF score from `_pgliteHybridRecall` (index.ts) · (B) null-with-results = "no signal" (changes pinned test) · (C) keep.
- **SI-Q7c — miss-signal `domain` sent verbatim.** (A) keep · (B) first segment only · (C) omit.
- **SI-Q8a — sub-floor decay rise (strength 0 climbs to 0.05).** (A) decay only from above floor · (B) feedback floor 0.05 · (C) keep.
- **SI-Q8b — `shouldInject` (exported, unused, family-prefix match contra #383).** (A) delete · (B) rebuild on `isScopeWithin` · (C) deprecate.

## Adapters (findings/adapters.md)

- **AD-Q1 — unscoped writes with several MCP sessions open and no session_id** (replayed: write takes last-started session's scope).
  (A) keep · (B) refuse (hookless clients break up to 8h after a missed session_end) · (C) ignore all session defaults (needs a core "no session" sentinel).
- **AD-Q2 — `scopes register --json` exits 0 on refusal.** (A) exit 1 like text mode (change scopes.test.ts:45) · (B) keep, failure only in body.
- **AD-Q3 — dsh write exceeding its timeout.** (A) keep serialising (one hung write wedges the queue) · (B) release slot on timeout [current; overlap bounded by core store lock] · (C) wait up to a larger hard cap, then release.
- **AD-Q4 — bare string for `engram_suggestions`** (replayed: "Use pnpm, not npm" → two engrams incl. "not npm"; pinned by server.test.ts:196).
  (A) comma-split [current] · (B) one suggestion `[string]` · (C) refuse with the #297 hint.
- **AD-Q5 — `.plur.yaml` scope from an untrusted directory** (replayed: MCP adopted a cloned repo's `scope: group:acme/eng` as session default).
  (A) all adapters follow opencode: ignore + warn · (B) may narrow reads, never set a shared/remote write default · (C) keep the split (three adopt, opencode doesn't).

### NEEDS-FILE (fixes blocked only on file ownership; exact changes in findings/adapters.md)
- `packages/cli/src/commands/doctor.ts:217` — normalise backslashes in `hasAnyPlurHook` (Windows false red).
- `packages/cli/src/commands/learn.ts` + `packages/cli/src/plur.ts` — honour `--` (today `learn -- "<x>"` stores "--"); stop parsing global flags after it (`--path=…` inside a statement creates a store there).
- `packages/python/plur_ai/bridge.py` — `run_json` gains an `input` parameter so `client.py` can send flag-like statements on stdin.

## Persistence (findings/persistence.md)

- **PE-Q4 — cross-host lock: a live holder on another host is stolen after 60 s; sync legitimately holds ~90 s.**
  (a) holder re-touches its lock every staleThreshold/3 (local, no format change) · (b) raise DEFAULT_STALE_THRESHOLD above the longest honest hold (e.g. 150 s) · (c) declare cross-host shared `~/.plur` unsupported and document.
- **PE-Q7 — backups stop forever after one legitimate >10% removal** (replayed: days 2–40 refused as "shrunk").
  (a) write path records the count PLUR last wrote; gate compares to that (needs engrams.ts) · (b) re-baseline after N stable days · (c) explicit `plur backup --accept-shrink` · (d) re-baseline when forget/retire history explains the drop.
- **PE-Q10 — pack integrity hash not injective** (bytes across the SKILL.md/engrams.yaml boundary collide; missing = empty). Defined by ENGRAM-STANDARD-v1 §5.5.
  (a) versioned `sha256:v2:` over length-prefixed named parts, accept both on verify · (b) keep, correct the "content-addressable identifier" docstring and the standard · (c) (a) + re-baseline installed packs.
- **PE-Q11 — what identifies a pack in the registry** (replayed: an untouched pack reads `modified`; uninstalling one leaves another `unverified`).
  (a) directory name via additive `dir` field, legacy fallback to `name` · (b) manifest name, refuse a second install under the same name · (c) key by directory, warn on duplicate manifest name.
- **PE-Q6 (low) — unrecoverable list counts only `engram_created` events?** Requires changing the invented `engram_learned` event name in read-only backup.test.ts. (a) yes · (b) keep the narrowed id-shape filter as fixed.

Residuals noted by the agent (not questions): removing an abandoned steal guard is itself unguarded (double fault reopens the race); sync restore keeps both records when a withheld id also arrives from the remote; a setSchemaVersion failure after a successful save leaves the old version stamped (not modelled). Postgres suites (123 tests) need PG_URL and were skipped.

## Resolution (2026-09-26)

The owner answered four principles instead of 27 rows (the board was too granular to answer without guessing). Row-by-row mapping: `decisions.resolved.yaml`. Not yet applied.
