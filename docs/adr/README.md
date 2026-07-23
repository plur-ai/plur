# Architecture Decision Records

ADRs document significant architectural choices — why a decision was made, what
alternatives were rejected, and what the trade-offs are.

**New ADRs:** copy the most recent file as a template, increment the number, and
open a PR. Link the issue that prompted the decision in the `Related:` field.

## Index

| # | Title | Status | Date | Issue |
|---|-------|--------|------|-------|
| 0001 | [YAML as source of truth for engram state](https://github.com/plur-ai/plur/issues/226) | Accepted | 2025-09 | [#226](https://github.com/plur-ai/plur/issues/226) |
| 0002 | [Derived-state provenance — history JSONL as source of truth for graph edges](ADR-0002-derived-state-provenance.md) | Accepted | 2026-07-02 | [#452](https://github.com/plur-ai/plur/issues/452) |

## Notes

**ADR-0001** predates the `docs/adr/` directory and lives as GitHub issue
[#226](https://github.com/plur-ai/plur/issues/226). It established the
YAML-as-truth invariant that ADR-0002 extends. It will be migrated here as a
file when it is next amended.

**ADR-0002** has two files: `ADR-0002-derived-state-provenance.md` (the
canonical record, linked above) and `ADR-0002.md` (an earlier draft, kept for
reference). The canonical file supersedes the draft.
