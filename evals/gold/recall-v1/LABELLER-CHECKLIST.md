# Evaluation data checklist

Both sets are synthetic answer keys authored from the brief. No memory-engine code, stored memories, or external sources were consulted.

| Check | dev | holdout |
| --- | --- | --- |
| Fictional organisation | Dovren Toolworks | (private) |
| Projects | brindle, sablefin, cairnleaf | (private) |
| Domains | Shell tooling, analytics, build infrastructure | (private) |
| Memories | 150 | 150 |
| Scope distribution | 30 global; 40 per project | 30 global; 40 per project |
| Queries | 80: 40 lexical, 40 paraphrase | 80: 40 lexical, 40 paraphrase |
| Dedup pairs | 60: 30 duplicate, 30 distinct | 60: 30 duplicate, 30 distinct |
| Injection tasks | 30 | 30 |
| Tasks needing two memories | 3 | 3 |
| Deliberate near-miss pairs | 75, covering all 150 memories | 75, covering all 150 memories |
| Observed statement lengths | 9–17 words | 9–18 words |

Each directory contains `corpus.yaml`, `queries.yaml`, `dedup_pairs.yaml`, and `inject_tasks.yaml`. Every YAML key and string value is double quoted, including strings inside ID lists. IDs are local to their set.

## Label review

- Each adjacent corpus pair (`M001`/`M002`, through `M149`/`M150`) addresses the same topic under a different condition, target, value, or procedure. These are intentional near misses, not duplicate claims.
- Each query's relevant memory answers its specific question. The questions distinguish the relevant condition from its paired distractor; each query needs one memory.
- Duplicate pairs preserve the complete claim, including conditions, reasons, units, and project identity. Distinct pairs deliberately change a value, timing, role, scope, target, or behavior despite closely matching language. Conflicting values are labelled distinct, as requested.
- All distinct pairs share at least 70% (`dev`) or 75% (`holdout`) of the smaller statement's set of exact content words. This overlap measure checks difficulty, not semantic equivalence.
- Task inclusions were reviewed against the concrete work requested. Exclusions describe a nearby but inapplicable case. The validator checks every reference, list bound, and inclusion's scope visibility.
- The two sets use different organisations, projects, subjects, and statements. There are no personal names, real companies, hostnames, IP addresses, or secrets.

## Vocabulary check

Run `python3 validate_data.py` from this directory (Python 3 with PyYAML). The script reads only these fixture files. `build_data.py` contains the authored source data and regenerates the eight YAML files.

The checker lowercases alphabetic tokens, removes possessive endings, and ignores exactly the stopword list supplied in the brief. Lexical queries must share at least two exact content words with every relevant statement.

For paraphrases, it compares each query against every relevant statement **and its scope metadata**. It rejects exact short content-word overlap and any shared first-four-letter root prefix for longer words, with additional normalization for listed irregular forms such as `built`/`build`, `written`/`write`, and `people`/`person`. The prefix rule deliberately also rejects false-positive similarities such as `planner`/`planting`; the authored wording was revised until all checks passed. Paraphrases use domain descriptions rather than project names. I also reviewed the paraphrases for meaning and morphological overlap; the automated prefix check is a conservative vocabulary screen, not a general semantic stemmer.

All counts, IDs, references, statement lengths, one-sentence formatting, YAML parsing, quoting, lexical overlap, paraphrase overlap, scope visibility, and distinct-pair word overlap were checked. Semantic label correctness and the near-miss relationships were reviewed manually; the script does not claim to prove them or to measure engine retrieval performance.

## Actual validator output

Command: `python3 validate_data.py`

```text
dev: PASS
  memories: 150; scopes: global=30, each of 3 projects=40; observed words: 9-17; single sentences: 150
  near-miss construction: 75 same-scope pairs, covering 150 memories (semantic review manual)
  queries: 80; lexical: 40; paraphrase: 40
  lexical checks: 40/40 share at least 2 exact content words
  paraphrase checks (statement + scope): 40/40 pass; shared content words or four-letter root prefixes: 0
  dedup pairs: 60; duplicate: 30; distinct: 30
  hard distinct pairs: minimum exact-content-word overlap coefficient 70%
  injection tasks: 30; include/exclude references, bounds and scope visibility: PASS
  injection tasks requiring multiple memories: 3
  YAML parsing, all-string quoting, unique IDs and query references: PASS
holdout: PASS
  memories: 150; scopes: global=30, each of 3 projects=40; observed words: 9-18; single sentences: 150
  near-miss construction: 75 same-scope pairs, covering 150 memories (semantic review manual)
  queries: 80; lexical: 40; paraphrase: 40
  lexical checks: 40/40 share at least 2 exact content words
  paraphrase checks (statement + scope): 40/40 pass; shared content words or four-letter root prefixes: 0
  dedup pairs: 60; duplicate: 30; distinct: 30
  hard distinct pairs: minimum exact-content-word overlap coefficient 75%
  injection tasks: 30; include/exclude references, bounds and scope visibility: PASS
  injection tasks requiring multiple memories: 3
  YAML parsing, all-string quoting, unique IDs and query references: PASS
Cross-set checks: distinct project names and no identical memory statements: PASS
```
