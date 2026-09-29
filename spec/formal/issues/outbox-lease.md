# Two processes flushing the same outbox can both push an engram

Found by the formal verification run of 2026-09-23 (`spec/formal/findings/writepath.md`, candidate 1; theorem `guarded_at_most_once` holds per process only).

The verification branch makes delivery at-most-once within one process (an in-memory in-flight claim). Two processes — e.g. the MCP server and a CLI hook — flushing the same store can still both append the same engram to the remote.

**Owner decision (2026-09-26):** accept for now; a full fix changes the outbox row's persisted format, so it is a separate change. Later the same day the owner chose to implement the format changes now, each as its own PR.

**Status: implemented in this PR (branch `formal/outbox-lease`, decision D2).**

- Format (additive): `structured_data._outboxLease = { holder, expires_at }` on a row being pushed or retired. `holder` is an opaque per-instance id (pid + random UUID, no host name). A row without the field is unleased; an older client ignores it.
- `flushOutbox()` selects and leases its rows under the store lock, skips rows with a live lease of another holder, starts a push/retire only while at least `OUTBOX_LEASE_MARGIN_MS` (5 min since the audit of #1231: request + store-lock wait + merge-back write + skew; was 2 min) of its lease (`OUTBOX_LEASE_TTL_MS`, 10 min) remains, and releases its own leases in the merge-back (success, failure, or not attempted). `learn()` writes a remote-bound row born leased and releases the lease with the outcome of its push. An expired lease may be taken over, so a crashed holder blocks its rows for at most one TTL. The same lease covers `_retireRemote` entries.
- `_outboxLease` is in `PLUR_BOOKKEEPING_KEYS` (never scanned, never exported) and `updateEngram` keeps the stored lease, never a caller-supplied one.
- Model: `spec/formal/PlurSpec/WritePath.lean` §1c, `leased_at_most_once_across_processes`.
- Tests: `packages/core/test/formal-outbox-lease.test.ts`.

Remaining limits (stated in `outbox-lease.ts` and the model): clocks of processes sharing a store must agree within the skew allowance (1 min); a process killed — or whose wait for the store lock times out — after the remote accepted its push but before its merge-back re-delivers after the TTL (the at-least-once edge the single-process path already has); an older client that does not know the lease is not excluded by it.
