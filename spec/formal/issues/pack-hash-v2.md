# Pack integrity hash is not injective (ENGRAM-STANDARD-v1 §5.5)

Found by the formal verification run of 2026-09-23 (`spec/formal/findings/persistence.md`, candidate 10; theorems `Packs.hash_boundary_collision`, `Packs.hash_missing_eq_empty`).

`computePackHash` (packages/core/src/packs.ts) is `SHA256(SKILL.md ‖ engrams.yaml)` with no framing:

- bytes moved across the file boundary produce the same hash, so front-matter such as `injection_policy` can move between files and still verify `ok`;
- a missing SKILL.md hashes the same as an empty one;
- a legacy `manifest.yaml` pack is outside the integrity check entirely.

The docstring calls the hash a "content-addressable identifier"; it is deterministic, but not that.

**Owner decision (2026-09-26):** handle as a separate change, not in the verification branch.

Proposed: a versioned `sha256:v2:` hash over length-prefixed, named parts; `verify` accepts both v1 and v2; decide separately whether installed packs are re-baselined. Needs a spec change to §5.5.
