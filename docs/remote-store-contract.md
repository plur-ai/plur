# Remote store contract

## `GET /api/v1/me` — identity and scope discovery

Called once per session to resolve the token's identity and authorized scope set
(#292). Scope-independent: the `/me` endpoint is keyed on the token alone.

### Success `200`

```json
{
  "username": "alice",
  "org_id": "acme",
  "role": "developer",
  "scopes": ["user:acme:alice", "group:acme/team", "project:acme/team/backend"],
  "scopes_status": "ok",
  "scope_metadata": [ /* array of scope metadata objects */ ],
  "scope_metadata_status": "ok",
  "gitlab_host": "gitlab.example.com",
  "project_paths": { "project:acme/team/backend": "team/backend" },
  "key_expires_at": null
}
```

Field details:

| Field | Type | Notes |
|---|---|---|
| `username` | string | Login name. |
| `org_id` | string | Organization identifier; used as the org-prefix for scope validation. |
| `role` | string | `"developer"`, `"admin"`, etc. |
| `scopes` | string[] | All scopes the token may read and write. Validated to `/^[\w:./-]+$/` at the client trust boundary (#426). |
| `scopes_status` | `"ok"` \| `"not_synced"` | `"ok"` = list is complete; `"not_synced"` = user not yet in the sync graph, list is `[]`. **Absent** on older servers → client treats as `"absent"`. |
| `scope_metadata` | object[] | Self-describing metadata per scope (#345). Optional; `[]` when absent. |
| `scope_metadata_status` | `"ok"` \| `"unavailable"` | `"unavailable"` = metadata read failed, `scope_metadata` is `[]`. **Absent** on older servers. |
| `gitlab_host` | string \| null | Hostname of the connected GitLab instance (no scheme, no port unless non-default); `null` when GitLab is not configured; **absent** when not applicable. Validated to `/^[a-z0-9.-]+(:\d{1,5})?$/` (#426). |
| `project_paths` | object | Maps each `project:` scope in `scopes` to its GitLab `path_with_namespace`. Entries whose key is not in `scopes` or whose value fails the path grammar are dropped at the client (#426). |
| `key_expires_at` | string \| null | ISO-8601 expiry of the API key; `null` = no expiry; **absent** = unknown (e.g. authenticated with a JWT, not a key). **Absent and null are different values** — clients must not treat an absent field as `null`. |

### Scope-read failure `503`

```json
{ "error": "scope_lookup_failed" }
```

The server could not read the scope list from the directory service. The client
must not replace a non-empty cached scope list with an empty one on a 503 response.

### Non-2xx

Any non-2xx response causes the client to throw `RemoteHttpError(status, message)`.
Callers treat 401/403 as an auth failure and other errors as transient.

---

## `POST /api/v1/write-check` — permission evidence without a save

The request is `{ "scopes": ["project:example/team/app"] }`, with one to fifty
scopes. The response is `{ "results": [{ "scope": "project:example/team/app",
"writable": true, "review_held": false }] }`. Results must match the requested
scope count and order, with boolean permission fields. A refusal may include a
string `reason`. A review-held write is permitted but awaits review.

Doctor checks all configured enterprise servers: reachability, key acceptance,
credential-file protection, cached scope freshness, the client route and server
write permission, and queued operations. Larger scope lists use ordered chunks
of fifty; no team/project scopes means no permission request. Missing evidence,
including an older server's 404, is **could not check** and fails overall health.
Probes do not refresh grants, send queued saves or repair file permissions.

The CLI also reports hook execution for Claude Code, Codex and Cursor when their
PLUR hooks and MCP registration are both present. Init records installation time;
doctor requires a session-start run after that time. Changed hooks need a
new run. Missing evidence prompts a new session; Codex also needs `/hooks` and
explicit trust. MCP doctor checks the engine/server, not editor hook trust.

# Remote store: retried writes

How the client retries a write to a team store, and what a server does to make
those retries safe. Everything here is additive: a server that ignores it keeps
working, at the cost of duplicate rows when a write is retried (below).

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

Two local writers never push the same queued write, at once or one after the
other. Before pushing, the client takes a claim on the write: a file created
with O_EXCL. A claim made on this machine is held for as long as its process is
alive, however long the push takes (a hard cap of 15 minutes guards against a
recycled process id); a claim from another machine sharing the store directory
is held for a 60-second lease. Taking over a stale claim is also decided by
O_EXCL: the one writer that creates the takeover marker for that exact stale
claim renames a new claim over it, so exactly one writer wins and the claim is
never absent during a takeover. A marker left by a writer that died is judged
by the same liveness rule as a claim, so it cannot block the write. After
taking the claim, the client re-reads the queued write and skips it when it is
gone or carries a different key: another writer delivered it in the meantime.

## What the server does with the key

1. **A key-honouring server must deduplicate by key.** For a key it has already
   accepted from the same token, it returns the original response (status and
   `id`) instead of creating a second engram. The window must be at least as
   long as the client keeps retrying a queued write: 7 days. On such a server
   every write is stored exactly once, however many times it is retried.
2. **A key-ignoring server gets one extra row per attempt it stored but the
   client never heard back from.** There is no fixed bound per write. Each
   such attempt (cut by the flush time budget, timed out, or lost with its
   answer) is followed by a retry, and on a server that ignores the key every
   retry is a new row. Measured: 3 flushes cut after the server stored the
   write, then 1 flush that completed, left **4 rows**. The same scenario on a
   key-honouring server left 1. Concurrent local writers add no duplicates:
   with the claim and the re-read, 2 or 3 racing flushes, and a flush racing
   `learn()`'s background push, each sent exactly one POST per write. The
   client never deletes its queued copy before a push is confirmed, so writes
   are never lost this way, only duplicated.
3. **Recommended:** record the key with the engram and return it as
   `data.idempotency_key` in list responses, so an operator can find and merge
   such duplicates.
