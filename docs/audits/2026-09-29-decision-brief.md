# Decision brief: field report — 2026-09-29

Context for the owner decisions that are still open. The folder-map questions are in
`docs/specs/2026-09-28-folder-map-design.md`. This brief covers the rest. Each section
explains what the thing does today, what each option changes for a user, the risks, and a
recommendation. Two recommendations changed after checking the code this morning; each
says so.

---

## 1. Automatic rating and automatic capture in editor hooks (item 4)

### What exists

plur-hermes, the Python agent plugin, runs two automatic steps after every model reply.
No editor hook (Claude Code, Codex, Cursor, Antigravity) runs either one today.

**Auto-rate.** For each memory that was loaded into the turn, it guesses from the reply
text whether the memory was used:

| Signal in the reply | Verdict | Confidence |
|---|---|---|
| The memory's statement appears word for word | positive | 0.95 |
| ≥80% trigram overlap with the statement | positive | 0.7–1.0 |
| A correction word ("actually", "no,", "wrong,") within 100–200 characters of a word from the memory that is 5+ letters long | negative | 0.65 |

Verdicts with confidence ≥ 0.6 are sent as feedback. Everything else is ignored.

**Auto-capture.** It scans the reply for rule-shaped lines ("always…", "never…",
"from now on…", "the correct way is…") with confidence ≥ 0.7, and saves each match as a new
memory.

### What one piece of feedback does (checked in `core/src/feedback.ts`, `inject.ts`)

- **Positive:**
  - retrieval strength +0.05;
  - the memory ranks up to 30% higher over time;
  - **its commitment moves one step: `exploring`/unset → `leaning` → `decided`.** Two
    automatic thumbs-up turn a tentative memory into a decided one. It never reaches `locked`.
- **Negative:** retrieval strength −0.10, and the memory ranks lower, down to half its score.
- **Team memories:** the feedback is written to the team store, so every teammate's ranking
  changes.

### Risks

- **Auto-rate false positives.** A reply that *quotes* a memory in order to disagree with it
  still counts as positive. That is rare, but it is exactly the case that matters.
- **Auto-rate false negatives.** The correction check is loose. "Actually, let's also run the
  tests" near the word "tests" marks a testing memory as negative. The −0.10 penalty is twice
  the +0.05 reward, so noise pushes memories down more than up.
- **The commitment promotion.** Auto-rate would promote memories to `decided` without anyone
  choosing that. `decided` is shown to agents as a firmer rule.
- **Auto-capture noise.** The model's own prose is full of "always…" and "never…" that aren't
  rules the user gave. In a team scope, that noise reaches everyone.

### Options

| Option | What a user sees | Risk |
|---|---|---|
| **A. Rate on, capture off** (proposed yesterday) | Memories that help climb and memories that mislead sink, with no new memories written unasked. The field-report gap ("no feedback ever") closes. | False negatives push some good memories down. Auto-promotion to `decided` unless we change it. |
| **A′. Rate on, but automatic feedback adjusts ranking only and never commitment**, capture off | Same as A, but commitment changes only from a human or an explicit `plur_feedback` call. | Needs a small core change: feedback gets a `source: auto` that skips `nextCommitment`. |
| **B. Both off, opt-in flag** | No change from today. | Rating never happens by default, which is the field report's complaint. |
| **C. Both on** | Memories are captured from replies. | Team stores fill with prose fragments. |

**Recommendation: A′.** Rate on, capture off, and automatic feedback never moves commitment.
Also tighten the negative rule before shipping: the correction word must sit in the same
sentence as the memory's words, not merely within 200 characters. That keeps the upside
(ranking learns from use) without an unattended heuristic deciding what counts as a rule.
Capture stays opt-in (`PLUR_AUTO_CAPTURE=1`).

---

## 2. opencode in `plur init` (item 6)

**Correction to yesterday.** `@plur-ai/opencode` **is already on npm (0.1.1)**. `plur init`
still refuses to set it up without `--opencode`, and its reason, "not yet published", is out
of date. So most of this is a stale gate, not a publish decision.

**What the plugin does** (design note `docs/specs/2026-09-15-opencode-plugin-design.md`,
verified against opencode 1.18.30):
- loads memories into the system prompt;
- turns corrections into memories;
- scopes by trusted `.plur.yaml`.

It runs in-process, with no hook shim, so there is no Windows command-quoting risk. Two
things it does not do: auto-rate (item 4), and use the folder map (item 3, not built).

| Option | Result |
|---|---|
| **A. Default on when an opencode config folder exists: MCP entry + plugin** | opencode users get memory tools and automatic loading from a plain `plur init`. The MCP entry needs a Windows variant (plain `npx` fails there; same fix as PR #1270). |
| **B. MCP entry by default, plugin stays behind `--opencode`** | Tools work; memory loads only if the agent calls them. |
| **C. Keep opt-in** | No change. |

**Recommendation: A**, as its own PR, including the Windows MCP entry. Check first with a
real opencode run that the published 0.1.1 plugin loads memories (the same codeword test used
for Claude Code). If it fails, fall back to B.

---

## 3. The correction and revert hooks that nothing installs (item 8c)

**Correction to yesterday.** I recommended deleting `hook-correction-detect`, on the
assumption that auto-capture covers the same ground. Reading the code, it does not:

| | `hook-correction-detect` | auto-capture (item 4) |
|---|---|---|
| Reads | **what the user typed** | what the model replied |
| Does | reminds the agent: "this looks like a correction — consider `plur_learn`" | writes a memory itself |
| Writes memories | never; the agent decides | yes, unattended |
| Output shape | already the one Claude Code delivers (`hookSpecificOutput`) | — |
| Cost | regex only; no store load. Mainly Node startup, about 0.15 s per prompt | — |

It targets a known gap: agents acknowledge a correction in prose and never save it. There is
also **`hook-revert-detect`**, a PostToolUse hook that flags revert operations, and nothing
installs that either.

| Option | Result |
|---|---|
| **A. Register correction-detect; fold it into `hook-inject` rather than add a hook** | Corrections get a save reminder at no extra per-prompt process. |
| **B. Register as a separate UserPromptSubmit hook** | Same effect; one more ~0.15 s process per prompt. |
| **C. Delete both** | Less code; the gap stays. |

**Recommendation: A** for correction-detect. Decide revert-detect separately after reading
it; I have not reviewed it yet.

---

## 4. Should a team save still count against a promoted global memory? (PR #1275, item 8a)

**Background: the recurrence ladder.**
- When the same statement is saved again in a different scope, PLUR counts it as a
  **recurrence** of the existing memory instead of making a duplicate.
- From the second recurrence it raises the memory's commitment.
- If the memory was a team memory, it moves it to `global`, on the reasoning that a rule
  that keeps appearing across teams is a general rule.

**The bug #1275 fixes.** A save to `group:x` with the same text as a *personal* memory
was absorbed into the personal one, so nothing reached the team store. #1275 allows a team
save to count only against another team memory.

**The exception.** Once the ladder has promoted a team memory to `global`, it is no longer
a team memory. Under the strict rule, the next team save of the same text would not match
it. It would start a fresh copy in that team scope, which later climbs and gets promoted
again: a duplicate on every lap. The PR therefore lets a team save also count against a
`global` memory **whose first recorded scope was a team scope**, meaning one the ladder
itself promoted.

| Option | Result |
|---|---|
| **A. Keep the exception** | The ladder works as designed. A team save that matches a ladder-promoted global memory does not write to that team's store: the rule is already visible everywhere through global. |
| **B. Remove it** | Every team save always lands in the team store, and duplicates accumulate after each promotion. Three existing ladder tests need new expectations. |

The field report's concern was "saves that stayed on laptops." Under A, the one place that
still happens is when the memory is already global. **Is that acceptable?**
- If a global memory lives only on the laptop, teammates don't see it. It stays local and
  never syncs to the team store.
- So "visible everywhere" really means "everywhere *on this machine*."

**Verified 2026-09-29.** A throwaway test ran against the in-process stub team store. It is
not committed.
- **The ladder rewrites a promoted memory only in the local store** (`index.ts` :2228,
  saved at :2273-2281). A memory served by the team store is never matched and never
  rewritten; url stores are skipped at :1819.
- **With the exception, a later team save matching a locally promoted memory sends nothing
  to the team store.** Only the local count rises. This is the #1268 failure again, in a
  narrower form.
- **A second bug came up.** If the team save was still waiting in the outbox when the ladder
  promoted it, the queue later pushes it to the team store labelled `scope: global`.

**Recommendation: B, plus one guard. This reverses what I said yesterday.**
1. Remove the exception, so a team save always reaches the team store.
2. The ladder must not promote to `global` any memory that is queued for, or served by, a
   team store. The scope change otherwise happens on the laptop and leaks into the team store
   through the outbox.

The three ladder tests that break under B get new expectations. The duplicate a promotion
would have avoided is better handled as a recurrence signal on the memory (#868) than as a
silent merge.

---

## 5. Load memories before the model answers, or in the background? (PR #1276)

**Today.** `plur init` registers the memory-loading hook (`hook-inject`) as **async**
(90 s timeout).
- Claude Code (2.1.284, verified) delivers async context only at the next safe point: after
  a tool call, or at the next prompt.
- So a reply that uses no tools gets no memories, and a one-shot `claude -p` run gets none.

**Measured this morning on a 16 MB store:**
- the first prompt of a session takes **4.6–5.3 s** and injects about 44 KB (~11k tokens);
- a repeat of the same prompt takes 0.15 s.

The first-prompt cost is mostly loading the embedding model and the store.

| Option | Result |
|---|---|
| **A. Sync, with a 3 s deadline** (proposed yesterday) | On a large store the deadline is always hit, so it behaves like async for exactly the users with the most memory. Not recommended. |
| **B. Sync for the first prompt of a session and after compaction; async for later prompts** | The first answer always has memories, at a one-time wait of ~5 s on a large store (<1 s on a small one). Later prompts cost nothing visible. |
| **C. Sync always, 10 s deadline** | Every prompt waits for its lookup. Once #1278 lands, later prompts only load what's new, but that isn't measured yet. |
| **D. Keep async** | No wait. First replies with no tool calls go without memory. |

**Recommendation: B.** It puts the wait where the value is: a session with no memories at
the start is the field report's "no automatic memory" symptom. Later prompts, where the
agent already has context, stay out of the way. Measure C after #1278 before ruling it in.

Related: 44 KB per session start is large. #1278 stops it from repeating on **every** prompt,
which it does today, because the "already loaded" marker never matches.

---

## 6. Item 8b: one secret aborting session-end suggestions

This is already fixed on main: each suggestion is checked on its own, and a failure is listed
without blocking the rest. The only decision is whether to add a regression test that pins
it. **Recommendation:** add the test; it is a few lines.

---

## Summary of recommendations

| # | Decision | Recommendation | Changed since yesterday? |
|---|---|---|---|
| 1 | Auto-rate / auto-capture | Rate on without commitment promotion; tighter negative rule; capture opt-in | refined |
| 2 | opencode | On by default (MCP + plugin) after a codeword check; Windows MCP entry | **yes**, the plugin is already published |
| 3 | correction-detect | Register, folded into hook-inject | **yes**, it was "delete" |
| 4 | #1275 exception | Remove it, and stop the ladder promoting memories that are queued for or served by a team store (verified by test) | **yes**, it was "keep" |
| 5 | Memory loading timing | Sync for the first prompt and after compaction; async after | **yes**, it was "sync, 3 s deadline" |
| 6 | 8b | Add a regression test | — |
