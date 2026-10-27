/-!
# PlurSpec.Provenance — the history hash chain, checkpoints, session manifests (PLUR 0.23)

Models, as the code does it (not as it should), the provenance work landing in 0.23:

* `packages/core/src/history.ts`
  - `appendHistoryStamped`: under the chain lock it reads the predecessor
    (`findPredecessorHash`), sets `prev` to it (null on genesis or when the tail is a
    legacy event), lets `onPrev` build the payload from that same `prev`, then
    `hash = computeEventHash(event)` over the canonical bytes (everything except
    `hash`, `signature`, `signer`). When the lock cannot be taken it declares a gap:
    `prev = null`, `onPrev(null)`, and the event is written anyway. (§1, §2)
  - `appendHistoryBatch`: under the lock, `firstPrev = findPredecessorHash(firstFile)`
    and each event chains onto the one before it, in order; on lock failure
    `firstPrev = null`. Since the F1 fix (commit 50f36cc7) a move into another month
    file that has events re-reads that file's tail under the lock (null without it).
    The head cache is invalidated afterwards, which only sends the next lookup to the
    authoritative tail-seek, so the model reads the head off the log.
    (§3 within one month file; §6 across month files)
  - `emitCheckpoint`: the payload (`chain_head`, `store_hash`, signature) is built inside
    `onPrev`, so `chain_head` is the very `prev` the event chains onto. (§5)
* `packages/core/src/verify-chain.ts` `verifyChain`: per chained event, `hash_mismatch`
  when it does not re-hash to its recorded hash; once a chained event was seen,
  `declared_gap` for `prev = null` and `prev_mismatch` for any other wrong `prev`.
  Legacy events (no hash) are skipped and do not advance the expected `prev`. Forks
  are claims on one `prev`, genesis included (§4). Dangling prev, checkpoint head
  missing and store hash mismatch are not walked here; §5 shows the checkpoint
  head a locked append records is in the log.
* `packages/core/src/session-manifest.ts`: `buildSessionManifest` roles (§7),
  `computeRecordHash` over an abstract covered-field record, `verifySessionManifest`
  (§8).
* `packages/cli/src/commands/verify-manifest.ts` exit codes (§9).
* `packages/core/src/index.ts` `receiptsConfig()` and `packages/mcp/src/tools.ts`
  plur_session_end anchoring (§10).

Hashes are opaque. `computeEventHash` is a function `h : C → Option H → H` of the
canonical content and `prev`; signature and signer are not inputs, so they are not
in the model. Wherever a theorem needs collision freedom it takes `HashInjective h`
(or `RecInjective rh`) as a hypothesis — there is no axiom.

Findings: `spec/formal/findings/provenance-2026-10-27.md`. F2 is documented below as
the counterexample `gap_after_genesis_is_fork` (§4). F1 is fixed; §6 proves the fixed
batch equals single appends across month files under stated conditions, and gives the
two out-of-order cases outside them as counterexamples (`batch_revisit_diverges`,
`batch_empty_month_later_file_diverges`).
-/

namespace PlurSpec.Provenance

/-! ## 1. Events, the hash, the head -/

/-- A history event. `hash = none` is a pre-#1051 legacy event. -/
structure Event (C H : Type) where
  content : C
  prev : Option H
  hash : Option H

/-- `computeEventHash`: a function of the canonical bytes (content and `prev`). -/
abbrev HashFn (C H : Type) := C → Option H → H

/-- Collision freedom on canonical bytes — always a hypothesis, never an axiom. -/
def HashInjective {C H : Type} (h : HashFn C H) : Prop :=
  ∀ c c' p p', h c p = h c' p' → c = c' ∧ p = p'

variable {C H : Type}

/-- An event as `appendHistoryStamped` writes it: `prev` set, then hashed. -/
def stamp (h : HashFn C H) (p : Option H) (c : C) : Event C H := ⟨c, p, some (h c p)⟩

/-- What `findPredecessorHash` returns under the lock (one month file): the last
event's hash, `none` when the log is empty or its tail is a legacy event. -/
def head (l : List (Event C H)) : Option H := l.getLast?.bind Event.hash

theorem head_snoc (l : List (Event C H)) (x : Event C H) : head (l ++ [x]) = x.hash := by
  simp [head]

theorem head_cons_cons (a b : Event C H) (t : List (Event C H)) :
    head (a :: b :: t) = head (b :: t) := by
  simp [head, List.getLast?_cons_cons]

/-! ## 2. Single appends -/

/-- Whether `withLock(history/chain)` was taken. -/
inductive Lock where
  | taken
  | failed
  deriving DecidableEq

/-- The `prev` an append uses: the head under the lock, a declared gap without it. -/
def prevFor (lk : Lock) (l : List (Event C H)) : Option H :=
  match lk with
  | .taken => head l
  | .failed => none

/-- `appendHistoryStamped(root, event, onPrev)`: `onPrev` (here `f`) builds the content
from the `prev` this append uses, on both paths. -/
def appendStamped (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (f : Option H → C) :
    List (Event C H) :=
  l ++ [stamp h (prevFor lk l) (f (prevFor lk l))]

/-- `appendHistory(root, event)`: no `onPrev`. -/
def append (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C) : List (Event C H) :=
  appendStamped h lk l (fun _ => c)

/-- A locked append links to the head it read. -/
theorem locked_append_links (h : HashFn C H) (l : List (Event C H)) (c : C) :
    (append h .taken l c).getLast? = some (stamp h (head l) c) := by
  simp [append, appendStamped, prevFor]

/-- A lock-failure append is a declared gap: `prev = none`, whatever the log holds —
never a link to a tail it could not read under exclusion. -/
theorem failed_append_is_gap (h : HashFn C H) (l : List (Event C H)) (c : C) :
    ∃ e, (append h .failed l c).getLast? = some e ∧ e.prev = none ∧ e.hash = some (h c none) := by
  exact ⟨stamp h none c, by simp [append, appendStamped, prevFor, stamp]⟩

/-! ## 3. Batch appends -/

/-- The loop in `appendHistoryBatch.writeAll`: `ev.prev = prev; ev.hash = …; prev = ev.hash`. -/
def chainFrom (h : HashFn C H) : Option H → List C → List (Event C H)
  | _, [] => []
  | p, c :: cs => stamp h p c :: chainFrom h (some (h c p)) cs

/-- `appendHistoryBatch(root, events)`; `firstPrev` is the head under the lock, null without it. -/
def appendBatch (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (cs : List C) :
    List (Event C H) :=
  l ++ chainFrom h (prevFor lk l) cs

/-- After its first event, a batch continues exactly as a locked batch would. -/
theorem batch_cons (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C) (cs : List C) :
    appendBatch h lk l (c :: cs) = appendBatch h .taken (append h lk l c) cs := by
  simp [appendBatch, append, appendStamped, chainFrom, prevFor, head_snoc, stamp]

/-- Batch equivalence: a locked batch of `[e1..en]` writes exactly the events (same
`prev`, same `hash`) that n locked single appends write. -/
theorem batch_eq_singles (h : HashFn C H) :
    ∀ (cs : List C) (l : List (Event C H)),
      appendBatch h .taken l cs = cs.foldl (fun acc c => append h .taken acc c) l
  | [], l => by simp [appendBatch, chainFrom]
  | c :: cs, l => by
      rw [batch_cons, List.foldl_cons]
      exact batch_eq_singles h cs _

/-- A batch whose lock failed: the first event is a declared gap; every later one links
to the event the batch itself just wrote, never to a tail. -/
theorem failed_batch_first_gap (h : HashFn C H) (l : List (Event C H)) (c : C) (cs : List C) :
    appendBatch h .failed l (c :: cs) = (append h .failed l c) ++ chainFrom h (some (h c none)) cs := by
  simp [appendBatch, append, appendStamped, chainFrom, prevFor, stamp]

/-! ### Chain linkage -/

/-- Every event's `prev` is the hash of the event before it. -/
def Links : List (Event C H) → Prop
  | a :: b :: rest => b.prev = a.hash ∧ Links (b :: rest)
  | _ => True

theorem links_snoc : ∀ (l : List (Event C H)) (x : Event C H),
    Links l → x.prev = head l → Links (l ++ [x])
  | [], _, _, _ => trivial
  | [a], x, _, hx => by
      simp only [List.cons_append, List.nil_append, Links]
      refine ⟨?_, trivial⟩
      simpa [head] using hx
  | a :: b :: t, x, hl, hx => by
      simp only [List.cons_append, Links] at hl ⊢
      refine ⟨hl.1, ?_⟩
      have := links_snoc (b :: t) x hl.2 (by rw [hx, head_cons_cons])
      simpa using this

/-- The writer's operations: one event, or a batch. -/
inductive Op (C : Type) where
  | single (c : C)
  | batch (cs : List C)

def step (h : HashFn C H) (lk : Lock) (l : List (Event C H)) : Op C → List (Event C H)
  | .single c => append h lk l c
  | .batch cs => appendBatch h lk l cs

/-- Any sequence of appends, each with its own lock outcome. -/
def run (h : HashFn C H) (ops : List (Lock × Op C)) (l : List (Event C H)) : List (Event C H) :=
  ops.foldl (fun acc o => step h o.1 acc o.2) l

theorem links_locked_append (h : HashFn C H) (l : List (Event C H)) (c : C) (hl : Links l) :
    Links (append h .taken l c) := by
  simp only [append, appendStamped, prevFor]
  exact links_snoc l _ hl rfl

theorem links_locked_batch (h : HashFn C H) :
    ∀ (cs : List C) (l : List (Event C H)), Links l → Links (appendBatch h .taken l cs)
  | [], l, hl => by simpa [appendBatch, chainFrom] using hl
  | c :: cs, l, hl => by
      rw [batch_cons]
      exact links_locked_batch h cs _ (links_locked_append h l c hl)

/-- Chain linkage: after any sequence of locked appends, single or batch, every
event's `prev` is the hash of the event before it. -/
theorem locked_run_links (h : HashFn C H) :
    ∀ (ops : List (Lock × Op C)) (l : List (Event C H)),
      (∀ o ∈ ops, o.1 = .taken) → Links l → Links (run h ops l)
  | [], l, _, hl => hl
  | (lk, o) :: ops, l, hall, hl => by
      have hlk : lk = .taken := hall (lk, o) (by simp)
      subst hlk
      simp only [run, List.foldl_cons]
      apply locked_run_links h ops _ (fun o' ho' => hall o' (by simp [ho']))
      cases o with
      | single c => exact links_locked_append h l c hl
      | batch cs => exact links_locked_batch h cs l hl

/-! ### Sealed, and links-or-gap, under any lock outcome -/

/-- Every event carries the hash of its own canonical bytes. -/
def Sealed (h : HashFn C H) (l : List (Event C H)) : Prop :=
  ∀ e ∈ l, e.hash = some (h e.content e.prev)

/-- Every event links to its predecessor, or declares a gap. -/
def LinksOrGap : List (Event C H) → Prop
  | a :: b :: rest => (b.prev = a.hash ∨ b.prev = none) ∧ LinksOrGap (b :: rest)
  | _ => True

theorem linksOrGap_snoc : ∀ (l : List (Event C H)) (x : Event C H),
    LinksOrGap l → (x.prev = head l ∨ x.prev = none) → LinksOrGap (l ++ [x])
  | [], _, _, _ => trivial
  | [a], x, _, hx => by
      simp only [List.cons_append, List.nil_append, LinksOrGap]
      refine ⟨?_, trivial⟩
      simpa [head] using hx
  | a :: b :: t, x, hl, hx => by
      simp only [List.cons_append, LinksOrGap] at hl ⊢
      refine ⟨hl.1, ?_⟩
      have := linksOrGap_snoc (b :: t) x hl.2 (by rw [← head_cons_cons a]; exact hx)
      simpa using this

theorem sealed_append (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C)
    (hs : Sealed h l) : Sealed h (append h lk l c) := by
  intro e he
  simp only [append, appendStamped, List.mem_append, List.mem_singleton] at he
  rcases he with he | he
  · exact hs e he
  · subst he; rfl

theorem linksOrGap_append (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C)
    (hl : LinksOrGap l) : LinksOrGap (append h lk l c) := by
  simp only [append, appendStamped]
  apply linksOrGap_snoc l _ hl
  cases lk with
  | taken => exact Or.inl rfl
  | failed => exact Or.inr rfl

theorem batch_inv (h : HashFn C H) :
    ∀ (cs : List C) (lk : Lock) (l : List (Event C H)),
      Sealed h l → LinksOrGap l → Sealed h (appendBatch h lk l cs) ∧ LinksOrGap (appendBatch h lk l cs)
  | [], lk, l, hs, hl => by simpa [appendBatch, chainFrom] using And.intro hs hl
  | c :: cs, lk, l, hs, hl => by
      rw [batch_cons]
      exact batch_inv h cs .taken _ (sealed_append h lk l c hs) (linksOrGap_append h lk l c hl)

/-- Any interleaving of locked and failed-lock appends, single or batch, keeps every
event sealed and every link either correct or a declared gap. -/
theorem run_inv (h : HashFn C H) :
    ∀ (ops : List (Lock × Op C)) (l : List (Event C H)),
      Sealed h l → LinksOrGap l → Sealed h (run h ops l) ∧ LinksOrGap (run h ops l)
  | [], l, hs, hl => ⟨hs, hl⟩
  | (lk, o) :: ops, l, hs, hl => by
      simp only [run, List.foldl_cons]
      cases o with
      | single c =>
          exact run_inv h ops _ (sealed_append h lk l c hs) (linksOrGap_append h lk l c hl)
      | batch cs =>
          have := batch_inv h cs lk l hs hl
          exact run_inv h ops _ this.1 this.2

/-! ## 4. Verification (`verifyChain`) -/

inductive Reason where
  | hashMismatch
  | prevMismatch
  | declaredGap
  deriving DecidableEq

/-- The walk in `verifyChain`: `st` is `expectedPrev` once a chained event was seen
(`none` = `sawFirstChained` false); `i` is the global index, legacy events included. -/
def walk [DecidableEq H] (h : HashFn C H) : Option H → Nat → List (Event C H) → List (Nat × Reason)
  | _, _, [] => []
  | st, i, e :: rest =>
    match e.hash with
    | none => walk h st (i + 1) rest
    | some r =>
      (if h e.content e.prev = r then [] else [(i, Reason.hashMismatch)]) ++
      (match st with
       | none => []
       | some ep =>
         if e.prev = some ep then []
         else [(i, if e.prev = none then Reason.declaredGap else Reason.prevMismatch)]) ++
      walk h (some r) (i + 1) rest

section Walk
variable [DecidableEq H]

/-- What the first event may carry, given the expected prev. -/
def StartOk (st : Option H) (l : List (Event C H)) : Prop :=
  ∀ a, l.head? = some a → ∀ r, st = some r → a.prev = some r ∨ a.prev = none

def StartExact (st : Option H) (l : List (Event C H)) : Prop :=
  ∀ a, l.head? = some a → ∀ r, st = some r → a.prev = some r

theorem walk_clean (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st : Option H) (i : Nat),
      Sealed h l → Links l → StartExact st l → walk h st i l = []
  | [], _, _, _, _, _ => rfl
  | a :: t, st, i, hs, hl, hst => by
      have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
      have hs' : Sealed h t := fun e he => hs e (by simp [he])
      have hl' : Links t := by
        cases t with
        | nil => trivial
        | cons b t => exact hl.2
      have hst' : StartExact (some (h a.content a.prev)) t := by
        intro b hb r hr
        cases t with
        | nil => simp at hb
        | cons b' t =>
            simp at hb; subst hb
            have := hl.1
            rw [this, ha]; simpa using hr
      have rest := walk_clean h t (some (h a.content a.prev)) (i + 1) hs' hl' hst'
      cases st with
      | none => simp [walk, ha, rest]
      | some r =>
          have hp : a.prev = some r := hst a (by simp) r rfl
          rw [hp] at rest
          simp [walk, ha, rest, hp]

/-- A log written only by locked appends (from empty) verifies with no break. -/
theorem locked_run_verifies (h : HashFn C H) (ops : List (Lock × Op C))
    (hall : ∀ o ∈ ops, o.1 = .taken) :
    walk h none 0 (run h ops []) = [] :=
  walk_clean h _ none 0 (run_inv h ops [] (by intro e he; simp at he) trivial).1
    (locked_run_links h ops [] hall trivial) (by intro a _ r hr; cases hr)

/-- Under any interleaving of lock outcomes, every break reported is a declared gap:
a lock failure is never reported as tampering. -/
theorem walk_only_gaps (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st : Option H) (i : Nat),
      Sealed h l → LinksOrGap l → StartOk st l → ∀ b ∈ walk h st i l, b.2 = .declaredGap
  | [], _, _, _, _, _ => by intro b hb; simp [walk] at hb
  | a :: t, st, i, hs, hl, hst => by
      have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
      have hs' : Sealed h t := fun e he => hs e (by simp [he])
      have hl' : LinksOrGap t := by
        cases t with
        | nil => trivial
        | cons b t => exact hl.2
      have hst' : StartOk (some (h a.content a.prev)) t := by
        intro b hb r hr
        cases t with
        | nil => simp at hb
        | cons b' t =>
            simp at hb; subst hb
            rcases hl.1 with h1 | h1
            · left; rw [h1, ha]; simpa using hr
            · right; exact h1
      have rest := walk_only_gaps h t (some (h a.content a.prev)) (i + 1) hs' hl' hst'
      intro b hb
      cases st with
      | none =>
          simp [walk, ha] at hb
          exact rest b hb
      | some r =>
          rcases hst a (by simp) r rfl with hp | hp
          · rw [hp] at rest
            simp [walk, ha, hp] at hb
            exact rest b hb
          · rw [hp] at rest
            simp [walk, ha, hp] at hb
            rcases hb with hb | hb
            · subst hb; rfl
            · exact rest b hb

theorem any_run_only_gaps (h : HashFn C H) (ops : List (Lock × Op C)) :
    ∀ b ∈ walk h none 0 (run h ops []), b.2 = .declaredGap := by
  have := run_inv h ops [] (by intro e he; simp at he) trivial
  exact walk_only_gaps h _ none 0 this.1 this.2 (by intro a _ r hr; cases hr)

/-- The tampering the walk reports at index `i + k`. -/
theorem walk_mem_mismatch (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st : Option H) (i k : Nat) (e : Event C H) (r : H),
      l[k]? = some e → e.hash = some r → h e.content e.prev ≠ r →
      (i + k, Reason.hashMismatch) ∈ walk h st i l
  | [], _, _, _, _, _, hk, _, _ => by simp at hk
  | a :: t, st, i, 0, e, r, hk, he, hne => by
      simp at hk; subst hk
      simp [walk, he, hne]
  | a :: t, st, i, k + 1, e, r, hk, he, hne => by
      simp at hk
      have ih := walk_mem_mismatch h t
      rw [show i + (k + 1) = (i + 1) + k by omega]
      cases ha : a.hash with
      | none => simp [walk, ha]; exact ih st (i + 1) k e r hk he hne
      | some ra =>
          simp only [walk, ha, List.mem_append]
          right; exact ih _ (i + 1) k e r hk he hne

/-- Tamper detection: change the content of event `k` of a sealed log without
recomputing its hash, and verification reports a hash mismatch at that event
(hash injective on canonical bytes). -/
theorem tamper_detected (h : HashFn C H) (hinj : HashInjective h) (l : List (Event C H))
    (hs : Sealed h l) (k : Nat) (e : Event C H) (hk : l[k]? = some e) (c' : C)
    (hc : c' ≠ e.content) (st : Option H) (i : Nat) :
    (i + k, Reason.hashMismatch) ∈ walk h st i (l.set k { e with content := c' }) := by
  have hlen : k < l.length := by
    rcases List.getElem?_eq_some_iff.mp hk with ⟨hl, _⟩; exact hl
  have he : e.hash = some (h e.content e.prev) := hs e (List.mem_of_getElem? hk)
  apply walk_mem_mismatch h _ st i k { e with content := c' } (h e.content e.prev)
  · simp [hlen]
  · exact he
  · intro heq
    exact hc (hinj _ _ _ _ heq).1

/-! ### Where a gap lands, exactly -/

/-- The expected prev after walking a list. -/
def lastChained : Option H → List (Event C H) → Option H
  | st, [] => st
  | st, e :: rest => lastChained (match e.hash with | none => st | some r => some r) rest

theorem walk_append (h : HashFn C H) :
    ∀ (l m : List (Event C H)) (st : Option H) (i : Nat),
      walk h st i (l ++ m) = walk h st i l ++ walk h (lastChained st l) (i + l.length) m
  | [], m, st, i => by simp [walk, lastChained]
  | a :: t, m, st, i => by
      have ih := walk_append h t m
      cases ha : a.hash with
      | none =>
          simp [walk, ha, lastChained, ih, Nat.add_assoc, Nat.add_comm 1]
      | some r =>
          simp [walk, ha, lastChained, ih, Nat.add_assoc, Nat.add_comm 1]

omit [DecidableEq H] in
theorem lastChained_sealed (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st : Option H), Sealed h l → l ≠ [] → lastChained st l = head l
  | [], _, _, hne => absurd rfl hne
  | [a], st, hs, _ => by
      have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
      simp [lastChained, ha, head]
  | a :: b :: t, st, hs, _ => by
      have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
      have := lastChained_sealed h (b :: t) (some (h a.content a.prev))
        (fun e he => hs e (List.mem_cons_of_mem a he)) (by simp)
      simp only [lastChained, ha] at this ⊢
      rw [this, head_cons_cons]

/-- One lock failure after a clean non-empty chain: exactly one break, at the gap
event, reason `declared_gap`. -/
theorem single_gap_reported (h : HashFn C H) (l : List (Event C H)) (c : C)
    (hs : Sealed h l) (hl : Links l) (hne : l ≠ []) :
    walk h none 0 (append h .failed l c) = [(l.length, Reason.declaredGap)] := by
  have hclean := walk_clean h l none 0 hs hl (by intro a _ r hr; cases hr)
  have hhead : ∃ r, head l = some r := by
    cases hlast : l.getLast? with
    | none => simp at hlast; exact absurd hlast hne
    | some x =>
        have hx : x ∈ l := List.mem_of_getLast? hlast
        exact ⟨h x.content x.prev, by simp [head, hlast, hs x hx]⟩
  rcases hhead with ⟨r, hr⟩
  simp only [append, appendStamped, prevFor]
  rw [walk_append, hclean, lastChained_sealed h l none hs hne, hr]
  simp [walk, stamp]

end Walk

/-! ### Forks — documented counterexample (finding F2)

`verifyChain` keys every chained event under its `prev`, genesis (`prev = null`)
included, and reports a fork for any key claimed twice. A declared gap also has
`prev = null`, so one lock failure in a store whose first event is genesis is
reported as a FORK of the genesis event and the gap event, besides the
`declared_gap` break — although no two events claim one predecessor. Not tampering
(a fork is its own outcome), but a mislabel. -/

def HasFork (l : List (Event C H)) : Prop :=
  ∃ (i j : Nat) (a b : Event C H), i < j ∧ l[i]? = some a ∧ l[j]? = some b ∧
    a.hash.isSome ∧ b.hash.isSome ∧ a.prev = b.prev

theorem gap_after_genesis_is_fork (h : HashFn C H) (a : Event C H) (t : List (Event C H)) (c : C)
    (hs : Sealed h (a :: t)) (hg : a.prev = none) :
    HasFork (append h .failed (a :: t) c) := by
  have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
  refine ⟨0, (a :: t).length, a, stamp h none c, by simp, ?_, ?_, ?_, ?_, ?_⟩
  · simp [append, appendStamped]
  · simp [append, appendStamped, prevFor]
  · simp [ha]
  · simp [stamp]
  · simp [stamp, hg]

/-! ## 5. Checkpoints (`emitCheckpoint`) -/

/-- The appended event's content was built from its own `prev` — on both lock paths.
For a checkpoint, `f p = {chain_head := p, store_hash, …}`, so `chain_head = prev`. -/
theorem stamped_content_from_prev (h : HashFn C H) (lk : Lock) (l : List (Event C H))
    (f : Option H → C) :
    ∃ e, (appendStamped h lk l f).getLast? = some e ∧ e.content = f e.prev := by
  exact ⟨stamp h (prevFor lk l) (f (prevFor lk l)), by simp [appendStamped], rfl⟩

structure CheckpointData (H S : Type) where
  chain_head : Option H
  store_hash : S

theorem checkpoint_head_is_prev {S : Type} (h : HashFn (CheckpointData H S) H) (lk : Lock)
    (l : List (Event (CheckpointData H S) H)) (s : S) :
    ∃ e, (appendStamped h lk l (fun p => ⟨p, s⟩)).getLast? = some e ∧
      e.content.chain_head = e.prev := by
  rcases stamped_content_from_prev h lk l (fun p => ⟨p, s⟩) with ⟨e, he, hc⟩
  exact ⟨e, he, by rw [hc]⟩

/-- The head a locked checkpoint pins is carried by an event already in the log, so
`checkpoint_head_missing` cannot fire on an untouched log. -/
theorem checkpoint_head_present (l : List (Event C H)) (r : H) (hr : prevFor .taken l = some r) :
    ∃ e ∈ l, e.hash = some r := by
  simp only [prevFor, head] at hr
  cases hlast : l.getLast? with
  | none => simp [hlast] at hr
  | some x =>
      refine ⟨x, List.mem_of_getLast? hlast, ?_⟩
      simpa [hlast] using hr

/-! ## 6. Month files (the fixed `appendHistoryBatch`, commit 50f36cc7)

The history directory is one event list per month (`Files`); `N` bounds every month
that has a file. An empty list stands for a missing file. (The code would also list
an existing EMPTY file in its directory walk and read a null tail from it; the model
treats such a file as missing.)

`findPred` is `findPredecessorHash(dir, file)` under the chain lock, where the
validated cache and sidecar can only return the true tail, so it is the tail-seek:
the tail of the event's own month file when that file has events, otherwise the
tail of the newest OTHER month file (`newestBelow`: months newest first, the current
one skipped, the first file found decides — a legacy tail gives null, no further
walk).

The fixed batch (`bstep`): the first event's `prev` is `findPred` of its month.
When the month changes to one this batch has not written and whose file has events,
`prev` is re-read with `findPred` (that file's own tail; files are written only after
the loop, so the read sees the disk as it was). Otherwise — same month, a month the
batch already wrote, or an empty/missing file — the chain continues from the batch's
previous event.

Proved (`batch_eq_singles_months`): with the batch's months non-decreasing and, at
each move into an empty month file, no file with events in a later month than the
one the batch is leaving (`SwitchOk`), a locked batch leaves every month file exactly
as n single locked appends do. Not covered, and shown to diverge:
`batch_revisit_diverges` (the batch returns to a month it already wrote) and
`batch_empty_month_later_file_diverges` (it moves into an empty month while a later
month file has events). Both need out-of-order timestamps; the one caller,
`recordIdRenames`, stamps a whole batch with one timestamp. -/

abbrev Files (C H : Type) := Nat → List (Event C H)

/-- The newest month below `k` other than `m` whose file has events: its tail. -/
def newestBelow (S : Files C H) (m : Nat) : Nat → Option H
  | 0 => none
  | k + 1 => if k ≠ m ∧ (S k).isEmpty = false then head (S k) else newestBelow S m k

/-- `findPredecessorHash` under the lock, per month file. -/
def findPred (S : Files C H) (N m : Nat) : Option H :=
  if (S m).isEmpty then newestBelow S m N else head (S m)

/-- Append one event to month `m`'s file. -/
def upd (S : Files C H) (m : Nat) (e : Event C H) : Files C H :=
  fun k => if k = m then S k ++ [e] else S k

/-- One single locked `appendHistory` of an event with month `x.1`. -/
def sstep (h : HashFn C H) (N : Nat) (S : Files C H) (x : Nat × C) : Files C H :=
  upd S x.1 (stamp h (findPred S N x.1) x.2)

def singleFiles (h : HashFn C H) (N : Nat) (D : Files C H) (evs : List (Nat × C)) : Files C H :=
  evs.foldl (sstep h N) D

/-- The loop state of `writeAll`: what will be written, `month`, `prev`, `byMonth`'s keys. -/
structure BState (C H : Type) where
  files : Files C H
  month : Nat
  prev : Option H
  visited : List Nat

/-- The `prev` the fixed loop gives an event of month `m` (`D` = the disk before the batch). -/
def bprev (D : Files C H) (N : Nat) (s : BState C H) (m : Nat) : Option H :=
  if m ≠ s.month ∧ m ∉ s.visited ∧ (D m).isEmpty = false then findPred D N m else s.prev

def bstep (h : HashFn C H) (D : Files C H) (N : Nat) (s : BState C H) (x : Nat × C) : BState C H :=
  { files := upd s.files x.1 (stamp h (bprev D N s x.1) x.2), month := x.1,
    prev := some (h x.2 (bprev D N s x.1)), visited := x.1 :: s.visited }

/-- A locked `appendHistoryBatch`: `firstPrev = findPred` of the first event's month. -/
def batchFiles (h : HashFn C H) (D : Files C H) (N : Nat) : List (Nat × C) → Files C H
  | [] => D
  | x :: xs => ((x :: xs).foldl (bstep h D N) ⟨D, x.1, findPred D N x.1, []⟩).files

/-- At every move into an empty month file, no later month file has events. -/
def SwitchOk (D : Files C H) : Nat → List (Nat × C) → Prop
  | _, [] => True
  | mp, x :: xs =>
      (mp < x.1 → (D x.1).isEmpty = true → ∀ k, mp < k → k ≠ x.1 → D k = []) ∧ SwitchOk D x.1 xs

theorem newestBelow_eq (S : Files C H) (m j : Nat) (hj : j ≠ m) (hS : (S j).isEmpty = false)
    (hlater : ∀ k, j < k → k ≠ m → S k = []) :
    ∀ n, j < n → newestBelow S m n = head (S j)
  | 0, hn => absurd hn (Nat.not_lt_zero _)
  | n + 1, hn => by
      by_cases hnj : n = j
      · subst hnj; simp [newestBelow, hj, hS]
      · have hjn : j < n := by omega
        have hempty : ¬ (n ≠ m ∧ (S n).isEmpty = false) := by
          intro ⟨hnm, hne⟩
          rw [hlater n hjn hnm] at hne; simp at hne
        simp only [newestBelow, hempty, ↓reduceIte]
        exact newestBelow_eq S m j hj hS hlater n hjn

theorem findPred_tail (S : Files C H) (N m : Nat) (h : (S m).isEmpty = false) :
    findPred S N m = head (S m) := by
  simp [findPred, h]

theorem upd_self (S : Files C H) (m : Nat) (e : Event C H) : upd S m e m = S m ++ [e] := by
  simp [upd]

theorem findPred_upd_self (S : Files C H) (N m : Nat) (e : Event C H) :
    findPred (upd S m e) N m = e.hash := by
  unfold findPred; rw [upd_self]; simp [head]

theorem upd_ne (S : Files C H) (m k : Nat) (e : Event C H) (hk : k ≠ m) : upd S m e k = S k := by
  simp [upd, hk]

/-- The simulation: the batch's state against the single appends' files. -/
def Inv (D : Files C H) (N : Nat) (s : BState C H) (S : Files C H) : Prop :=
  s.files = S ∧ s.prev = findPred S N s.month ∧ (∀ k, k ∉ s.visited → S k = D k) ∧
    (∀ k ∈ s.visited, k ≤ s.month) ∧ (S s.month).isEmpty = false ∧ s.month < N

theorem bprev_eq (D : Files C H) (N : Nat) (s : BState C H) (S : Files C H) (m : Nat)
    (hi : Inv D N s S) (hle : s.month ≤ m) (hm : m < N)
    (hsw : s.month < m → (D m).isEmpty = true → ∀ k, s.month < k → k ≠ m → D k = []) :
    bprev D N s m = findPred S N m := by
  obtain ⟨_, hprev, hun, hvis, hne, hN⟩ := hi
  by_cases hsame : m = s.month
  · subst hsame; simp [bprev, hprev]
  · have hlt : s.month < m := by omega
    have hnv : m ∉ s.visited := fun hv => by have := hvis m hv; omega
    have hSm : S m = D m := hun m hnv
    cases hD : (D m).isEmpty with
    | false =>
        have hS' : (S m).isEmpty = false := by rw [hSm]; exact hD
        simp [bprev, hsame, hnv, hD, findPred_tail D N m hD, findPred_tail S N m hS', hSm]
    | true =>
        have hSe : (S m).isEmpty = true := by rw [hSm]; exact hD
        have hcond : ¬ (m ≠ s.month ∧ m ∉ s.visited ∧ (D m).isEmpty = false) := by
          rintro ⟨_, _, h3⟩; rw [hD] at h3; cases h3
        simp only [bprev, hcond, ↓reduceIte]
        rw [hprev, findPred_tail S N s.month hne]
        simp only [findPred, hSe, ↓reduceIte]
        refine (newestBelow_eq S m s.month (Ne.symm hsame) hne ?_ N hN).symm
        intro k hk hkm
        have hkv : k ∉ s.visited := fun hv => by have := hvis k hv; omega
        rw [hun k hkv]; exact hsw hlt hD k hk hkm

theorem inv_step (h : HashFn C H) (D : Files C H) (N : Nat) (s : BState C H) (S : Files C H)
    (x : Nat × C) (hi : Inv D N s S) (hle : s.month ≤ x.1) (hm : x.1 < N)
    (hsw : s.month < x.1 → (D x.1).isEmpty = true → ∀ k, s.month < k → k ≠ x.1 → D k = []) :
    Inv D N (bstep h D N s x) (sstep h N S x) := by
  have hp := bprev_eq D N s S x.1 hi hle hm hsw
  obtain ⟨hf, _, hun, hvis, _, _⟩ := hi
  refine ⟨?_, ?_, ?_, ?_, ?_, hm⟩
  · simp [bstep, sstep, hf, hp]
  · simp only [bstep, sstep, findPred_upd_self, stamp, hp]
  · intro k hk
    simp only [bstep, List.mem_cons, not_or] at hk
    simp only [sstep]; rw [upd_ne _ _ _ _ hk.1]; exact hun k hk.2
  · intro k hk
    simp only [bstep, List.mem_cons] at hk
    rcases hk with hk | hk
    · simp [bstep, hk]
    · have := hvis k hk; simp only [bstep]; omega
  · simp [bstep, sstep, upd_self]

theorem sim (h : HashFn C H) (D : Files C H) (N : Nat) :
    ∀ (xs : List (Nat × C)) (s : BState C H) (S : Files C H),
      Inv D N s S → (∀ e ∈ xs, s.month ≤ e.1 ∧ e.1 < N) →
      xs.Pairwise (fun a b => a.1 ≤ b.1) → SwitchOk D s.month xs →
      (xs.foldl (bstep h D N) s).files = xs.foldl (sstep h N) S
  | [], s, S, hi, _, _, _ => hi.1
  | x :: xs, s, S, hi, hb, hp, hsw => by
      simp only [List.foldl_cons]
      have hx := hb x (by simp)
      have hi' := inv_step h D N s S x hi hx.1 hx.2 hsw.1
      apply sim h D N xs _ _ hi'
      · intro e he
        exact ⟨by simp only [bstep]; exact (List.pairwise_cons.mp hp).1 e he, (hb e (by simp [he])).2⟩
      · exact (List.pairwise_cons.mp hp).2
      · simpa [bstep] using hsw.2

/-- Batch equivalence across month files: a locked batch whose months are in order,
and which never moves into an empty month file while a later month file has events,
leaves every month file exactly as n single locked appends do. -/
theorem batch_eq_singles_months (h : HashFn C H) (D : Files C H) (N : Nat) (x : Nat × C)
    (xs : List (Nat × C)) (hN : ∀ e ∈ x :: xs, e.1 < N)
    (hp : (x :: xs).Pairwise (fun a b => a.1 ≤ b.1)) (hsw : SwitchOk D x.1 xs) :
    batchFiles h D N (x :: xs) = singleFiles h N D (x :: xs) := by
  simp only [batchFiles, singleFiles, List.foldl_cons]
  have h0 : bprev D N ⟨D, x.1, findPred D N x.1, []⟩ x.1 = findPred D N x.1 := by simp [bprev]
  have hi : Inv D N (bstep h D N ⟨D, x.1, findPred D N x.1, []⟩ x) (sstep h N D x) := by
    refine ⟨by simp only [bstep, sstep, h0], ?_, ?_, ?_, ?_, hN x (by simp)⟩
    · simp only [bstep, sstep, h0, findPred_upd_self, stamp]
    · intro k hk
      simp only [bstep, List.mem_cons, not_or] at hk
      simp only [sstep]; rw [upd_ne _ _ _ _ hk.1]
    · intro k hk; simp [bstep] at hk; simp [bstep, hk]
    · simp [bstep, sstep, upd_self]
  apply sim h D N xs _ _ hi
  · intro e he
    exact ⟨by simp only [bstep]; exact (List.pairwise_cons.mp hp).1 e he, hN e (by simp [he])⟩
  · exact (List.pairwise_cons.mp hp).2
  · simpa [bstep] using hsw

/-- Not covered: a batch that returns to a month it already wrote continues from its
previous event, while a single append links to that month file's tail. -/
theorem batch_revisit_diverges (h : HashFn C H) (hinj : HashInjective h) (D : Files C H)
    (N m1 m2 : Nat) (c1 c2 c3 : C) (hm : m1 ≠ m2) (h2 : (D m2).isEmpty = false) (hc : c1 ≠ c2) :
    batchFiles h D N [(m1, c1), (m2, c2), (m1, c3)] ≠ singleFiles h N D [(m1, c1), (m2, c2), (m1, c3)] := by
  intro heq
  have := congrArg (fun F => ((F m1).getLast?).map Event.prev) heq
  simp [batchFiles, singleFiles, bstep, sstep, bprev, upd, findPred, hm, Ne.symm hm, h2, stamp,
    head] at this
  exact hc (hinj _ _ _ _ this.symm).1

/-- Not covered: a batch moving into an empty month file continues from its previous
event, while a single append falls back to the newest other month file — a LATER one
here, when it has events. -/
theorem batch_empty_month_later_file_diverges (h : HashFn C H) (D : Files C H)
    (N m1 m2 m3 : Nat) (c1 c2 : C) (h12 : m1 < m2) (h23 : m2 < m3) (h3N : m3 < N)
    (hD2 : D m2 = []) (hD3 : (D m3).isEmpty = false) (hlater : ∀ k, m3 < k → k ≠ m2 → D k = [])
    (hdiff : head (D m3) ≠ some (h c1 (findPred D N m1))) :
    ((batchFiles h D N [(m1, c1), (m2, c2)] m2).getLast?).map Event.prev ≠
      ((singleFiles h N D [(m1, c1), (m2, c2)] m2).getLast?).map Event.prev := by
  have h21 : m2 ≠ m1 := by omega
  generalize hp1 : findPred D N m1 = p1 at *
  have e2 : upd D m1 (stamp h p1 c1) m2 = [] := by rw [upd_ne _ _ _ _ h21, hD2]
  have e3 : upd D m1 (stamp h p1 c1) m3 = D m3 := upd_ne _ _ _ _ (by omega)
  have hS1 : findPred (upd D m1 (stamp h p1 c1)) N m2 = head (D m3) := by
    unfold findPred
    simp only [e2, List.isEmpty_nil, ↓reduceIte]
    rw [newestBelow_eq _ m2 m3 (by omega) (by rw [e3]; exact hD3) ?_ N h3N, e3]
    intro k hk hkm
    rw [upd_ne _ _ _ _ (by omega)]; exact hlater k hk hkm
  have hb1 : bprev D N ⟨D, m1, p1, []⟩ m1 = p1 := by simp [bprev]
  have hb2 : bprev D N ⟨upd D m1 (stamp h p1 c1), m1, some (h c1 p1), [m1]⟩ m2 = some (h c1 p1) := by
    simp [bprev, h21, hD2]
  simp only [batchFiles, singleFiles, List.foldl_cons, List.foldl_nil, bstep, sstep]
  rw [hp1, hb1, hb2, hS1, upd_self, upd_self]
  simp [stamp]
  exact fun heq => hdiff heq.symm

/-! ## 7. Building a session manifest (`buildSessionManifest`) -/

inductive Role where
  | injected
  | recalled
  | written
  deriving DecidableEq

/-- `add(id, role)`: the first role an id gets from the log is kept. -/
def addRole (acc : List (Nat × Role)) (id : Nat) (r : Role) : List (Nat × Role) :=
  if acc.any (fun p => p.1 == id) then acc else acc ++ [(id, r)]

/-- A memory the session wrote is listed as written, even if it was also injected. -/
def markWritten (acc : List (Nat × Role)) (id : Nat) : List (Nat × Role) :=
  if acc.any (fun p => p.1 == id) then acc.map (fun p => if p.1 = id then (id, .written) else p)
  else acc ++ [(id, .written)]

def roles (logged : List (Nat × Role)) (written : List Nat) : List (Nat × Role) :=
  written.foldl markWritten (logged.foldl (fun a p => addRole a p.1 p.2) [])

theorem markWritten_keeps (acc : List (Nat × Role)) (i j : Nat) (hi : (i, Role.written) ∈ acc) :
    (i, Role.written) ∈ markWritten acc j := by
  unfold markWritten
  split
  · exact List.mem_map.mpr ⟨(i, .written), hi, by by_cases hij : i = j <;> simp [hij]⟩
  · exact List.mem_append_left _ hi

theorem markWritten_self (acc : List (Nat × Role)) (j : Nat) :
    (j, Role.written) ∈ markWritten acc j := by
  unfold markWritten
  split
  · rename_i hany
    rcases List.any_eq_true.mp hany with ⟨p, hp, hpj⟩
    exact List.mem_map.mpr ⟨p, hp, by simp at hpj; simp [hpj]⟩
  · simp

theorem foldl_markWritten_keeps : ∀ (ws : List Nat) (acc : List (Nat × Role)) (i : Nat),
    (i, Role.written) ∈ acc → (i, Role.written) ∈ ws.foldl markWritten acc
  | [], _, _, h => h
  | w :: ws, acc, i, h => foldl_markWritten_keeps ws _ i (markWritten_keeps acc i w h)

/-- Every engram the session wrote is listed with role `written`, whatever role the
log gave it. -/
theorem written_overrides : ∀ (logged : List (Nat × Role)) (written : List Nat) (i : Nat),
    i ∈ written → (i, Role.written) ∈ roles logged written := by
  intro logged written i hi
  unfold roles
  generalize logged.foldl (fun a p => addRole a p.1 p.2) [] = acc0
  induction written generalizing acc0 with
  | nil => simp at hi
  | cons w ws ih =>
      simp only [List.foldl_cons]
      rcases List.mem_cons.mp hi with h | h
      · subst h; exact foldl_markWritten_keeps ws _ _ (markWritten_self acc0 _)
      · exact ih h _

/-! ## 8. Verifying a manifest (`computeRecordHash`, `verifySessionManifest`)

`computeRecordHash` covers the fields in `RECORD_HASH_FIELDS`, after dropping
undefined, null and empty arrays. The covered record is abstracted as `R` (already
normalised); bookkeeping (counts, timestamps, activation) is the separate `B`. -/

structure Engram (R B : Type) where
  id : Nat
  covered : R
  bookkeeping : B

structure Entry (K : Type) where
  id : Nat
  role : Role
  recordHash : Option K

variable {R B K : Type}

def RecInjective (rh : R → K) : Prop := ∀ x y, rh x = rh y → x = y

/-- The entry `buildSessionManifest` writes: `record_hash = null` (reason "not in local
store") when the writer's store has no such engram. -/
def mkEntry (rh : R → K) (store : Nat → Option (Engram R B)) (p : Nat × Role) : Entry K :=
  match store p.1 with
  | none => ⟨p.1, p.2, none⟩
  | some e => ⟨p.1, p.2, some (rh e.covered)⟩

inductive Check where
  | match_
  | changed
  | notAvailable
  deriving DecidableEq

def checkEntry [DecidableEq K] (rh : R → K) (store : Nat → Option (Engram R B)) (en : Entry K) : Check :=
  match en.recordHash with
  | none => .notAvailable
  | some x =>
    match store en.id with
    | none => .notAvailable
    | some e => if rh e.covered = x then .match_ else .changed

/-- `ok: counts.CHANGED === 0`. -/
def manifestOk [DecidableEq K] (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K)) : Bool :=
  !(es.any (fun en => checkEntry rh store en == .changed))

variable [DecidableEq K]

/-- `ok` is false iff some entry is CHANGED. -/
theorem ok_false_iff_changed (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K)) :
    manifestOk rh store es = false ↔ ∃ en ∈ es, checkEntry rh store en = .changed := by
  simp [manifestOk]

/-- An engram the writer did not hold is NOT AVAILABLE to every verifier, never MATCH. -/
theorem writer_absent_not_available (rh : R → K) (wstore vstore : Nat → Option (Engram R B))
    (p : Nat × Role) (h : wstore p.1 = none) :
    checkEntry rh vstore (mkEntry rh wstore p) = .notAvailable := by
  simp [mkEntry, h, checkEntry]

/-- An engram the verifier does not hold is NOT AVAILABLE, never MATCH. -/
theorem verifier_absent_not_available (rh : R → K) (store : Nat → Option (Engram R B))
    (en : Entry K) (h : store en.id = none) : checkEntry rh store en = .notAvailable := by
  unfold checkEntry; cases en.recordHash <;> simp [h]

theorem not_available_never_match (rh : R → K) (store : Nat → Option (Engram R B)) (en : Entry K)
    (h : store en.id = none ∨ en.recordHash = none) : checkEntry rh store en ≠ .match_ := by
  rcases h with h | h
  · rw [verifier_absent_not_available rh store en h]; simp
  · unfold checkEntry; rw [h]; simp

/-- Untouched: an engram verified against the store the manifest was built from matches. -/
theorem unchanged_matches (rh : R → K) (store : Nat → Option (Engram R B)) (p : Nat × Role)
    (e : Engram R B) (h : store p.1 = some e) : checkEntry rh store (mkEntry rh store p) = .match_ := by
  simp [mkEntry, h, checkEntry]

/-- Bookkeeping is not covered: a change there alone keeps MATCH. -/
theorem bookkeeping_edit_matches (rh : R → K) (store store' : Nat → Option (Engram R B))
    (p : Nat × Role) (e : Engram R B) (b' : B) (h : store p.1 = some e)
    (h' : store' p.1 = some { e with bookkeeping := b' }) :
    checkEntry rh store' (mkEntry rh store p) = .match_ := by
  simp [mkEntry, h, checkEntry, h']

/-- Edit any covered field (model: the covered record changes) and MATCH becomes CHANGED,
under injectivity of the record hash. -/
theorem covered_edit_changed (rh : R → K) (hinj : RecInjective rh)
    (store store' : Nat → Option (Engram R B)) (p : Nat × Role) (e e' : Engram R B)
    (h : store p.1 = some e) (h' : store' p.1 = some e') (hne : e'.covered ≠ e.covered) :
    checkEntry rh store' (mkEntry rh store p) = .changed := by
  have hneq : rh e'.covered ≠ rh e.covered := fun heq => hne (hinj _ _ heq)
  simp [mkEntry, h, checkEntry, h', hneq]

/-- Field-wise form: covered record as a function from field names to normalised values. -/
theorem field_edit_changed {F V : Type} (rh : (F → Option V) → K) (hinj : RecInjective rh)
    (store store' : Nat → Option (Engram (F → Option V) B)) (p : Nat × Role)
    (e e' : Engram (F → Option V) B) (f : F)
    (h : store p.1 = some e) (h' : store' p.1 = some e') (hf : e'.covered f ≠ e.covered f) :
    checkEntry rh store' (mkEntry rh store p) = .changed :=
  covered_edit_changed rh hinj store store' p e e' h h' (fun heq => hf (by rw [heq]))

/-! ## 9. `plur verify --manifest` exit codes -/

/-- Where the manifest came from. A Swarm download carries the content-hash check and
the notary signature check (`none` = no signature on the stored document). -/
inductive Source where
  | file
  | swarm (contentHashOk : Bool) (notary : Option Bool)

/-- How `runManifest` ends. `cannot` covers every `cannot(...)` return: no such
file or reference, download failure, not JSON, not a manifest (verifyManifest throws). -/
inductive Outcome where
  | cannot
  | checked (manifestOk : Bool) (src : Source)

def integrityOk : Source → Bool
  | .file => true
  | .swarm c n => c && (match n with | none => true | some b => b)

def exitCode : Outcome → Nat
  | .cannot => 2
  | .checked m s => if m && integrityOk s then 0 else 1

theorem exit_zero_iff (o : Outcome) :
    exitCode o = 0 ↔ ∃ m s, o = .checked m s ∧ m = true ∧ integrityOk s = true := by
  cases o with
  | cannot => simp [exitCode]
  | checked m s =>
      simp only [exitCode, Outcome.checked.injEq]
      constructor
      · intro h0
        refine ⟨m, s, ⟨rfl, rfl⟩, ?_⟩
        cases hm : m <;> cases hi : integrityOk s <;> simp_all
      · rintro ⟨m', s', ⟨rfl, rfl⟩, hm, hi⟩
        simp [hm, hi]

theorem exit_two_iff_cannot (o : Outcome) : exitCode o = 2 ↔ o = .cannot := by
  cases o with
  | cannot => simp [exitCode]
  | checked m s => simp only [exitCode]; split <;> simp

theorem cannot_never_zero : exitCode .cannot ≠ 0 := by decide

/-- A Swarm download whose bytes do not match the stored content hash, or whose notary
signature is invalid, never exits 0. -/
theorem bad_integrity_not_zero (m : Bool) (c : Bool) (n : Option Bool)
    (h : c = false ∨ n = some false) : exitCode (.checked m (.swarm c n)) = 1 := by
  rcases h with h | h <;> subst h <;> cases m <;> simp [exitCode, integrityOk]

/-! ## 10. Opt-in network (`receiptsConfig`, plur_session_end) -/

inductive ReceiptStore where
  | off
  | swarm
  deriving DecidableEq

/-- `receiptsConfig()`: `swarm` only when the config literally says so; anything else
(absent, a typo, another value) is `off`. -/
def receiptsConfig (raw : Option String) : ReceiptStore :=
  if raw = some "swarm" then .swarm else .off

/-- The guard in plur_session_end: `manifestSession && store === 'swarm'`. -/
def sessionEndUploads (store : ReceiptStore) (session : Option String) : Bool :=
  match session with
  | some _ => store == .swarm
  | none => false

theorem uploads_iff (store : ReceiptStore) (session : Option String) :
    sessionEndUploads store session = true ↔ store = .swarm ∧ session.isSome = true := by
  cases session <;> cases store <;> simp [sessionEndUploads]

theorem default_no_network (raw : Option String) (session : Option String)
    (h : raw ≠ some "swarm") : sessionEndUploads (receiptsConfig raw) session = false := by
  simp [receiptsConfig, h]
  cases session <;> simp [sessionEndUploads]

end PlurSpec.Provenance
