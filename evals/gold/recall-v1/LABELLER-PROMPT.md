You are writing LABELLED EVALUATION DATA for a memory engine for AI agents. You have NOT seen its code and must not try to; work only from this brief. The data will be frozen and used to judge whether the engine finds the right memories. Write it carefully: it is the answer key.

Context: the engine stores short "memories" (one-sentence statements an AI coding/work agent was taught: preferences, corrections, conventions, project facts, procedures, infrastructure facts). Users and agents ask questions; the engine should return the memories that answer them.

The promises being judged:
- REC-1: "When I ask about something I taught it, the memory that answers it comes back in the top five."
- REC-2: "A memory worded differently from my question is still found; matching words is not required."
- LRN-3: "Telling apart a real duplicate from a different-but-similar statement is right on a labelled set of pairs."
- INJ-1: "For a given task, my agent is given the memories that matter for it."

Produce TWO independent sets with the SAME format but DIFFERENT content (different fictional organisations, different topics and wording): `dev/` and `holdout/`. Everything must be synthetic and fictional: invented project names, invented people's roles only (no personal names), no real companies, no real hostnames/IPs, no secrets.

For EACH set write four YAML files:

1. `corpus.yaml` — 150 memories:
   memories:
   - id: M001
     scope: global | project:<name>      (use 3 fictional projects + global)
     statement: "<one sentence, 8-30 words>"
   Mix: preferences, corrections ("Use X, not Y, because ..."), conventions, procedures, project facts. Include deliberate NEAR-MISS DISTRACTORS: for at least 40 memories, write another memory on the same topic that answers a DIFFERENT question (e.g. deploy staging vs deploy production; test timeout for unit vs integration).

2. `queries.yaml` — 80 queries:
   queries:
   - id: Q001
     query: "<natural question a user/agent would ask>"
     relevant: [M012]          # the memory/memories that ANSWER it (1-3 ids; all of them must be needed or sufficient answers)
     kind: lexical | paraphrase
   Exactly 40 `lexical` (the query shares at least two content words with its relevant memory) and 40 `paraphrase`. A `paraphrase` query must share NO content word with any of its relevant memories: no shared word stem of 4+ letters after ignoring stopwords (the, a, to, of, in, for, on, with, and, or, is, are, be, we, our, my, i, you, it, this, that, what, how, when, which, should, do, does, can). Use synonyms and describe the situation instead ("ship to customers" vs "release to production"). Each query must have exactly one correct reading; avoid queries where a distractor would also be a correct answer.

3. `dedup_pairs.yaml` — 60 pairs:
   pairs:
   - id: P001
     existing: "<a memory statement>"
     incoming: "<a new statement>"
     label: duplicate | distinct
   30 `duplicate` (same claim, reworded — a careful human would keep only one) and 30 `distinct` (similar wording or topic, but a different claim: different value, different condition, opposite polarity, different project). Make the distinct ones HARD (high word overlap).

4. `inject_tasks.yaml` — 30 tasks over the corpus:
   tasks:
   - id: T001
     task: "<what the agent is about to do, one or two sentences>"
     scope: global | project:<name>
     must_include: [M003, M044]     # 1-4 memories the agent clearly needs for this task
     must_exclude: [M101]           # 0-3 near-miss memories that would be wrong or misleading here
   must_include memories must be in a scope visible to the task (global or the same project).

Then write `CHECKLIST.md` stating, for each set, the counts you produced and how you checked the paraphrase no-shared-word rule (actually check it with a small script and include the script's output).

Output into ./dev/ and ./holdout/ under the current directory. Valid YAML only (quote every string). Do not look anywhere outside the current directory.
