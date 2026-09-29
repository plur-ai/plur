# Feedback source: server contract

Status: proposed (#1310) · Date: 2026-09-29

PLUR clients send two kinds of feedback on an engram:

- **Explicit**: a person or agent deliberately rated it (`plur_feedback`,
  `plur feedback`).
- **Automatic**: an editor hook inferred the verdict from the assistant's
  reply text, using a heuristic with a 0.6 confidence floor.

A heuristic verdict may move ranking. It must never make knowledge look more
settled than a person has said it is. Locally, the client enforces this: an
automatic signal adjusts `retrieval_strength` and the feedback counters and
never advances `commitment`. A remote store applies feedback with its own rule,
so the client sends it an automatic signal only when the server has promised to
follow the same rule. This document is that promise.

## 1. Capability advertisement

`GET /api/v1/me` may include an optional `capabilities` array of strings:

```json
{
  "username": "…",
  "org_id": "…",
  "role": "…",
  "scopes": ["…"],
  "capabilities": ["feedback.source"]
}
```

- `feedback.source` means the server implements section 3 below.
- The field is additive. A missing field, a non-array value or an empty array
  means no capabilities. Older servers need no change to keep working.
- Clients ignore entries that are not strings matching `^[\w.:-]{1,64}$`, and
  ignore capabilities they do not know.
- Clients cache the capability set per (base URL, token) for the life of the
  process. They read it from the `/me` call already made at session start
  where there is one, and otherwise make at most one `/me` call. There is
  never a `/me` call per feedback request. If `/me` fails, the client treats
  the server as having no capabilities for that process.

## 2. Request

`POST /api/v1/engrams/:id/feedback`, JSON body:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `signal` | `"positive" \| "negative" \| "neutral"` | yes | The verdict. Unchanged. |
| `source` | `"auto"` | no | Present only for automatic feedback. Absent means explicit. |

- Explicit feedback sends `{ "signal": … }` only. Its body is byte-for-byte what
  clients sent before this contract.
- Clients send `source: "auto"` **only** to a server that advertises
  `feedback.source`. A server without the capability receives no automatic
  feedback.

## 3. Required server behaviour (when advertising `feedback.source`)

For a request with `source: "auto"`:

1. Apply the signal to ranking state exactly as for explicit feedback:
   increment the matching feedback counter, and adjust retrieval strength
   (the reference client uses +0.05 for positive and −0.10 for negative, then
   clamps to [0, 1]). Re-anchoring the last-access time is allowed.
2. **Never change `commitment`**, and never change any other field that
   records how settled or reviewed the knowledge is (for example status,
   pinning, review or approval state).
3. Accept the request with the same status codes, errors and response shape as
   explicit feedback.
4. Preferably record the source with the feedback event, so an audit can tell
   automatic verdicts from deliberate ones.

For a request without `source`, behaviour is unchanged (explicit feedback).

A request with a `source` value the server does not recognise should be
treated as explicit feedback or rejected with `400`. It must never be treated
as permission to change commitment on the strength of a signal the server did
not understand.

## 4. Compatibility

| Server | Client behaviour |
|---|---|
| Does not advertise `feedback.source` | Sends no automatic feedback; explicit feedback is unchanged |
| Advertises `feedback.source` | Sends automatic feedback with `source: "auto"` |

The reference implementation is in `@plur-ai/core`:
`RemoteStore.me()`, `RemoteStore.hasCapability()`,
`RemoteStore.feedback(id, signal, { source })`, the gate in `Plur.feedback`, and
the test stub in `packages/core/test/helpers/stub-server.ts`.
