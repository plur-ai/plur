# Two processes flushing the same outbox can both push an engram

Found by the formal verification run of 2026-09-23 (`spec/formal/findings/writepath.md`, candidate 1; theorem `guarded_at_most_once` holds per process only).

The verification branch makes delivery at-most-once within one process (an in-memory in-flight claim). Two processes — e.g. the MCP server and a CLI hook — flushing the same store can still both append the same engram to the remote.

**Owner decision (2026-09-26):** accept for now; a full fix changes the outbox row's persisted format, so it is a separate change.

Proposed: an on-disk lease on outbox rows (holder id + expiry), taken under the store lock before the network call and cleared on merge-back.
