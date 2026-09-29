# Remote store: retried writes

How the client retries a write to a team store, and what a server does to make
those retries safe. Everything here is additive: a server that ignores it keeps
working, at the cost of at most one duplicate per write (below).

## The idempotency key

Every `POST /api/v1/engrams` from the client carries a key:

- as the `Idempotency-Key` request header, and
- as `idempotency_key` in the JSON body.

The key is exactly this:

- **Unique per logical write.** It is a random UUID (version 4), minted once
  when the write is created. Two different writes never share a key, not even
  from two machines using the same token, or two writes of the same statement.
  It is never derived from an engram id, a statement or a timestamp.
- **Persisted before the first POST.** It is stored on the queued write's
  outbox row before that write is first posted. A row queued by an older
  client that has no key gets one minted and stored before it is posted.
- **Stable across retries.** Every retry of *that* write sends the same key,
  including a retry after the client failed to record an earlier outcome.

## Retries

A push that timed out, was cut short by a time budget, or failed with an
error is not treated as "maybe delivered". It stays queued and is **retried**
on the next flush, **with the same key**. The client does not look for the
write on the server before retrying.

Two local writers never push the same queued write at once. Before pushing,
the client takes a claim on the write: a file created atomically. A claim made
on this machine is held for as long as its process is alive, however long the
push takes (a hard cap of 15 minutes guards against a recycled process id); a
claim from another machine sharing the store directory is held for a 60-second
lease. A stale claim is taken over by renaming a new claim file over it, so the
claim is never absent during a takeover.

## What the server does with the key

1. **A key-honouring server must deduplicate by key.** For a key it has already
   accepted from the same token, it returns the original response (status and
   `id`) instead of creating a second engram. The window must be at least as
   long as the client keeps retrying a queued write: 7 days. On such a server
   every write is stored exactly once, however many times it is retried.
2. **A key-ignoring server may see at most one duplicate per write.** A retry
   that follows an attempt the server stored but the client never heard back
   from creates a second row. The client never deletes its queued copy before
   a push is confirmed, so writes are never lost this way, only possibly
   duplicated once.
3. **Recommended:** record the key with the engram and return it as
   `data.idempotency_key` in list responses, so an operator can find and merge
   such duplicates.
