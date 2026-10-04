# Provenance `withheld` tests only `scope === 'local'`

Found by the formal verification run of 2026-09-23 (`spec/formal/findings/scopeinject.md`, candidate 3; theorem `provenance_global_not_withheld`).

`provenance.ts` treats an engram as withheld (not cleared to leave the machine) only when its scope is exactly `local`. `global`, `user:*` and `agent:*` engrams are personal-family and treated as on-machine by the leak guard, yet their provenance summary reports `maySharePlainly: true` with no `notShared` prohibition.

The obvious fix — reuse the leak guard's "does not leave the machine" predicate — is wrong: it withholds global/personal engrams explicitly marked `visibility: 'public'`, so every exported pack's provenance record would forbid distributing the pack it ships in, and it reverses `provenance-tester-round2.test.ts` "leaves a shareable memory alone" and `mcp/test/provenance-tool.test.ts` "honours a public visibility". (Tried and reverted during the apply phase, 2026-09-26.)

Needs a definition first: which of scope, visibility and an explicit share act decides "cleared to leave the machine"? One candidate: withheld = visibility private, OR (does not leave the machine AND visibility is not explicitly public).
