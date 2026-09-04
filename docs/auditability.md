# Auditability

PLUR provides a three-level provenance ladder over the engram store. Each level
extends the previous one without replacing it.

## L1 — Attribution (merged, #1048)

Every history event records `provenance.identity` — who or what produced it.
Set via `PLUR_IDENTITY` or the CLI `--identity` flag. Provides attribution
without tamper-evidence.

## L2 — Hash-chained history (merged, #1051–#1053)

History events are written as append-only JSONL in `~/.plur/history/YYYY-MM.jsonl`.
Each event gets:

- **`hash`** — SHA-256 over the event's canonical bytes (UTF-8 JSON, keys sorted
  lexicographically, no whitespace). Computed by `appendHistory`.
- **`prev`** — the hash of the predecessor event, or `null` for genesis / a
  declared gap when the chain lock could not be taken.

A **checkpoint** event (`plur checkpoint`) commits to the current store state:

- `chain_head` — the predecessor hash at checkpoint time.
- `store_hash` — SHA-256 over the canonical JSON of `engrams.yaml` (not raw bytes;
  stable across CRLF, reformatters, and YAML emitters).
- `engram_count` — active engram count from the same read as `store_hash`.
- `actor` — what triggered the checkpoint (`'cli'`, `'session_end'`, or custom).

`plur verify` reads every history month, checks every link, and names each break,
fork, unprotected legacy range, and store-hash mismatch. Exit codes are a contract:

| Code | Meaning |
|------|---------|
| 0 | Verified — chain holds over everything it covers |
| 1 | Broken — at least one named break or fork |
| 2 | Cannot verify — log unreadable; NOT the same as clean |

### Canonical bytes (§3 spec)

Canonical bytes for a history event:

- UTF-8 JSON
- Keys sorted recursively by UTF-16 code unit (JS default sort)
- No insignificant whitespace
- Timestamps as ISO-8601 strings (never floats)
- `hash`, `signature`, and `signer` excluded (all three are computed FROM or
  ABOUT these bytes)

### What a hash chain can and cannot detect

It detects every edit that does NOT recompute the chain — content tampering,
broken links, deleted events, forks. It cannot detect a rewrite that
recomputes every `prev` and `hash` over the remaining events (an internally
consistent rewrite). **Checkpoints close this gap**: a checkpoint pins a
`chain_head` that a rewrite cannot reproduce, so `checkpoint_head_missing`
catches it for all events written before the checkpoint. Anchoring the
checkpoint hash externally (on a ledger or in a public log) extends the same
argument beyond this store.

## L3 — Ed25519-signed checkpoints (merged, #1055–#1056)

Each acting identity can have an Ed25519 key pair:

```
Private key: ~/.plur/keys/<identity>.key   — PKCS#8 DER, mode 0600
Public key:  <store-root>/keys.yaml        — SPKI DER base64, per-identity registry
```

Generate a key pair:

```
plur keys init [--identity <name>] [--keys-dir <dir>]
```

`plur keys init` is idempotent: calling it again returns the existing public key
without overwriting. `plur keys list` prints all registered public keys.

When an acting identity has a key, `plur checkpoint` adds:

- **`signature`** (top-level) — Ed25519 over the canonical bytes of the checkpoint
  event. The signature covers the same bytes as `hash` (canonical bytes excluding
  `hash`, `signature`, and `signer`), so hash and signature attest the same
  payload independently.
- **`signer`** (top-level) — the identity string. Excluded from canonical bytes;
  the signature's validity is what proves the claim.

An **unsigned checkpoint** is a valid L2 object. A missing signature is
`"unsigned (L2)"`, not tampered.

### Verifying signatures

```
plur verify --signatures
```

For each checkpoint event, `verifyChain` checks the signature and reports one
of four verdicts:

| Verdict | Meaning | Break? |
|---------|---------|--------|
| `valid` | Signature checks out against the registered public key | No |
| `unsigned` | No signature field (valid L2, not L3-capable) | No |
| `unknown_signer` | Signer not in `keys.yaml` on this machine | No |
| `invalid` | Signature does not verify | **Yes** |

`unknown_signer` is a named result, not a chain break — the key may simply not
be registered on this machine. `invalid` IS a chain break: the checkpoint can
no longer be trusted as an external attestation. `plur verify` exits 1 whenever
any break is present (including invalid signatures).

### Key security

Private keys are enforced 0600 on every read — a key readable by group or
world is rejected, not merely warned about. The keys directory is created 0700.
All operations use `node:crypto` only (no external crypto dependencies).

### Implementation files

| File | Purpose |
|------|---------|
| `packages/core/src/history.ts` | `emitCheckpoint`, hash-chain append, canonical bytes |
| `packages/core/src/verify-chain.ts` | `verifyChain`, `ChainVerifyOutcome`, signature verdicts |
| `packages/core/src/actor-keys.ts` | Key generation, permission enforcement, sign/verify, registry |
| `packages/cli/src/commands/checkpoint.ts` | `plur checkpoint` |
| `packages/cli/src/commands/verify.ts` | `plur verify [--signatures]` |
| `packages/cli/src/commands/keys.ts` | `plur keys init`, `plur keys list` |
| `packages/core/test/actor-keys.test.ts` | 38 tests covering W3.1+W3.2 |
