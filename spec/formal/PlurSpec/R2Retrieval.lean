/-!
# PlurSpec.R2Retrieval — round 2: telemetry counters, query rewrite, hybrid labels,
importers, capsule integrity, embedding cache

Models of `packages/core/src/{telemetry-counters.ts, telemetry-flush.ts,
intent/rewrite.ts, search-orchestrator.ts, hybrid-search.ts, query-expansion.ts,
importers/engine.ts, capsule.ts, embeddings.ts}`.
Findings, verdicts and replays: `spec/formal/findings/r2-retrieval.md`.

Checked against the pre-merge audit fixes (commit c0ddc498, 2026-09-27): telemetry-counters.ts
now rolls a stale counters.json over before `settleSpilledEvents` folds today's spills. The
§Spill model counts events per day without dates, so conservation (`conserved`,
`fold_counts_all`) is unaffected; the rollover fix only decides WHICH day's file an event lands in.
-/

namespace PlurSpec.R2Retrieval

/-! ## 1. Telemetry counters conserve events (core-retrieval#7)

One counter (`learn`; `recall` is identical) and dates as `Nat`. The on-disk state is
`counters.json` (`curDate`, `cur`), `pending/<d>.json` (`pend d`, 0 = absent) and the
in-flight flush claims (`inflight d`, the sum of the claim files for `d`). `shipped d`
is what reached the heartbeat endpoint and `recorded d` is a ghost: the events recorded.

Fixed code: every step below runs under the counters lock, so each is atomic. -/
namespace Telemetry

abbrev Date := Nat

structure St where
  curDate : Date
  cur : Nat
  pend : Date → Nat
  inflight : Date → Nat
  shipped : Date → Nat
  recorded : Date → Nat

def upd (f : Date → Nat) (d : Date) (v : Nat) : Date → Nat := fun x => if x = d then v else f x

/-- Everything still on disk for date `d`. -/
def onDisk (s : St) (d : Date) : Nat :=
  s.pend d + s.inflight d + (if d = s.curDate then s.cur else 0)

/-- The invariant: per date, shipped + still on disk = recorded. -/
def Inv (s : St) : Prop := ∀ d, s.recorded d = s.shipped d + onDisk s d

/-- `recordEvent` (locked): rollover moves the snapshot into pending, merging. -/
def record (s : St) (today : Date) : St :=
  if s.curDate = today then
    { s with cur := s.cur + 1, recorded := upd s.recorded today (s.recorded today + 1) }
  else
    { s with pend := upd s.pend s.curDate (s.pend s.curDate + s.cur),
             curDate := today, cur := 1, recorded := upd s.recorded today (s.recorded today + 1) }

/-- `migrateStaleCounters` (locked). -/
def migrate (s : St) (today : Date) : St :=
  if s.curDate < today then
    { s with pend := upd s.pend s.curDate (s.pend s.curDate + s.cur), curDate := today, cur := 0 }
  else s

/-- `claimPending` (locked): rename `<d>.json` to a claim file. -/
def claim (s : St) (d : Date) : St :=
  { s with inflight := upd s.inflight d (s.inflight d + s.pend d), pend := upd s.pend d 0 }

/-- POST ok → `completeClaim`: a claim of `k` for `d` leaves disk and is shipped. -/
def ack (s : St) (d k : Nat) : St :=
  { s with inflight := upd s.inflight d (s.inflight d - k), shipped := upd s.shipped d (s.shipped d + k) }

/-- POST failed → `releaseClaim` (or `recoverOrphanClaims` after a crash): merge back. -/
def fail (s : St) (d k : Nat) : St :=
  { s with inflight := upd s.inflight d (s.inflight d - k), pend := upd s.pend d (s.pend d + k) }

/-- The fixed code's steps. `ack`/`fail` settle a claim that exists (`k ≤ inflight d`). -/
inductive Step : St → St → Prop
  | record (s today) : Step s (record s today)
  | migrate (s today) : Step s (migrate s today)
  | claim (s d) : Step s (claim s d)
  | ack (s d k) : k ≤ s.inflight d → Step s (ack s d k)
  | fail (s d k) : k ≤ s.inflight d → Step s (fail s d k)

theorem step_preserves {s t : St} (h : Step s t) (hi : Inv s) : Inv t := by
  cases h with
  | record today =>
    intro d; have h := hi d; clear hi
    by_cases hc : s.curDate = today <;> by_cases h1 : d = today <;>
      by_cases h2 : d = s.curDate <;>
      simp only [record, onDisk, upd, hc, h1, h2, ↓reduceIte] at h ⊢ <;>
      (try subst h1) <;> (try subst h2) <;> simp_all <;> omega
  | migrate today =>
    intro d; have h := hi d; clear hi
    by_cases hc : s.curDate < today <;> by_cases h1 : d = today <;>
      by_cases h2 : d = s.curDate <;>
      simp [migrate, onDisk, upd, hc, h1, h2] at h ⊢ <;>
      (try subst h1) <;> (try subst h2) <;> simp_all <;> omega
  | claim d0 =>
    intro d; have h := hi d; clear hi
    by_cases h1 : d = d0 <;> (try subst h1) <;> by_cases h2 : d = s.curDate <;>
      (first | simp [claim, onDisk, upd, h1, h2.symm] at h ⊢ | simp [claim, onDisk, upd, h2.symm] at h ⊢ | simp [claim, onDisk, upd, h1, h2] at h ⊢ | simp [claim, onDisk, upd, h2] at h ⊢) <;> omega
  | ack d0 k hk =>
    intro d; have h := hi d; clear hi
    by_cases h1 : d = d0 <;> (try subst h1) <;> by_cases h2 : d = s.curDate <;>
      (first | simp [ack, onDisk, upd, h1, h2.symm] at h ⊢ | simp [ack, onDisk, upd, h2.symm] at h ⊢ | simp [ack, onDisk, upd, h1, h2] at h ⊢ | simp [ack, onDisk, upd, h2] at h ⊢) <;> omega
  | fail d0 k hk =>
    intro d; have h := hi d; clear hi
    by_cases h1 : d = d0 <;> (try subst h1) <;> by_cases h2 : d = s.curDate <;>
      (first | simp [fail, onDisk, upd, h1, h2.symm] at h ⊢ | simp [fail, onDisk, upd, h2.symm] at h ⊢ | simp [fail, onDisk, upd, h1, h2] at h ⊢ | simp [fail, onDisk, upd, h2] at h ⊢) <;> omega

/-- Reflexive-transitive closure of `Step`. -/
inductive Reach : St → St → Prop
  | refl (s) : Reach s s
  | step {s t u} : Step s t → Reach t u → Reach s u

/-- **Fixed code:** from any state satisfying the invariant (e.g. a fresh install),
every interleaving of recorders and flushers conserves events: per date, shipped plus
what is still on disk equals what was recorded. In particular nothing is shipped twice
(`shipped d ≤ recorded d`) and nothing recorded is lost. -/
theorem conserved {s t : St} (hr : Reach s t) (hi : Inv s) : Inv t := by
  induction hr with
  | refl => exact hi
  | step h _ ih => exact ih (step_preserves h hi)

theorem shipped_le_recorded {s t : St} (hr : Reach s t) (hi : Inv s) (d : Date) :
    t.shipped d ≤ t.recorded d := by
  have := conserved hr hi d; omega

def empty : St := ⟨0, 0, fun _ => 0, fun _ => 0, fun _ => 0, fun _ => 0⟩

theorem empty_inv : Inv empty := by intro d; simp only [empty, onDisk]; by_cases h : d = 0 <;> simp [h]

/-- Non-vacuity: three events on day 1, rollover on day 2, claim and a successful POST
ship exactly three for day 1. -/
theorem good_case :
    let s := ack (claim (record (record (record (record empty 1) 1) 1) 2) 1) 1 3
    s.shipped 1 = 3 ∧ s.recorded 1 = 3 ∧ onDisk s 1 = 0 := by decide

/-! ### Pre-fix (no lock, no claim): replayed counterexamples

`recordEvent` was read-then-write with nothing between: a process holds a stale
snapshot `(sd, sc)` across another process's whole call. -/

/-- The write half of pre-fix `recordEvent`, from a snapshot read earlier. -/
def writeFrom (s : St) (sd sc today : Nat) : St :=
  if sd = today then
    { s with curDate := today, cur := sc + 1, recorded := upd s.recorded today (s.recorded today + 1) }
  else
    { s with pend := upd s.pend sd (s.pend sd + sc), curDate := today, cur := 1,
             recorded := upd s.recorded today (s.recorded today + 1) }

def s0 : St := { empty with curDate := 1, cur := 3, recorded := fun d => if d = 1 then 3 else 0 }

/-- Replayed (test (1)): two recorders read the same stale day-1 snapshot (3); both
merge it into pending → pending day 1 = 6, recorded 3. -/
theorem old_rollover_double_counts :
    let s := writeFrom (writeFrom s0 1 3 2) 1 3 2
    Inv s0 ∧ s.pend 1 = 6 ∧ s.recorded 1 = 3 ∧ ¬ Inv s := by
  refine ⟨?_, by decide, by decide, fun h => ?_⟩
  · intro d; simp only [s0, onDisk, empty]; by_cases h : d = 1 <;> simp [h]
  have := h 1; revert this; decide

/-- Replayed (test (2), 122/160 across 4 processes): two same-day recorders read the
same count; one increment is lost. -/
theorem old_same_day_loses :
    let s := writeFrom (writeFrom { empty with curDate := 2 } 2 0 2) 2 0 2
    s.cur = 1 ∧ s.recorded 2 = 2 := by decide

/-- Pre-fix flush: read `pend d`, POST it, then delete the file — no claim. -/
def oldSend (s : St) (d v : Nat) : St := { s with shipped := upd s.shipped d (s.shipped d + v) }
def oldDelete (s : St) (d : Nat) : St := { s with pend := upd s.pend d 0 }

def p1 : St := { empty with curDate := 2, pend := fun d => if d = 1 then 1 else 0,
                            recorded := fun d => if d = 1 then 1 else 0 }

/-- Replayed (test (3)): two flushes read the same pending day and both POST it. -/
theorem old_double_post :
    let s := oldDelete (oldDelete (oldSend (oldSend p1 1 1) 1 1) 1) 1
    s.shipped 1 = 2 ∧ s.recorded 1 = 1 := by decide

/-- Replayed (test (4)): pending day 1 holds 3 and counters.json still holds 2 more for
day 1. A flush reads and POSTs the 3; meanwhile a rollover merges the 2 into pending;
the flush then deletes the file: 3 shipped of 5 recorded, nothing left on disk. -/
theorem old_merge_during_post_lost :
    let p3 : St := { empty with curDate := 1, cur := 2, pend := fun d => if d = 1 then 3 else 0,
                                recorded := fun d => if d = 1 then 5 else 0 }
    let s := oldDelete (record (oldSend p3 1 3) 2) 1
    Inv p3 ∧ s.shipped 1 = 3 ∧ s.recorded 1 = 5 ∧ onDisk s 1 = 0 := by
  refine ⟨?_, by decide, by decide, by decide⟩
  intro d; simp only [onDisk, empty]; by_cases h : d = 1 <;> simp [h]

end Telemetry

/-! ## 2. Lexical rewrite keeps content words (core-retrieval#8)

A whitespace token is a `List Char`. `stripScaffolding` keeps a token iff its core
(the chars of some class) is non-empty and not an interrogative/auxiliary. `word c`
is the class `ftsTokenize` indexes (Unicode L/N/M); `ascii c` the pre-fix `[a-z0-9]`.
Both are oracles; the only assumption is `ascii ⊆ word`. -/
namespace Rewrite

variable (word : Char → Bool) (scaffold : List Char → Bool)

def core (cls : Char → Bool) (w : List Char) : List Char := w.filter cls

/-- `stripScaffolding`'s per-token filter, parameterised by the core's class. -/
def keep (cls : Char → Bool) (w : List Char) : Bool :=
  !(core cls w).isEmpty && !scaffold (core cls w)

def strip (cls : Char → Bool) (ws : List (List Char)) : List (List Char) :=
  ws.filter (keep scaffold cls)

/-- A token BM25 indexes: it has at least one word character. -/
def indexed (w : List Char) : Prop := ∃ c ∈ w, word c = true

/-- **Fixed code:** every token that BM25 indexes and that is not scaffolding survives
the rewrite — for every character-class oracle and every scaffold lexicon. -/
theorem content_kept (ws : List (List Char)) (w : List Char) (hw : w ∈ ws)
    (hi : indexed word w) (hs : scaffold (core word w) = false) :
    w ∈ strip scaffold word ws := by
  obtain ⟨c, hc, hwc⟩ := hi
  have hne : (core word w).isEmpty = false := by
    cases h : core word w with
    | nil =>
      have : c ∈ core word w := List.mem_filter.mpr ⟨hc, hwc⟩
      rw [h] at this; cases this
    | cons _ _ => rfl
  exact List.mem_filter.mpr ⟨hw, by simp [keep, hne, hs]⟩

/-- Non-vacuity: scaffolding is still stripped by the fixed filter. -/
theorem scaffold_dropped (w : List Char) (hs : scaffold (core word w) = true) :
    keep scaffold word w = false := by simp [keep, hs]

/-- Replayed: pre-fix, a CJK token (a word char that is not `[a-z0-9]`) has an empty
ASCII core and is dropped ("What is the 部署 process for kubernetes?" →
"is the process for kubernetes"; the 2-token guard still passes). -/
theorem old_drops_cjk :
    keep (fun _ => false) (fun c => c.isAlphanum) ['部', '署'] = false := by decide

theorem new_keeps_cjk :
    keep (fun _ => false) (fun c => c.isAlphanum || c.val ≥ 128) ['部', '署'] = true := by decide

end Rewrite

/-! ## 3. recallAuto strategy label and expandedSearch limit (core-retrieval#9)

`recallAuto` (search-orchestrator.ts), branch for branch. Search outcomes are inputs:
`hyb = none` is a thrown hybrid search; `some (n, m)` returned `n` results in mode `m`.
`bm25Ok` / `hybOk` are the "≥ 3 results and top BM25 score ≥ 0.3" tests; `llm` is
`none` (no LLM), `some true` (expansion succeeded) or `some false` (it threw). -/
namespace Labels

inductive Mode | hybrid | degraded | bm25Only
  deriving DecidableEq, Repr

inductive Strat | bm25 | hybrid | expanded
  deriving DecidableEq, Repr

/-- Pre-fix: every non-throwing hybrid run is labelled `hybrid`. -/
def labelOld (_ : Mode) : Strat := .hybrid
/-- Fixed `runHybrid`: only a run whose embedding leg ran is `hybrid`. -/
def labelNew : Mode → Strat
  | .hybrid => .hybrid
  | _ => .bm25

def recallAuto (label : Mode → Strat) (empty keyword bm25Ok hybOk : Bool)
    (hyb : Option (Nat × Mode)) (llm : Option Bool) : Strat :=
  if empty then .bm25
  else if keyword then
    if bm25Ok then .bm25
    else match hyb with
      | some (n, m) => if n ≥ 3 then label m else
          (match llm with | some true => .expanded | _ => .bm25)
      | none => (match llm with | some true => .expanded | _ => .bm25)
  else match hyb with
    | none => .bm25
    | some (n, m) =>
      if hybOk then label m
      else match llm with
        | some true => .expanded
        | _ => if n > 0 then label m else .bm25

/-- **Fixed code:** `strategy_used = 'hybrid'` only when a hybrid search ran with its
embedding leg — for every input. -/
theorem hybrid_label_truthful (empty keyword bm25Ok hybOk : Bool) (hyb : Option (Nat × Mode))
    (llm : Option Bool) (h : recallAuto labelNew empty keyword bm25Ok hybOk hyb llm = .hybrid) :
    ∃ n, hyb = some (n, .hybrid) := by
  rcases hyb with _ | ⟨n, m⟩
  · cases empty <;> cases keyword <;> cases bm25Ok <;>
      rcases llm with _ | _ | _ <;> simp [recallAuto] at h
  · refine ⟨n, ?_⟩
    cases m
    · rfl
    all_goals (exfalso; cases empty <;> cases keyword <;> cases bm25Ok <;> cases hybOk <;>
      rcases llm with _ | _ | _ <;> simp [recallAuto, labelNew] at h <;> split at h <;> simp_all)

/-- Non-vacuity: a real hybrid run is still labelled `hybrid`. -/
theorem hybrid_label_reachable :
    recallAuto labelNew false false false true (some (5, .hybrid)) none = .hybrid := rfl

/-- Replayed: pre-fix, a run whose embedder failed is labelled `hybrid`. -/
theorem old_degraded_is_hybrid :
    recallAuto labelOld false false false true (some (5, .degraded)) none = .hybrid := rfl

/-- `expandedSearch`'s return. `agg` = aggregation query. -/
def expandedOld (agg : Bool) (limit : Nat) (merged : List α) : List α :=
  merged.take (if agg then max limit 50 else limit)
def expandedNew (limit : Nat) (merged : List α) : List α := merged.take limit

/-- **Fixed code:** the returned list is capped at the caller's limit (#770 contract),
for every merged list. -/
theorem expanded_capped (limit : Nat) (merged : List α) : (expandedNew limit merged).length ≤ limit := by
  simp [expandedNew]; omega

/-- Non-vacuity: with enough candidates, exactly `limit` come back. -/
theorem expanded_full (limit : Nat) (merged : List α) (h : limit ≤ merged.length) :
    (expandedNew limit merged).length = limit := by simp [expandedNew]; omega

/-- Replayed: pre-fix, an aggregation query with `limit = 5` over 80 candidates
returned 50. -/
theorem old_expanded_leaks : (expandedOld true 5 (List.range 80)).length = 50 := by decide

end Labels

/-! ## 4. Importer dry run predicts the real run (core-retrieval#10)

A record, as the gates see it: its content hash (`none` = unhashable, #896 — every such
statement shares the empty-string hash `empty`), whether the statement/domain/tags carry a
secret, and whether another scanned context field (e.g. `source`) does. `seen` holds the
hashes already in the store or earlier in the run. `learn()` on a YAML-backed store
dedups same-scope AND cross-scope repeats (both reported `skipped`), so the real run's
dedup is scope-blind; a delegating primary store (Postgres/PGLite) is out of scope here
(see findings). -/
namespace Importer

structure Rec where
  hash : Option Nat
  secretMain : Bool
  secretOther : Bool
  deriving DecidableEq, Repr

inductive Act | imported | skipped | error
  deriving DecidableEq, Repr

/-- The real run: `learn()`'s hard scan, then hash dedup (never on an unhashable one). -/
def realStep (seen : List Nat) (r : Rec) : Act × List Nat :=
  if r.secretMain || r.secretOther then (.error, seen)
  else match r.hash with
    | none => (.imported, seen)
    | some k => if k ∈ seen then (.skipped, seen) else (.imported, k :: seen)

/-- Pre-fix dry run: scanned statement/domain/tags only; hashed everything. -/
def oldDryStep (empty : Nat) (seen : List Nat) (r : Rec) : Act × List Nat :=
  if r.secretMain then (.error, seen)
  else
    let k := r.hash.getD empty
    if k ∈ seen then (.skipped, seen) else (.imported, k :: seen)

/-- Fixed dry run: the same context scan, and no dedup for unhashable statements. -/
def newDryStep (seen : List Nat) (r : Rec) : Act × List Nat :=
  if r.secretMain || r.secretOther then (.error, seen)
  else if h : r.hash.isSome then
    let k := r.hash.get h
    if k ∈ seen then (.skipped, seen) else (.imported, k :: seen)
  else (.imported, seen)

def run (step : List Nat → Rec → Act × List Nat) : List Nat → List Rec → List Act
  | _, [] => []
  | seen, r :: rs => let (a, seen') := step seen r; a :: run step seen' rs

theorem newDryStep_eq : newDryStep = realStep := by
  funext seen r
  unfold newDryStep realStep
  rcases r with ⟨_ | k, a, b⟩ <;> simp

/-- **Fixed code:** for every store state and every record sequence, the dry run reports
exactly the actions the real run reports. -/
theorem dry_predicts_real (seen : List Nat) (rs : List Rec) :
    run newDryStep seen rs = run realStep seen rs := by rw [newDryStep_eq]

/-- Non-vacuity: the three outcomes all occur. -/
theorem outcomes_reachable :
    run realStep [7] [⟨some 7, false, false⟩, ⟨some 8, false, false⟩, ⟨some 8, false, false⟩,
                      ⟨none, false, true⟩] = [.skipped, .imported, .skipped, .error] := by decide

/-- Replayed: two unhashable statements — dry `[imported, skipped]`, real both imported. -/
theorem old_unhashable_diverges :
    run (oldDryStep 0) [] [⟨none, false, false⟩, ⟨none, false, false⟩] = [.imported, .skipped] ∧
    run realStep [] [⟨none, false, false⟩, ⟨none, false, false⟩] = [.imported, .imported] := by
  decide

/-- Replayed: a secret in `source` — dry `imported`, real `error`. -/
theorem old_source_secret_diverges :
    run (oldDryStep 0) [] [⟨some 1, false, true⟩] = [.imported] ∧
    run realStep [] [⟨some 1, false, true⟩] = [.error] := by decide

end Importer

/-! ## 5. Capsule integrity check (core-retrieval#11)

`readCapsule`'s acceptance, abstracted: the header carries the payload hash and size, a
`signer` (present or not) and the rest (`info`: name, creator, producer, …). `H` is the
hash oracle (SHA-256). Structural checks (preamble, JSON, schema) are `wf`. -/
namespace Capsule

structure Header where
  sha : Nat
  size : Nat
  signed : Bool      -- header.signer ≠ null
  gzip : Bool
  info : Nat

structure Env where
  flagSigned : Bool
  flagGzip : Bool
  header : Header
  payload : List Nat
  sig : List Nat       -- trailer; 64 bytes when SIGNED

/-- `verifyCapsuleIntegrity` = `readCapsule` does not throw. -/
def verify (H : List Nat → Nat) (wf : Bool) (e : Env) : Bool :=
  wf && (e.flagSigned == e.header.signed) && (!e.flagSigned || e.sig.length == 64)
    && (e.payload.length == e.header.size) && (H e.payload == e.header.sha)
    && (e.flagGzip == e.header.gzip)

/-- **Proved (the docstring's claim 1):** the signature bytes never matter — any two
64-byte trailers give the same answer. -/
theorem signature_ignored (H : List Nat → Nat) (wf : Bool) (e : Env) (s₁ s₂ : List Nat)
    (h₁ : s₁.length = 64) (h₂ : s₂.length = 64) :
    verify H wf { e with sig := s₁ } = verify H wf { e with sig := s₂ } := by
  simp [verify, h₁, h₂]

/-- **Proved (claim 2):** the header is not covered — any header and payload that agree
with each other verify, whatever `info` (name, creator, producer) says. -/
theorem header_not_covered (H : List Nat → Nat) (e : Env) (m : Nat) (hv : verify H true e = true) :
    verify H true { e with header := { e.header with info := m } } = true := by
  simpa [verify] using hv

/-- **Proved (what it does detect):** a payload whose hash differs from the header's is
rejected, for every hash oracle. -/
theorem payload_tamper_detected (H : List Nat → Nat) (wf : Bool) (e : Env)
    (h : H e.payload ≠ e.header.sha) : verify H wf e = false := by
  simp [verify, h]

/-- Non-vacuity: a consistent unsigned capsule verifies. -/
theorem good_verifies :
    verify (fun p => p.length) true ⟨false, true, ⟨3, 3, false, true, 0⟩, [1, 2, 3], []⟩ = true := by
  decide

end Capsule

/-! ## 6. Embedding cache merge (core-retrieval#12)

A cache entry is `(hash, vec)`; an engram's current search text hashes to `cur`. A search
reuses an entry iff its hash equals `cur` (a cache hit), else re-embeds. The export hands
`mergeEmbeddingsIntoCache` only imports verified fresh: `imp.hash = cur`. -/
namespace EmbCache

structure Entry where
  hash : Nat
  vec : Nat
  deriving DecidableEq, Repr

/-- Pre-fix: any existing entry wins. -/
def mergeOld (existing : Option Entry) (imp : Entry) : Option Entry :=
  match existing with
  | some e => some e
  | none => some imp

/-- Fixed: an existing entry wins only when computed from the same text. -/
def mergeNew (existing : Option Entry) (imp : Entry) : Option Entry :=
  match existing with
  | some e => if e.hash = imp.hash then some e else some imp
  | none => some imp

def hit (cur : Nat) : Option Entry → Bool
  | some e => e.hash == cur
  | none => false

/-- **Fixed code:** after merging a fresh import, the next search is a cache hit — for
every prior cache state. (No re-embed of a vector the export already verified.) -/
theorem merge_fresh_hits (cur : Nat) (existing : Option Entry) (imp : Entry) (hf : imp.hash = cur) :
    hit cur (mergeNew existing imp) = true := by
  cases existing with
  | none => simp [mergeNew, hit, hf]
  | some e => by_cases h : e.hash = imp.hash <;> simp [mergeNew, hit, h] <;> simp_all

/-- Non-vacuity / "existing still wins": an equally fresh existing entry is kept. -/
theorem merge_keeps_equal (e imp : Entry) (h : e.hash = imp.hash) :
    mergeNew (some e) imp = some e := by simp [mergeNew, h]

/-- Replayed: pre-fix, a stale existing entry (old text) blocks the verified import;
the next search misses and re-embeds. -/
theorem old_stale_blocks : hit 2 (mergeOld (some ⟨1, 10⟩) ⟨2, 20⟩) = false := by decide

end EmbCache


/-! ## Contended recorders spill instead of dropping (gap closure, 2026-09-27)

`recordEvent` / `settleSpilledEvents` (telemetry-counters.ts). The final full run lost one
event of 160 under load: a recorder that could not take the counters lock within ~1 s
dropped its event. Now it writes the event to its own spill file (temp name, then rename;
no lock) and the next lock holder folds every complete spill file into the counters. One
file per event matters: with one shared spill file an append could land in a copy the
folder had already read and deleted (the second full run lost 1 of 160 that way). State for one day: events in counters.json,
events in the spill. A contended record grows the spill, an uncontended one the counters,
and a fold moves the whole spill into the counters. -/
namespace Spill

structure St where
  counted : Nat
  spilled : Nat
  deriving DecidableEq, Repr

inductive Op where
  | record (contended : Bool)
  | fold

def step (st : St) : Op → St
  | .record true  => { st with spilled := st.spilled + 1 }
  | .record false => { st with counted := st.counted + 1 }
  | .fold         => { counted := st.counted + st.spilled, spilled := 0 }

def recorded : List Op → Nat
  | [] => 0
  | .record _ :: ops => recorded ops + 1
  | .fold :: ops => recorded ops

def run (st : St) : List Op → St
  | [] => st
  | op :: ops => run (step st op) ops

/-- **Conservation:** whatever the interleaving of contended and uncontended records and
folds, counted + spilled = recorded. Nothing is lost and nothing counted twice. -/
theorem conserved (ops : List Op) (st : St) :
    (run st ops).counted + (run st ops).spilled = st.counted + st.spilled + recorded ops := by
  induction ops generalizing st with
  | nil => simp [run, recorded]
  | cons op ops ih =>
    cases op with
    | record c =>
      cases c <;> simp [run, step, recorded, ih] <;> (try omega)
    | fold => simp [run, step, recorded, ih] <;> (try omega)

theorem run_append (st : St) (ops : List Op) (op : Op) :
    run st (ops ++ [op]) = step (run st ops) op := by
  induction ops generalizing st with
  | nil => rfl
  | cons o ops ih => simp [run, ih]

theorem recorded_fold (ops : List Op) : recorded (ops ++ [Op.fold]) = recorded ops := by
  induction ops with
  | nil => rfl
  | cons op ops ih => cases op <;> simp [recorded, ih]

/-- After a final fold every recorded event is in the counters. -/
theorem fold_counts_all (ops : List Op) :
    (run ⟨0, 0⟩ (ops ++ [.fold])).counted = recorded ops := by
  have h := conserved (ops ++ [.fold]) ⟨0, 0⟩
  have hs : (run ⟨0, 0⟩ (ops ++ [.fold])).spilled = 0 := by
    rw [run_append]; rfl
  rw [recorded_fold] at h
  simp at h
  omega

/-- **Old counterexample:** a contended record that drops its event loses it. -/
def stepOld (st : St) : Op → St
  | .record true  => st
  | .record false => { st with counted := st.counted + 1 }
  | .fold         => st

theorem old_drops : (stepOld ⟨0, 0⟩ (.record true)).counted +
    (stepOld ⟨0, 0⟩ (.record true)).spilled = 0 := rfl

end Spill

end PlurSpec.R2Retrieval
