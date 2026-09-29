# Remote store: retried writes

How the client retries a write to a team store, and what a server does to make
those retries safe. Everything here is additive: a server that ignores it keeps
working. The only cost is that the client then cannot confirm some deliveries
and asks the user instead.

## The idempotency key

Every `POST /api/v1/engrams` from the client carries a key:

- as the `Idempotency-Key` request header, and
- as `idempotency_key` in the JSON body.

The key is exactly this:

- **Unique per logical write.** It is a random UUID (version 4), minted once
  when the write is created. Two different writes never share a key, not even
  from two machines using the same token, or two writes of the same statement.
  It is never derived from an engram id, a statement or a timestamp.
- **Stable across retries.** It is stored with the queued write, and every
  retry of *that* write sends the same key.

## What the server does with it

1. **Deduplicate by key within a window.** For a key it has already accepted
   from the same token, the server returns the original response (status and
   `id`) instead of creating a second engram. The window must be at least as
   long as the client keeps retrying a queued write: 7 days.
2. **Record the key with the engram** and return it as `data.idempotency_key`
   in list responses.
3. **Support lookup by key:** `GET /api/v1/engrams?scope=<scope>&idempotency_key=<key>`
   returns only rows carrying that key. It also echoes `"idempotency_key": "<key>"`
   at the top level of the response, so the client knows the filter was applied.
   An empty filtered answer then means the write is not stored.

## What the client does when delivery is unknown

A write is *in doubt* when a POST may have reached the server but the client
never recorded the outcome: the request was cut by a time budget, timed out, or
its process exited before saving the result. Before any POST, the client takes a
claim on the write: a file created atomically, with a 60-second lease and the
key. This also stops two local writers from pushing the same write at once.
A process that dies mid-request therefore leaves the write in doubt. Before posting an in-doubt write again, the client looks it up **by key**:

- **Found** (a row carries the key): the write is delivered. Nothing is posted.
- **Confirmed absent** (a filtered, echoed answer with no row): the write is
  posted again with the same key.
- **Anything else** (filter not supported, timeout, 5xx, incomplete listing):
  nothing is posted, and the local write is kept. The client never matches by
  statement, because a teammate may have saved the same sentence. After 5 such
  checks the write is marked *needs action*. `plur outbox` shows why, and it is
  no longer retried automatically. Once the user has checked the team store,
  `plur outbox --resend <id>` posts it.
