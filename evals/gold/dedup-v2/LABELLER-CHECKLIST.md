# Duplicate-checker pairs, version 2 — labelling rules

Version 2 of the duplicate-checker pairs (the promise LRN-7). It replaces the two labels in `evals/gold/recall-v1/dedup_pairs.yaml`, which stays frozen as written, with three. The pairs are the same 60, word for word. Only labels changed.

Why: owner decision 2026-10-18. A newer statement that changes a value is "a separate memory that supersedes the previous one". Version 1 labelled such a pair `distinct` ("conflicting values are labelled distinct, as requested"). That said nothing about which memory should win, so it could not grade supersede.

## Labels

- **`duplicate`**: the incoming statement says the same thing as the existing one, with every condition, reason, unit and project kept. Right outcome: exactly one active memory, with the existing text unchanged.
- **`supersede`**: same subject and same rule, but the incoming statement changes a value, a timing, a threshold, a place, a role or a behaviour. The two cannot both be followed, so the newer one replaces the older. Right outcome: both are stored. The new statement is saved as said and is active. The old text is unchanged and marked superseded by the new one (`relations.superseded_by` on the old, `relations.supersedes` on the new), so it is no longer given to the agent.
- **`distinct`**: a different subject or target that can be true at the same time as the existing statement. Examples: another project, error messages versus success messages, an additional attachment rather than a replacement one. Right outcome: two active memories, the existing text unchanged.

Rewriting the existing memory's text is wrong under every label.

## How version 2 was made

- Every version-1 `duplicate` pair stays `duplicate`.
- Every version-1 `distinct` pair was judged again against the definitions above. The reasons for the dev set are in the round-4 hand-back, by pair id. The private holdout was relabelled by the same rules, and is referred to by id only.
- Result, in both sets: 30 duplicate, 27 supersede, 3 distinct.
- Then (owner, 2026-10-18) 17 more `distinct` pairs per set, ids P061 to P077, written by a labeller from a different model family (a GPT model through Codex, run in an empty folder with no access to the code) from `LABELLER-PROMPT.md`. Each shares at least 70% of its content words, which `evals/gold/check.py` enforces for every pair after P060. Final count in both sets: 30 duplicate, 27 supersede, 20 distinct (77 pairs).

## Known weakness (closed 2026-10-18)

With 3 `distinct` pairs a false-merge rate meant nothing (the 95% interval for 3 of 3 ran from about 44% to 100%). Each set now has 20, the minimum the duplicate-checker promise (LRN-7) requires before it grades false merges. Twenty is still a small sample: one false merge is 5%.
