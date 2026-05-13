#!/usr/bin/env python3
"""Generate learning-corpus.jsonl for strategy-3 extractor validation.

Each entry: {"turn_text": str, "labels": [{start, end, text, kind}]}
kind ∈ {learning, hypothetical, reasoning, instruction, none}

Run from the fixtures/ directory:
  python3 gen_corpus.py > learning-corpus.jsonl
"""
import json
import sys


def entry(turn_text: str, spans: list[tuple[str, str]]) -> dict:
    """Build a corpus entry with auto-computed span positions.

    spans: list of (substring, kind) — must appear in order in turn_text.
    """
    labels = []
    cursor = 0
    for text, kind in spans:
        idx = turn_text.find(text, cursor)
        if idx == -1:
            raise ValueError(f"Span not found after pos {cursor}:\n  {text!r}\n  in:\n  {turn_text!r}")
        labels.append({"start": idx, "end": idx + len(text), "text": text, "kind": kind})
        cursor = idx + len(text)
    return {"turn_text": turn_text, "labels": labels}


ENTRIES = [
    # ── Strategy 1 & 2: explicit markers (included for regression coverage) ──

    entry(
        "---\n🧠 I learned:\n- pnpm workspaces require `pnpm install` not `npm install`\n- `workspace:*` pins are rewritten on publish\n---",
        [
            ("pnpm workspaces require `pnpm install` not `npm install`", "learning"),
            ("`workspace:*` pins are rewritten on publish", "learning"),
        ],
    ),
    entry(
        "I learned:\n- Vitest uses `--reporter=verbose` not `--verbose`\n- Test files must end in `.test.ts`\n",
        [
            ("Vitest uses `--reporter=verbose` not `--verbose`", "learning"),
            ("Test files must end in `.test.ts`", "learning"),
        ],
    ),
    entry(
        "Correction noted:\n- Use `pnpm --filter @plur-ai/core build` before running claw tests\n",
        [("Use `pnpm --filter @plur-ai/core build` before running claw tests", "learning")],
    ),
    entry(
        "Key takeaway:\n- Engrams are stored in YAML, not JSON or SQLite\n",
        [("Engrams are stored in YAML, not JSON or SQLite", "learning")],
    ),
    entry(
        "Noted:\n- The `PLUR_PATH` env var overrides the default `~/.plur` storage location\n",
        [("The `PLUR_PATH` env var overrides the default `~/.plur` storage location", "learning")],
    ),

    # ── Strategy 3 targets: bare corrections (no explicit marker) ──

    entry(
        "I was wrong about the publish order. Core must be published first since mcp and claw depend on it via workspace:*.",
        [("I was wrong about the publish order. Core must be published first since mcp and claw depend on it via workspace:*.", "learning")],
    ),
    entry(
        "I stand corrected — the right approach is to call `pnpm build` in core before running integration tests, not to rely on the source TypeScript directly.",
        [("I stand corrected — the right approach is to call `pnpm build` in core before running integration tests, not to rely on the source TypeScript directly.", "learning")],
    ),
    entry(
        "I was mistaken: `tsup` does tree-shake ES module bundles by default. The flag to disable it is `--no-treeshake`.",
        [("I was mistaken: `tsup` does tree-shake ES module bundles by default. The flag to disable it is `--no-treeshake`.", "learning")],
    ),
    entry(
        "Looking at this more carefully, I see I had the engram decay formula backwards. Strength decays exponentially with time, not linearly.",
        [("Looking at this more carefully, I see I had the engram decay formula backwards. Strength decays exponentially with time, not linearly.", "learning")],
    ),
    entry(
        "Actually, the remote store API uses `/api/v1/engrams` not `/api/engrams`. I had the wrong path.",
        [("Actually, the remote store API uses `/api/v1/engrams` not `/api/engrams`. I had the wrong path.", "learning")],
    ),
    entry(
        "I need to correct my earlier statement: the BM25 index is rebuilt on every `load()` call, not cached between sessions. That's why recall latency spikes on large stores.",
        [("I need to correct my earlier statement: the BM25 index is rebuilt on every `load()` call, not cached between sessions. That's why recall latency spikes on large stores.", "learning")],
    ),
    entry(
        "I was wrong — `plur_inject_hybrid` runs BM25 + embeddings RRF, not just BM25. The `plur_inject` tool is the BM25-only path.",
        [("I was wrong — `plur_inject_hybrid` runs BM25 + embeddings RRF, not just BM25. The `plur_inject` tool is the BM25-only path.", "learning")],
    ),
    entry(
        "Correction: the `on_session_end` hook fires after the model's final message, not before. I had the lifecycle order wrong.",
        [("Correction: the `on_session_end` hook fires after the model's final message, not before. I had the lifecycle order wrong.", "learning")],
    ),
    entry(
        "I was mistaken about the engram minimum strength. New engrams start at 0.5 by default, not 1.0. They reach 1.0 only after the first `plur_recall` hit.",
        [("I was mistaken about the engram minimum strength. New engrams start at 0.5 by default, not 1.0. They reach 1.0 only after the first `plur_recall` hit.", "learning")],
    ),
    entry(
        "I had this backwards: `plur_forget` soft-deletes by marking `deleted: true`, it does not remove the YAML entry immediately. The entry is pruned on the next `gc()` pass.",
        [("I had this backwards: `plur_forget` soft-deletes by marking `deleted: true`, it does not remove the YAML entry immediately. The entry is pruned on the next `gc()` pass.", "learning")],
    ),

    # ── Strategy 3 targets: behavioral / preference corrections ──

    entry(
        "From now on I will always verify day-of-week with python3 before writing org timestamps — I've gotten these wrong multiple times.",
        [("From now on I will always verify day-of-week with python3 before writing org timestamps — I've gotten these wrong multiple times.", "learning")],
    ),
    entry(
        "I should never run `--help` on the publish scripts here. The `flag in sys.argv` pattern treats unrecognized args as live-publish triggers.",
        [("I should never run `--help` on the publish scripts here. The `flag in sys.argv` pattern treats unrecognized args as live-publish triggers.", "learning")],
    ),
    entry(
        "I will remember to check the stub server in `test/helpers/stub-server.ts` whenever adding a new remote store endpoint — the integration tests use it and won't exercise the new path otherwise.",
        [("I will remember to check the stub server in `test/helpers/stub-server.ts` whenever adding a new remote store endpoint — the integration tests use it and won't exercise the new path otherwise.", "learning")],
    ),
    entry(
        "I'll make sure to rebuild core with `pnpm --filter @plur-ai/core build` before running claw tests. Skipping this step causes stale-dist failures that look like test bugs.",
        [("I'll make sure to rebuild core with `pnpm --filter @plur-ai/core build` before running claw tests. Skipping this step causes stale-dist failures that look like test bugs.", "learning")],
    ),
    entry(
        "I must never use `git checkout <branch> -- <path>` when there are unstaged changes. It silently overwrites the working tree.",
        [("I must never use `git checkout <branch> -- <path>` when there are unstaged changes. It silently overwrites the working tree.", "learning")],
    ),
    entry(
        "I now know that the `workspace:*` dependency is rewritten to the exact version on publish. Bumping core without bumping the consumers breaks downstream installs.",
        [("I now know that the `workspace:*` dependency is rewritten to the exact version on publish. Bumping core without bumping the consumers breaks downstream installs.", "learning")],
    ),
    entry(
        "The correct way to run smoke tests against the production server is to set `PLUR_REMOTE_TEST_URL`, `PLUR_REMOTE_TEST_TOKEN`, and `PLUR_REMOTE_TEST_SCOPE` before running `pnpm test:smoke`.",
        [("The correct way to run smoke tests against the production server is to set `PLUR_REMOTE_TEST_URL`, `PLUR_REMOTE_TEST_TOKEN`, and `PLUR_REMOTE_TEST_SCOPE` before running `pnpm test:smoke`.", "learning")],
    ),
    entry(
        "I was wrong to assume the decay batch runs client-side for remote stores. Decay is server-side for remote scopes; the client only triggers `plur_batch_decay` for local engrams.",
        [("I was wrong to assume the decay batch runs client-side for remote stores. Decay is server-side for remote scopes; the client only triggers `plur_batch_decay` for local engrams.", "learning")],
    ),

    # ── Strategy 3 targets: self-report without explicit "I was wrong" language ──

    entry(
        "The actual return type of `plur_recall` is `EngramResult[]`, not `string[]`. I see now why the downstream code was failing — the caller was treating the items as raw strings.",
        [("The actual return type of `plur_recall` is `EngramResult[]`, not `string[]`. I see now why the downstream code was failing — the caller was treating the items as raw strings.", "learning")],
    ),
    entry(
        "After checking the source, the correct flag is `--access public`, not `--public`. The npm publish command silently ignores unrecognized flags, which is why I didn't catch this earlier.",
        [("After checking the source, the correct flag is `--access public`, not `--public`. The npm publish command silently ignores unrecognized flags, which is why I didn't catch this earlier.", "learning")],
    ),
    entry(
        "The version bump requires changes in nine places, not five. I missed `packages/claw/src/context-engine.ts` and the test version assertions when I first listed them.",
        [("The version bump requires changes in nine places, not five. I missed `packages/claw/src/context-engine.ts` and the test version assertions when I first listed them.", "learning")],
    ),
    entry(
        "I see now that `plur_inject` selects engrams based on spreading activation from the current context, not simple recency. Context similarity drives the score.",
        [("I see now that `plur_inject` selects engrams based on spreading activation from the current context, not simple recency. Context similarity drives the score.", "learning")],
    ),
    entry(
        "Reviewing the spec again: the `install_id` is a UUID v4 generated client-side on first install, persisted in `~/.plur/config.yaml`. It is not regenerated per session.",
        [("the `install_id` is a UUID v4 generated client-side on first install, persisted in `~/.plur/config.yaml`. It is not regenerated per session.", "learning")],
    ),

    # ── Near-miss negatives: INSTRUCTIONS to the user (should NOT extract) ──

    entry(
        "You should always use `pnpm` for this monorepo — yarn and npm don't resolve the `workspace:*` protocol correctly.",
        [("You should always use `pnpm` for this monorepo — yarn and npm don't resolve the `workspace:*` protocol correctly.", "instruction")],
    ),
    entry(
        "You must never pass `--no-verify` to git commit here unless you've confirmed the hooks are intentionally being bypassed. The hooks run the type-check.",
        [("You must never pass `--no-verify` to git commit here unless you've confirmed the hooks are intentionally being bypassed. The hooks run the type-check.", "instruction")],
    ),
    entry(
        "To publish, you should always authenticate as `plur9` first, then publish core before mcp and claw.",
        [("To publish, you should always authenticate as `plur9` first, then publish core before mcp and claw.", "instruction")],
    ),
    entry(
        "You should never delete engrams directly from `engrams.yaml` — always use `plur_forget` so the deletion is recorded in the history log.",
        [("You should never delete engrams directly from `engrams.yaml` — always use `plur_forget` so the deletion is recorded in the history log.", "instruction")],
    ),
    entry(
        "If you want to test your changes against the live server, you'll need to set the three env vars and run `pnpm test:smoke`. Local unit tests won't catch remote-routing bugs.",
        [("If you want to test your changes against the live server, you'll need to set the three env vars and run `pnpm test:smoke`. Local unit tests won't catch remote-routing bugs.", "instruction")],
    ),
    entry(
        "Before publishing, you must bump versions in all nine places listed in CLAUDE.md. Skipping any one of them causes consumers to pin the wrong dist.",
        [("Before publishing, you must bump versions in all nine places listed in CLAUDE.md. Skipping any one of them causes consumers to pin the wrong dist.", "instruction")],
    ),
    entry(
        "When adding a new remote endpoint, you should update the stub server at `test/helpers/stub-server.ts` alongside the implementation, or the integration tests will fail.",
        [("When adding a new remote endpoint, you should update the stub server at `test/helpers/stub-server.ts` alongside the implementation, or the integration tests will fail.", "instruction")],
    ),
    entry(
        "Always verify the day-of-week in org timestamps with `python3 -c \"from datetime import date; print(date(Y,M,D).strftime('%a'))\"` before writing them.",
        [("Always verify the day-of-week in org timestamps with `python3 -c \"from datetime import date; print(date(Y,M,D).strftime('%a'))\"` before writing them.", "instruction")],
    ),

    # ── Near-miss negatives: HYPOTHETICALS (should NOT extract) ──

    entry(
        "If we were to migrate to a relational database, we should never store engram text in a blob column — full-text search requires a dedicated index.",
        [("If we were to migrate to a relational database, we should never store engram text in a blob column — full-text search requires a dedicated index.", "hypothetical")],
    ),
    entry(
        "If the remote store goes down, we would want the client to fall back gracefully to local engrams rather than throwing. We should never surface infra errors to the model.",
        [("If the remote store goes down, we would want the client to fall back gracefully to local engrams rather than throwing. We should never surface infra errors to the model.", "hypothetical")],
    ),
    entry(
        "One approach would be to add versioning to the engram schema. We would then need to handle migrations, which could be complex.",
        [("One approach would be to add versioning to the engram schema. We would then need to handle migrations, which could be complex.", "hypothetical")],
    ),
    entry(
        "If the team ever decides to switch from YAML to SQLite for primary storage, they should prefer WAL mode to avoid reader-writer contention.",
        [("If the team ever decides to switch from YAML to SQLite for primary storage, they should prefer WAL mode to avoid reader-writer contention.", "hypothetical")],
    ),
    entry(
        "In theory, you could cache the BM25 index across sessions to improve recall latency. The tradeoff is that stale index entries would persist until the next full reload.",
        [("In theory, you could cache the BM25 index across sessions to improve recall latency. The tradeoff is that stale index entries would persist until the next full reload.", "hypothetical")],
    ),
    entry(
        "Were we to open-source the enterprise server, we would need to strip the billing and ACL logic first, as those are the commercial differentiators.",
        [("Were we to open-source the enterprise server, we would need to strip the billing and ACL logic first, as those are the commercial differentiators.", "hypothetical")],
    ),
    entry(
        "One could argue that we should prefer an append-only log over YAML for engram storage — it would make corruption recovery easier.",
        [("One could argue that we should prefer an append-only log over YAML for engram storage — it would make corruption recovery easier.", "hypothetical")],
    ),

    # ── Near-miss negatives: REASONING / EXPLANATION (should NOT extract) ──

    entry(
        "The code should never mutate engrams in place — the BM25 index caches field values at index-time, so in-place mutation creates ghost terms in the index.",
        [("The code should never mutate engrams in place — the BM25 index caches field values at index-time, so in-place mutation creates ghost terms in the index.", "reasoning")],
    ),
    entry(
        "Spreading activation works by propagating score from the query engrams to their neighbors. We should prefer high-betweenness engrams as injection candidates because they connect otherwise-distant memory clusters.",
        [("We should prefer high-betweenness engrams as injection candidates because they connect otherwise-distant memory clusters.", "reasoning")],
    ),
    entry(
        "RRF fusion avoids the need to normalize BM25 and embedding scores to the same scale. We should prefer RRF over weighted sum when the two distributions are different shapes.",
        [("We should prefer RRF over weighted sum when the two distributions are different shapes.", "reasoning")],
    ),
    entry(
        "The decay formula uses exponential decay with a half-life of 30 days by default. We should never set the half-life below 7 days for behavioral engrams, as they would decay before the behavior has time to reinforce.",
        [("We should never set the half-life below 7 days for behavioral engrams, as they would decay before the behavior has time to reinforce.", "reasoning")],
    ),
    entry(
        "In ACT-R memory theory, base-level activation decays logarithmically with time and increases with each retrieval. PLUR approximates this with a simpler exponential model that preserves the key property: frequent recall slows decay.",
        [],  # pure explanation, no learning or near-miss spans
    ),
    entry(
        "BM25 uses term frequency and inverse document frequency to score matches. TF saturates with a dampening factor `k1`, and document length normalization is controlled by `b`.",
        [],  # technical explanation, nothing extractable
    ),

    # ── Near-miss negatives: GENERAL ADVICE / PRINCIPLES (should NOT extract) ──

    entry(
        "Good software should always be testable in isolation. We should prefer pure functions over side-effectful ones in the core engram engine.",
        [("We should prefer pure functions over side-effectful ones in the core engram engine.", "reasoning")],
    ),
    entry(
        "APIs should never expose internal implementation details. The Plur class should always present a stable, opaque interface even if the storage format changes underneath.",
        [("APIs should never expose internal implementation details.", "reasoning"),
         ("The Plur class should always present a stable, opaque interface even if the storage format changes underneath.", "reasoning")],
    ),
    entry(
        "You should always test against the production schema, not a simplified test fixture. Subtle schema differences can mask bugs that only appear in real data.",
        [("You should always test against the production schema, not a simplified test fixture.", "instruction")],
    ),

    # ── Mixed: turn contains both a correction and an explanation ──

    entry(
        "I was wrong about the recall limit. The default is 20 engrams, not 10. The `limit` parameter in `plur_recall` controls this. For context: the limit exists to keep injection prompts under a token budget — it's not a quality filter.",
        [("I was wrong about the recall limit. The default is 20 engrams, not 10. The `limit` parameter in `plur_recall` controls this.", "learning")],
    ),
    entry(
        "Correction: the `plur_sync` tool uses git, not rsync. Under the hood it runs `git pull` and `git push` in the `~/.plur` directory. This means sync requires a configured remote — it won't work out of the box on a fresh install without running `plur sync init` first. You should set that up before expecting cross-machine sync to work.",
        [("Correction: the `plur_sync` tool uses git, not rsync. Under the hood it runs `git pull` and `git push` in the `~/.plur` directory.", "learning"),
         ("You should set that up before expecting cross-machine sync to work.", "instruction")],
    ),
    entry(
        "I had the ACL model backwards. Remote stores use scope-based access control, not per-engram ACL. Individual engrams inherit their ACL from the scope they're written into. If you need per-engram ACL, you should use separate scopes.",
        [("I had the ACL model backwards. Remote stores use scope-based access control, not per-engram ACL. Individual engrams inherit their ACL from the scope they're written into.", "learning"),
         ("If you need per-engram ACL, you should use separate scopes.", "instruction")],
    ),

    # ── Additional near-miss negatives ──

    entry(
        "Error handling should always be explicit. We must never swallow exceptions silently — at minimum, log the error before continuing.",
        [("We must never swallow exceptions silently — at minimum, log the error before continuing.", "reasoning")],
    ),
    entry(
        "For large engram stores, you should prefer the hybrid recall mode over BM25-only. The embeddings surface semantic matches that keyword search misses.",
        [("For large engram stores, you should prefer the hybrid recall mode over BM25-only.", "instruction")],
    ),
    entry(
        "The decay pass should never run during a session — it's designed to run between sessions during nightshift. Running it mid-session could evict engrams the model is actively using.",
        [("The decay pass should never run during a session — it's designed to run between sessions during nightshift.", "reasoning")],
    ),
    entry(
        "If someone were to implement multi-tenant isolation, they would need to ensure that scope prefixes are cryptographically derived from tenant IDs, not user-chosen strings.",
        [("If someone were to implement multi-tenant isolation, they would need to ensure that scope prefixes are cryptographically derived from tenant IDs, not user-chosen strings.", "hypothetical")],
    ),
    entry(
        "To get the best recall quality, you should always rebuild the embedding index after bulk ingest rather than relying on lazy index updates.",
        [("To get the best recall quality, you should always rebuild the embedding index after bulk ingest rather than relying on lazy index updates.", "instruction")],
    ),
    entry(
        "Memory consolidation, like sleep consolidation in humans, should preferably happen when the system is idle. We should prefer nightshift-scheduled compaction over inline compaction triggered during active sessions.",
        [("We should prefer nightshift-scheduled compaction over inline compaction triggered during active sessions.", "reasoning")],
    ),
    entry(
        "When writing a new MCP tool handler, you should always validate the input schema with Zod before calling the core API. The core layer assumes valid input and doesn't surface useful error messages for schema violations.",
        [("When writing a new MCP tool handler, you should always validate the input schema with Zod before calling the core API.", "instruction")],
    ),

    # ── Turns with no learnings at all ──

    entry(
        "The current test suite has 150 tests across 22 files. The slowest suite is the hybrid search test, which takes about 4 seconds due to the embedding model warm-up.",
        [],
    ),
    entry(
        "The `plur_recall` tool accepts a `domain` filter and a `min_strength` threshold. Both are optional. If neither is set, all engrams above the global minimum strength are candidates.",
        [],
    ),
    entry(
        "Session lifecycle: `plur_session_start` injects relevant engrams and records the session start event. `plur_session_end` writes a summary engram and records the session end event. Both calls are idempotent.",
        [],
    ),
    entry(
        "The five packs currently in production are: dips-v1 (DIP conventions), gtd-v1 (GTD methodology), zettelkasten-v1 (PKM conventions), plur-core-v1 (PLUR system knowledge), and trading-v1 (trading rules).",
        [],
    ),
    entry(
        "Looking at the telemetry design: each client sends a daily heartbeat POST to `heartbeat.plur-ai.org/v1/heartbeat`. The payload includes install_id, version, platform, date, and usage counters. No PII, no IP logging.",
        [],
    ),
    entry(
        "The hermes plugin hooks into the Claude Code lifecycle via `pre_llm_call`, `post_llm_call`, `on_session_start`, and `on_session_end`. The `post_llm_call` hook is where learning extraction happens.",
        [],
    ),
    entry(
        "I don't see a clear answer here — the tradeoff between BM25-only and hybrid recall depends on the engram store size and the query distribution. Below ~500 engrams, BM25 alone is often sufficient.",
        [],
    ),
    entry(
        "That's an interesting design question. There are three main options: (1) append-only YAML log with periodic compaction, (2) SQLite with WAL mode, (3) keep the current mutable YAML with a write-ahead shadow. Each has different tradeoffs for crash recovery.",
        [],
    ),
]


def main():
    for e in ENTRIES:
        print(json.dumps(e, ensure_ascii=False))


if __name__ == "__main__":
    main()
