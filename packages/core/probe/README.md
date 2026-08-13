# Data-loss probes

Adversarial probes written for the 2026-08-02 store write-path audit
(`docs/audits/2026-08-02-store-write-path-data-loss.md`).

These are **not** unit tests and are not part of `pnpm test`. Each one builds a real store in a temp
directory, corrupts or races it in a specific way, runs real write paths, and prints a measured
before/after count. They exist so the audit's claims stay falsifiable: a finding is only in the
report if a probe here demonstrated it, and a safety property is only claimed if the matching probe
failed to break it.

Run one against the built core:

```sh
pnpm --filter @plur-ai/core build
pnpm --filter @plur-ai/core exec tsx probe/p01-corrupt.ts
```

| Probe | What it attacks | Audit finding |
|---|---|---|
| `p00-smoke.ts` | environment sanity — store builds, writes land | — |
| `p01-corrupt.ts` | corrupt/empty/truncated engrams.yaml vs every write path | **F1** (and the merge-marker case that correctly refuses) |
| `p02-episodes-concurrency.ts` | 4 processes × 25 `captureEpisode` | **F8** (70% loss) |
| `p03-schema-skip.ts` | schema-invalid entries + one ordinary `learn()` | **F2** (silent permanent delete) |
| `p04-engram-concurrency.ts` | 4 processes × 15 `learn()` on the primary store | safety — 60/60, held |
| `p05-stale-lock.ts` | stale-lock threshold behaviour | **F9** |
| `p05b-lock-steal.ts` | lock stealing while the holder is still inside | **F9** (cascade) |
| `p06-git-sync.ts` | autostash pop conflict, pull-failure reporting, push scope strip | **F5, F6, F7** |
| `p06b-git-after-conflict.ts` | `git add -A -f` over an unmerged path | **F5** (markers committed + pushed) |
| `p07-outbox-flush.ts` | mid-flight `learn`/`feedback` during a slow outbox flush | safety — merge-back correct |
| `p08-pack-registry.ts` | truncated registry.yaml + one install | **F11** |
| `p08b-pack-registry-integrity.ts` | tampered pack engram after registry loss | **F11** (`integrity_ok` → `undefined`, never `false`) |
| `p09-config-and-locks.ts` | config.yaml writers, history JSONL append | **F12**; safety — JSONL held |
| `p09b-config-lock-bypass.ts` | `setSchemaVersion` vs the config lock | **F12** (lost update) |
| `p10-seam-capability.ts` | capability store vs plain store on a bad read | **F3** (seam refuses, YAML destroys) |

Probes that demonstrate a *fixed* finding should keep working — they are the regression evidence.
When a fix lands, the probe's output flips from a loss count to a refusal, and that flip is what the
accompanying unit test should assert.
