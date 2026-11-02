# Findings: mcp-tools cluster (packages/mcp/src/tools.ts, server.ts)

Model: `spec/formal/PlurSpec/McpTools.lean` (imports `PlurSpec.Adapters`, reuses its
`sweep` / `Inv` for the pending-eviction set). Tests:
`packages/mcp/test/formal-mcp-tools-session.test.ts` (14),
`packages/mcp/test/formal-mcp-tools-serial.test.ts` (2).

## 1. Session resolution for unscoped writes (`_writeSession`, `_implicitSessionId`, `_knownSession`)

Modelled branch for branch: `chosenOf` (base, else explicit id, else the implicit
session after the TTL sweep), the no-context branch (`localSess`), the server
branch (`serverSession`, split-window refusal, start default held only for the
same workspace key and resolver answer, else the workspace's agreed scope or
no session), and core's `SessionScopeRegistry.get` (an unregistered key falls
back to the process slot).

- PROVED `write_never_process_slot`: whenever every open session has its own
  registration (plur_session_start always registers, possibly null), the default
  core reads for a write is the session's own or the workspace's, never the slot.
- PROVED `ambiguous_no_session_default`: no id and not exactly one unexpired
  session open -> no session's key is passed (no session, workspace scope or refusal).
- PROVED `implicit_unexpired`: the implicit session is never an expired one.
- PROVED `unknown_id_no_default`: through the server an id this process did not
  start, and without the server an id core holds no registration for, never
  supplies its default.
- Non-vacuity: `lone_session_default`, `named_session_default`,
  `start_default_holds_same_ws`, `start_default_dropped_other_ws`, `split_window_refused`.

### CONFIRMED+FIXED: unknown session id outside the server took the last-started session's scope

The no-FolderScopeContext branch returned `chosen ?? NO_SESSION` unchecked. Core
answers an unregistered key with the process slot, which plur_session_start sets
outside the server, so an arbitrary id ("never-started") wrote into the
last-started session's scope. This path is public (`@plur-ai/mcp/tools` exports
the handlers). Through the server the slot is never set, so it was not reachable there.

- Replay (before fix): `pnpm exec vitest run packages/mcp/test/formal-mcp-tools-session.test.ts`
  -> `× without the server, a session id never started or registered supplies no default`
  (`expected 'project:b'` — replay script printed scope `project:b`).
- Counterexample theorem: `orig_unknown_id_takes_slot`; fixed: `fixed_unknown_id_no_slot`.
- Fix (tools.ts `_writeSession`): `if (!ctx) return chosen !== undefined && _knownSession(chosen, plur, false) ? chosen : NO_SESSION`.
  A core-registered id still counts (test "without the server, a session registered in core still supplies its default").
- DECIDED (owner, option "nosession"), see Questions 1. Residual before the decision: `_resolveWriteSession` for plur_inject / plur_inject_hybrid
  passes an explicit unknown id to core unchecked; outside the server that reads the
  slot for injection scope. Same shape; left for the owner (see questions).

### CONFIRMED+FIXED: plur_episode_to_engram diverged from plur_learn

`engram.session` was unbacked. Resolution already went through `_writeSession`, but
(a) a split window threw instead of returning plur_learn's structured refusal and
(b) the schema did not advertise `session_id`, so with several sessions open an agent
had no documented way to name its session.

- Replay (before fix): two tests failed — `episode to engram with disagreeing roots
  returns the same refusal as plur_learn` (threw "This window has folders that save to
  different places") and `episode to engram advertises session_id like plur_learn`.
- Fix: catch `RootsDisagreeError` and return `err.refusal`; add `session_id` to the schema.
- Model: `episodeSession`, PROVED `episode_never_process_slot`,
  `episode_ambiguous_no_default`; counterexample for a handler passing `undefined`:
  `orig_episode_takes_slot`. Test mutation `session: undefined` -> 3 episode tests fail.

## 2. TTL sweep (`SESSION_TTL_MS`, `_pendingScopeEvictions`)

- PROVED `open_within_ttl`: every session left open started within eight hours.
- PROVED `expired_registration_cleared`: with Adapters' invariant (every registration
  open or pending), the plur-bearing sweep at session start removes every expired
  session's registration, fed with exactly the ids the TTL picks (`expiredIds`).
  Non-vacuity: `live_registration_kept`. Builds on `Adapters.sweep`/`Adapters.Inv`.
- TESTED: expired session not implicit; a session inside its TTL keeps its default.
- DECIDED (owner, option "sweep"), see Questions 2: `_writeSession` and `_resolveWriteSession`
  run the plur-bearing sweep (`_cleanExpiredSessions(plur)`) before resolving, so an explicit id
  past its eight hours resolves to nothing at once, through the server or not. Before the
  decision an explicit id of an expired-but-not-yet-swept session still resolved until the next sweep.

## 3. Refusals in plur_session_scope

- PROVED `ambiguous_change_refused` (set/clear with several sessions and no id),
  `accepted_set_targets_session` (an accepted set always names a session),
  `clear_unknown_via_server` (`clearCtx`: no record through the server restores null,
  never the project config, another session's default or the slot).
  Counterexample shape: `orig_clear_takes_project_config`; non-vacuity
  `clear_restores_start_default`, `lone_set_accepted`.
- TESTED: set/clear refused with two sessions and the slot unchanged; set refused with
  none open; clear of a ghost session via the server restores null, slot intact.
- Unknown export format refusal and TOOL-4 destructive marking: already backed
  (provenance-tool.test.ts; R2Integrations theorems + tool-profile tests). Not re-modelled.

## 4. server.ts tool-call serialisation (`callTail`)

Model: a slot with a FIFO queue; arrival while busy waits; `finally { release() }`
releases on success and failure.
- PROVED `step_inv`/`run_inv` (handlers start in arrival order, none skipped, nothing
  waits while free), `busy_arrival_waits`, `failed_call_releases`.
  Counterexample (release only on success): `orig_failure_blocks_next`;
  non-vacuity `both_calls_run`.
- TESTED via a real server over InMemoryTransport: second call does not reach its
  handler while the first runs (max concurrency 1); a failing call does not block the next.
- Code mutations: `await prev` -> `void prev` fails the first test; moving `release()`
  out of `finally` onto the success path fails the second (times out at 5 s).

## Mutation checks (scratch copy of McpTools.lean)

| Mutation | Broke |
|---|---|
| localSess drops `_knownSession` | write_never_process_slot, unknown_id_no_default, fixed_unknown_id_no_slot |
| implicit without sweep | implicit_unexpired |
| sweep keeps all | open_within_ttl |
| no expired ids | expired_registration_cleared |
| no ambiguity refusal | ambiguous_change_refused, accepted_set_targets_session |
| clear falls back to project config | clear_unknown_via_server |
| release only on success | failed_call_releases |
| busy arrival starts | step_inv, busy_arrival_waits, orig_failure_blocks_next |
| episode passes undefined | episode_never_process_slot, episode_ambiguous_no_default |
| serverSession drops `_knownSession` | proof scripts break, but the property survives semantically: the start default also needs a telemetry record, so the server-side check is defence in depth (same in TS: removing it alone keeps all tests green) |

## Questions for the owner

1. DECIDED: option (a) "nosession". plur_inject / plur_inject_hybrid with an explicit session id this process never
   saw, outside the server: (a) treat it as no session, like writes now do; (b) keep
   passing it (injection scope may come from the slot). Through the server it is harmless.
   Applied: without a FolderScopeContext `_resolveWriteSession` passes `NO_SESSION` unless
   `_knownSession(id, plur, false)`. Model: `injectLocal`, PROVED `inject_unknown_id_no_session`,
   `orig_inject_unknown_takes_slot` (counterexample), `inject_registered_kept` (non-vacuity).
   Test, red before (`expected [ 'never-started', 'never-started' ] to deeply equal [ '\u0000plur:no-session', …(1) ]`),
   green after: `formal-mcp-tools-session.test.ts::without the server, plur_inject and
   plur_inject_hybrid treat a session id never started or registered as no session`; kept case:
   `…::without the server, plur_inject still passes a session registered in core`.
2. DECIDED: option (a) "sweep". An explicit id of a session past its 8 h TTL but not yet swept still resolves:
   (a) sweep before any explicit resolution so it stops at exactly 8 h; (b) keep (bounded by the next sweep).
   Applied: `_writeSession` and `_resolveWriteSession` call `_cleanExpiredSessions(plur)` first.
   Model: `sweepSt`, `writeSessionNow`; PROVED `explicit_expired_no_default`,
   `inject_expired_no_session`, `write_now_never_process_slot` (the slot rule survives the sweep);
   boundary `named_at_ttl_resolves` / `named_past_ttl_none`; counterexample
   `orig_named_past_ttl_resolves`. Test (fake Date), red before (`expected 'project:old' not to
   be 'project:old'`), green after: `formal-mcp-tools-session.test.ts::an explicit session id
   stops resolving once its 8 hours are up, without waiting for a later sweep`.
   Through the server an injection still passes an expired explicit id to core; its registration
   is gone, so no session default applies.
