# Prompt for the labeller of the next duplicate-checker pairs

Give this to a model from a different family than the one that wrote PLUR's code, with no access to the code. It writes new pairs in `dedup_pairs.yaml`. The 60 pairs already in this folder are frozen.

---

You are writing labelled test data for a memory system for AI agents. It must be judged on one promise:

- LRN-7: "With an AI checker configured, a real duplicate leaves one active memory; a statement that changes a value is saved as its own memory that supersedes the old one; a different-but-similar statement on another subject stays its own active memory."

Write pairs of one-sentence memories, an `existing` one and an `incoming` one:

    - "id": "P061"
      "existing": "…"
      "incoming": "…"
      "label": "duplicate" | "supersede" | "distinct"

Labels:

- `duplicate`: the same claim, reworded. A careful person would keep only one. Keep every condition, reason, unit and project.
- `supersede`: the same subject and rule, with one thing changed (a value, timing, threshold, place, role or behaviour). The two cannot both be followed, and the incoming one is the newer rule.
- `distinct`: a different subject or target that can be true at the same time (another project, another kind of message, an additional requirement rather than a replacement). Similar wording, but both should stay in force.

Make all pairs hard. Keep word overlap high, at least 70% of the smaller statement's content words for `supersede` and `distinct`. Write `distinct` pairs first, since they are the rare class: at least 20. Quote every YAML key and string.
