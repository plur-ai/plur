# Remote store: retried writes

How the client retries a queued write (the outbox), and what a server can do
to make those retries safe. Everything here is additive: a server that
ignores it keeps working.

## `Idempotency-Key` on `POST /api/v1/engrams`

Every create carries an `Idempotency-Key` header whose value is the client's
**local engram id** (for example `ENG-2026-09-29-001`). It is the same on
every retry of the same queued write, and different for different writes.

A server that honours it should, for a key it has already accepted from the
same token, return the original response (status and `id`) instead of
creating a second engram. A server that ignores the header is still safe,
because the client also checks before retrying, as described next.

## Retry after a cut request

A client that gives up on a create before the server answers cannot tell
whether the server stored it. This happens when a hook's time budget runs out.
The client marks such a write as *in doubt*. Before posting it again, the
client pages `GET /api/v1/engrams?scope=<scope>` and looks for an active
engram with exactly the same `statement`:

- **Found:** the write is treated as delivered and the server's `id` is used.
  Nothing is posted.
- **Absent after a complete listing:** the write is posted again.
- **Anything else** (timeout, 5xx, incomplete paging): nothing is posted. The
  write stays queued for a later flush.

A server therefore needs only the list endpoint it already has for this check.
