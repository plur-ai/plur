/-!
# PlurSpec.Provenance — the history hash chain, checkpoints, session manifests (PLUR 0.23)

Models, as the code does it (not as it should), the provenance work landing in 0.23:

* `packages/core/src/history.ts`
  - `appendHistoryStamped`: under the chain lock it reads the predecessor
    (`findPredecessorHash`), sets `prev` to it — since commit d067f808 the hash of the
    last CHAINED event (`lastChainedHash`, legacy events stepped over; null on genesis),
    the model's `lastChained none` — lets `onPrev` build the payload from that same `prev`, then
    `hash = computeEventHash(event)` over the canonical bytes (everything except
    `hash`, `signature`, `signer`). When the lock cannot be taken it declares a gap:
    `prev = null`, `onPrev(null)`, and the event is written anyway. (§1, §2)
  - `appendHistoryBatch`: under the lock, `firstPrev = findPredecessorHash(firstFile)`
    and each event chains onto the one before it, in order; on lock failure
    `firstPrev = null`. Since commit 13cf8bab (F1 and its follow-ups) the batch is
    written in runs of one month file, each run's first event linked to the tail a
    single append would read after the earlier runs (null without the lock).
    The head cache is invalidated afterwards, which only sends the next lookup to the
    authoritative tail-seek, so the model reads the head off the log.
    (§3 within one month file; §6 across month files)
  - `targetMonthFile` (commit e52b7e9b, code review of 0.23 finding 5; clamped to the
    current month in ec5e7fc2 and 4e08fe67): under the lock, single appends and each
    batch run go to the newest month file in (own month, current month] that has
    events, else the own month; an event stamped after the current month goes to the
    current month's file. (§6)
  - `attestStore` `store_buckets` and `recordStoreSync` (`store_synced`, called from
    `packages/core/src/sync.ts` after a pull) (commit e52b7e9b). (§11)
  - `emitCheckpoint`: the payload (`chain_head`, `store_hash`, signature) is built inside
    `onPrev`, so `chain_head` is the very `prev` the event chains onto. (§5)
* `packages/core/src/verify-chain.ts` `verifyChain`: per chained event, `hash_mismatch`
  when it does not re-hash to its recorded hash; once a chained event was seen,
  `declared_gap` for `prev = null` and `prev_mismatch` for any other wrong `prev` —
  except, since d067f808, a `prev` equal to `beforeGap` (the expected prev when the
  current run of declared gaps began: a lock holder linking past an unlocked gap).
  Legacy events (no hash) are skipped and do not advance the expected `prev`. Forks
  are claims on one `prev`; a null `prev` is a genesis claim only while every chained
  event so far had a null `prev` (§4). Dangling prev and checkpoint head missing are
  not walked here; §5 shows the checkpoint head a locked append records is in the log.
  The store check — `store_hash_mismatch` versus `store_changed_since_checkpoint`,
  localised to the checkpoint's memory groups since e52b7e9b — is §11, over an
  abstract store; §5 keeps `store_hash` opaque (`S`).
* `packages/core/src/session-manifest.ts`: `buildSessionManifest` roles (§7),
  `computeRecordHash` over an abstract covered-field record, `verifySessionManifest`
  (§8).
  Since commit c21b371e: no `content_hash` in entries, and `ok` is false when engrams
  are listed but none was checked (§8).
* `packages/cli/src/commands/verify-manifest.ts` exit codes and
  `packages/cli/src/lib/notary.ts` `checkNotarySignature` (§9, commit c21b371e); the
  expected notary (`expectedNotaryFor` in `packages/gateway/src/client.ts`, and
  `--trust-gateway-notary`; commit 7c4d9486, code review of 0.23 finding 9) (§9).
* `packages/core/src/index.ts` `receiptsConfig()` and `packages/mcp/src/tools.ts`
  plur_session_end anchoring (§10).

Hashes are opaque. `computeEventHash` is a function `h : C → Option H → H` of the
canonical content and `prev`; signature and signer are not inputs, so they are not
in the model. Wherever a theorem needs collision freedom it takes `HashInjective h`
(or `RecInjective rh`) as a hypothesis — there is no axiom.

Findings: `spec/formal/findings/provenance-2026-10-27.md`. F1 and its follow-ups are
fixed; §6 proves a locked batch equals single appends across month files in every order
(`batch_eq_singles_months`, unchanged by `targetMonthFile`); since e52b7e9b single
appends in any timestamp order leave one chain in file order (`sstep_flat`,
`singles_any_order_verifies`, `finding5_shape_verifies`). F2 is fixed except the
ambiguous case (commit d067f808):
`locked_log_gap_reports_no_fork`, with `gap_after_lone_genesis_reports_fork` the kept
counterexample; `gap_after_genesis_is_fork` stays true of the log. Release-audit
findings 7 and 8 (d067f808): `locked_append_adds_no_break`, `legacy_interleave_verifies`,
`holder_past_gap_single_break`, `link_past_gap_other_is_mismatch`. Code review of 0.23:
store localisation `unrecorded_edit_reported`, `recorded_changes_never_break`, the limit
`unrecorded_edit_beside_recorded_undetected` (§11); the notary rule
`exit_zero_untrusted_signer`, `untrusted_other_gateway_cannot` (§9).
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

/-- The last event's hash, `none` when the log is empty or its tail is a legacy event.
(What `findPredecessorHash` returned under the lock before commit d067f808.) -/
def head (l : List (Event C H)) : Option H := l.getLast?.bind Event.hash

theorem head_snoc (l : List (Event C H)) (x : Event C H) : head (l ++ [x]) = x.hash := by
  simp [head]

theorem head_cons_cons (a b : Event C H) (t : List (Event C H)) :
    head (a :: b :: t) = head (b :: t) := by
  simp [head, List.getLast?_cons_cons]

/-- The hash of the last CHAINED event, `st` when the list holds none: legacy events
(`hash = none`) are stepped over. This is `lastChainedHash` in `history.ts` (commit
d067f808, the tail-seek under the lock) with `st = none`, and the `expectedPrev` the
`verifyChain` walk holds after a list (§4). -/
def lastChained : Option H → List (Event C H) → Option H
  | st, [] => st
  | st, e :: rest => lastChained (match e.hash with | none => st | some r => some r) rest

theorem lastChained_append : ∀ (st : Option H) (l m : List (Event C H)),
    lastChained st (l ++ m) = lastChained (lastChained st l) m
  | _, [], _ => rfl
  | st, e :: t, m => by
      simp only [List.cons_append, lastChained]
      exact lastChained_append _ t m

theorem lastChained_snoc_chained (st : Option H) (l : List (Event C H)) (x : Event C H) (r : H)
    (hx : x.hash = some r) : lastChained st (l ++ [x]) = some r := by
  rw [lastChained_append]; simp [lastChained, hx]

theorem lastChained_snoc_stamp (h : HashFn C H) (st : Option H) (l : List (Event C H))
    (p : Option H) (c : C) : lastChained st (l ++ [stamp h p c]) = some (h c p) :=
  lastChained_snoc_chained st l _ _ rfl

/-- `lastChained` names an event in the list, or is the start value. -/
theorem lastChained_mem : ∀ (st : Option H) (l : List (Event C H)) (r : H),
    lastChained st l = some r → st = some r ∨ ∃ e ∈ l, e.hash = some r
  | _, [], _, hr => Or.inl hr
  | st, e :: t, r, hr => by
      simp only [lastChained] at hr
      rcases lastChained_mem _ t r hr with h1 | ⟨e', he', h2⟩
      · cases he : e.hash with
        | none => simp only [he] at h1; exact Or.inl h1
        | some r' =>
            simp only [he] at h1
            exact Or.inr ⟨e, by simp, by rw [he, h1]⟩
      · exact Or.inr ⟨e', by simp [he'], h2⟩

/-! ## 2. Single appends -/

/-- Whether `withLock(history/chain)` was taken. -/
inductive Lock where
  | taken
  | failed
  deriving DecidableEq

/-- The `prev` an append uses: under the lock the hash of the last CHAINED event
(`lastChainedHash`, legacy events stepped over — commit d067f808, 0.23 release audit
finding 7), a declared gap without it. -/
def prevFor (lk : Lock) (l : List (Event C H)) : Option H :=
  match lk with
  | .taken => lastChained none l
  | .failed => none

/-- `appendHistoryStamped(root, event, onPrev)`: `onPrev` (here `f`) builds the content
from the `prev` this append uses, on both paths. -/
def appendStamped (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (f : Option H → C) :
    List (Event C H) :=
  l ++ [stamp h (prevFor lk l) (f (prevFor lk l))]

/-- `appendHistory(root, event)`: no `onPrev`. -/
def append (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C) : List (Event C H) :=
  appendStamped h lk l (fun _ => c)

/-- A locked append links to the last chained event it read. -/
theorem locked_append_links (h : HashFn C H) (l : List (Event C H)) (c : C) :
    (append h .taken l c).getLast? = some (stamp h (lastChained none l) c) := by
  simp [append, appendStamped, prevFor]

/-- Finding 7: a locked append right after legacy events (written by an older PLUR on
the same store) links past them, to the last chained event — not a declared gap. -/
theorem locked_append_skips_legacy (h : HashFn C H) (l ls : List (Event C H)) (c : C)
    (hls : ∀ x ∈ ls, x.hash = none) :
    (append h .taken (l ++ ls) c).getLast? = some (stamp h (lastChained none l) c) := by
  have : ∀ (st : Option H) (ls : List (Event C H)), (∀ x ∈ ls, x.hash = none) →
      lastChained st ls = st := by
    intro st ls hls
    induction ls with
    | nil => rfl
    | cons x t ih =>
        simp only [lastChained, hls x (by simp)]
        exact ih (fun y hy => hls y (by simp [hy]))
  simp [append, appendStamped, prevFor, lastChained_append, this _ ls hls]

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

/-- `appendHistoryBatch(root, events)`; `firstPrev` is the predecessor under the lock,
null without it. -/
def appendBatch (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (cs : List C) :
    List (Event C H) :=
  l ++ chainFrom h (prevFor lk l) cs

/-- After its first event, a batch continues exactly as a locked batch would. -/
theorem batch_cons (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C) (cs : List C) :
    appendBatch h lk l (c :: cs) = appendBatch h .taken (append h lk l c) cs := by
  simp only [appendBatch, append, appendStamped, chainFrom]
  rw [show prevFor .taken (l ++ [stamp h (prevFor lk l) c]) = some (h c (prevFor lk l)) from
    lastChained_snoc_stamp h none l _ c]
  simp

/-- Batch equivalence: a locked batch of `[e1..en]` writes exactly the events (same
`prev`, same `hash`) that n locked single appends write. -/
theorem batch_eq_singles (h : HashFn C H) :
    ∀ (cs : List C) (l : List (Event C H)),
      appendBatch h .taken l cs = cs.foldl (fun acc c => append h .taken acc c) l
  | [], l => by simp [appendBatch, chainFrom]
  | c :: cs, l => by
      rw [batch_cons, List.foldl_cons]
      exact batch_eq_singles h cs _

/-! ### Sealed -/

/-- Every event carries the hash of its own canonical bytes. -/
def Sealed (h : HashFn C H) (l : List (Event C H)) : Prop :=
  ∀ e ∈ l, e.hash = some (h e.content e.prev)

theorem sealed_append (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C)
    (hs : Sealed h l) : Sealed h (append h lk l c) := by
  intro e he
  simp only [append, appendStamped, List.mem_append, List.mem_singleton] at he
  rcases he with he | he
  · exact hs e he
  · subst he; rfl

theorem sealed_batch (h : HashFn C H) :
    ∀ (cs : List C) (lk : Lock) (l : List (Event C H)), Sealed h l → Sealed h (appendBatch h lk l cs)
  | [], _, l, hs => by simpa [appendBatch, chainFrom] using hs
  | c :: cs, lk, l, hs => by
      rw [batch_cons]
      exact sealed_batch h cs .taken _ (sealed_append h lk l c hs)

/-- On a sealed list (no legacy event) the last chained event is the last event. -/
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

/-- On a sealed log the locked predecessor is the head, as before commit d067f808. -/
theorem lastChained_none_sealed (h : HashFn C H) (l : List (Event C H)) (hs : Sealed h l) :
    lastChained none l = head l := by
  cases l with
  | nil => rfl
  | cons a t => exact lastChained_sealed h _ none hs (by simp)

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

theorem links_locked_append (h : HashFn C H) (l : List (Event C H)) (c : C) (hs : Sealed h l)
    (hl : Links l) : Links (append h .taken l c) := by
  simp only [append, appendStamped, prevFor]
  exact links_snoc l _ hl (lastChained_none_sealed h l hs)

theorem links_locked_batch (h : HashFn C H) :
    ∀ (cs : List C) (l : List (Event C H)), Sealed h l → Links l →
      Links (appendBatch h .taken l cs)
  | [], l, _, hl => by simpa [appendBatch, chainFrom] using hl
  | c :: cs, l, hs, hl => by
      rw [batch_cons]
      exact links_locked_batch h cs _ (sealed_append h .taken l c hs)
        (links_locked_append h l c hs hl)

/-- Chain linkage: after any sequence of locked appends, single or batch, every
event's `prev` is the hash of the event before it. -/
theorem locked_run_links (h : HashFn C H) :
    ∀ (ops : List (Lock × Op C)) (l : List (Event C H)),
      (∀ o ∈ ops, o.1 = .taken) → Sealed h l → Links l → Links (run h ops l)
  | [], l, _, _, hl => hl
  | (lk, o) :: ops, l, hall, hs, hl => by
      have hlk : lk = .taken := hall (lk, o) (by simp)
      subst hlk
      simp only [run, List.foldl_cons]
      have hall' : ∀ o' ∈ ops, o'.1 = .taken := fun o' ho' => hall o' (by simp [ho'])
      cases o with
      | single c =>
          exact locked_run_links h ops _ hall' (sealed_append h .taken l c hs)
            (links_locked_append h l c hs hl)
      | batch cs =>
          exact locked_run_links h ops _ hall' (sealed_batch h cs .taken l hs)
            (links_locked_batch h cs l hs hl)

/-- A locked run is one locked batch of all its contents, in order. -/
def opsContents : List (Lock × Op C) → List C
  | [] => []
  | (_, .single c) :: ops => c :: opsContents ops
  | (_, .batch cs) :: ops => cs ++ opsContents ops

theorem batch_batch (h : HashFn C H) (l : List (Event C H)) (cs ds : List C) :
    appendBatch h .taken (appendBatch h .taken l cs) ds = appendBatch h .taken l (cs ++ ds) := by
  rw [batch_eq_singles, batch_eq_singles, batch_eq_singles, List.foldl_append]

theorem run_locked_eq_batch (h : HashFn C H) :
    ∀ (ops : List (Lock × Op C)) (l : List (Event C H)), (∀ o ∈ ops, o.1 = .taken) →
      run h ops l = appendBatch h .taken l (opsContents ops)
  | [], l, _ => by simp [run, opsContents, appendBatch, chainFrom]
  | (lk, o) :: ops, l, hall => by
      have hlk : lk = .taken := hall (lk, o) (by simp)
      subst hlk
      have hall' : ∀ o' ∈ ops, o'.1 = .taken := fun o' ho' => hall o' (by simp [ho'])
      simp only [run, List.foldl_cons]
      cases o with
      | single c =>
          have := run_locked_eq_batch h ops (append h .taken l c) hall'
          simp only [run] at this
          rw [show step h Lock.taken l (Op.single c) = append h Lock.taken l c from rfl, this,
            opsContents, batch_cons]
      | batch cs =>
          have := run_locked_eq_batch h ops (appendBatch h .taken l cs) hall'
          simp only [run] at this
          rw [show step h Lock.taken l (Op.batch cs) = appendBatch h Lock.taken l cs from rfl, this,
            opsContents, batch_batch]

/-! ### Links-or-gap, under any lock outcome -/

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

theorem linksOrGap_append (h : HashFn C H) (lk : Lock) (l : List (Event C H)) (c : C)
    (hs : Sealed h l) (hl : LinksOrGap l) : LinksOrGap (append h lk l c) := by
  simp only [append, appendStamped]
  apply linksOrGap_snoc l _ hl
  cases lk with
  | taken => exact Or.inl (lastChained_none_sealed h l hs)
  | failed => exact Or.inr rfl

theorem batch_inv (h : HashFn C H) :
    ∀ (cs : List C) (lk : Lock) (l : List (Event C H)),
      Sealed h l → LinksOrGap l → Sealed h (appendBatch h lk l cs) ∧ LinksOrGap (appendBatch h lk l cs)
  | [], lk, l, hs, hl => by simpa [appendBatch, chainFrom] using And.intro hs hl
  | c :: cs, lk, l, hs, hl => by
      rw [batch_cons]
      exact batch_inv h cs .taken _ (sealed_append h lk l c hs) (linksOrGap_append h lk l c hs hl)

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
          exact run_inv h ops _ (sealed_append h lk l c hs) (linksOrGap_append h lk l c hs hl)
      | batch cs =>
          have := batch_inv h cs lk l hs hl
          exact run_inv h ops _ this.1 this.2

/-! ## 4. Verification (`verifyChain`) -/

inductive Reason where
  | hashMismatch
  | prevMismatch
  | declaredGap
  deriving DecidableEq

/-- `beforeGap` after one chained event with predecessor `p`, given `expectedPrev = st`
and `beforeGap = bg` before it: set to `expectedPrev` when a gap run starts after a
chained event (kept while the run continues), cleared by any other chained event. -/
def nextBg (st bg p : Option H) : Option H :=
  match st with
  | none => none
  | some ep =>
    match p with
    | some _ => none
    | none => match bg with
      | none => some ep
      | some b => some b

/-- The walk in `verifyChain` (commit d067f808): `st` is `expectedPrev` once a chained
event was seen (`none` = `sawFirstChained` false); `bg` is `beforeGap` (`none` =
undefined); `i` is the global index, legacy events included. An event whose `prev` is
`beforeGap` links past a declared gap and is not a `prev_mismatch` (finding 8). -/
def walk [DecidableEq H] (h : HashFn C H) :
    Option H → Option H → Nat → List (Event C H) → List (Nat × Reason)
  | _, _, _, [] => []
  | st, bg, i, e :: rest =>
    match e.hash with
    | none => walk h st bg (i + 1) rest
    | some r =>
      (if h e.content e.prev = r then [] else [(i, Reason.hashMismatch)]) ++
      (match st with
       | none => []
       | some ep =>
         if e.prev = some ep ∨ (bg.isSome = true ∧ e.prev = bg) then []
         else [(i, if e.prev = none then Reason.declaredGap else Reason.prevMismatch)]) ++
      walk h (some r) (nextBg st bg e.prev) (i + 1) rest

/-- The `beforeGap` the walk holds after a list. -/
def lastBg : Option H → Option H → List (Event C H) → Option H
  | _, bg, [] => bg
  | st, bg, e :: rest =>
    match e.hash with
    | none => lastBg st bg rest
    | some r => lastBg (some r) (nextBg st bg e.prev) rest

section Walk
variable [DecidableEq H]

/-- What the first event may carry, given the expected prev. -/
def StartOk (st : Option H) (l : List (Event C H)) : Prop :=
  ∀ a, l.head? = some a → ∀ r, st = some r → a.prev = some r ∨ a.prev = none

def StartExact (st : Option H) (l : List (Event C H)) : Prop :=
  ∀ a, l.head? = some a → ∀ r, st = some r → a.prev = some r

theorem walk_clean (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st bg : Option H) (i : Nat),
      Sealed h l → Links l → StartExact st l → walk h st bg i l = []
  | [], _, _, _, _, _, _ => rfl
  | a :: t, st, bg, i, hs, hl, hst => by
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
      have rest : ∀ bg', walk h (some (h a.content a.prev)) bg' (i + 1) t = [] :=
        fun bg' => walk_clean h t _ bg' (i + 1) hs' hl' hst'
      cases st with
      | none => simp [walk, ha, rest]
      | some r =>
          have hp : a.prev = some r := hst a (by simp) r rfl
          simp only [hp] at rest
          simp [walk, ha, rest, hp]

omit [DecidableEq H] in
/-- On a clean chain the walk ends with no gap run open. -/
theorem lastBg_clean (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st bg : Option H),
      Sealed h l → Links l → StartExact st l → l ≠ [] → lastBg st bg l = none
  | [], _, _, _, _, _, hne => absurd rfl hne
  | [a], st, bg, hs, _, hst, _ => by
      have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
      cases st with
      | none => simp [lastBg, ha, nextBg]
      | some r =>
          have hp : a.prev = some r := hst a (by simp) r rfl
          simp [lastBg, ha, nextBg, hp]
  | a :: b :: t, st, bg, hs, hl, hst, _ => by
      have ha : a.hash = some (h a.content a.prev) := hs a (by simp)
      have hst' : StartExact (some (h a.content a.prev)) (b :: t) := by
        intro b' hb r hr
        simp at hb; subst hb
        rw [hl.1, ha]; simpa using hr
      have := lastBg_clean h (b :: t) (some (h a.content a.prev)) (nextBg st bg a.prev)
        (fun e he => hs e (List.mem_cons_of_mem a he)) hl.2 hst' (by simp)
      simp only [lastBg, ha]
      exact this

/-- A log written only by locked appends (from empty) verifies with no break. -/
theorem locked_run_verifies (h : HashFn C H) (ops : List (Lock × Op C))
    (hall : ∀ o ∈ ops, o.1 = .taken) :
    walk h none none 0 (run h ops []) = [] :=
  walk_clean h _ none none 0 (run_inv h ops [] (by intro e he; simp at he) trivial).1
    (locked_run_links h ops [] hall (by intro e he; simp at he) trivial)
    (by intro a _ r hr; cases hr)

/-- Under any interleaving of lock outcomes, every break reported is a declared gap:
a lock failure is never reported as tampering. -/
theorem walk_only_gaps (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st bg : Option H) (i : Nat),
      Sealed h l → LinksOrGap l → StartOk st l → ∀ b ∈ walk h st bg i l, b.2 = .declaredGap
  | [], _, _, _, _, _, _ => by intro b hb; simp [walk] at hb
  | a :: t, st, bg, i, hs, hl, hst => by
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
      have rest : ∀ bg', ∀ b ∈ walk h (some (h a.content a.prev)) bg' (i + 1) t,
          b.2 = .declaredGap :=
        fun bg' => walk_only_gaps h t _ bg' (i + 1) hs' hl' hst'
      intro b hb
      cases st with
      | none =>
          simp [walk, ha] at hb
          exact rest _ b hb
      | some r =>
          rcases hst a (by simp) r rfl with hp | hp
          · simp only [hp] at rest
            simp [walk, ha, hp] at hb
            exact rest _ b hb
          · simp only [hp] at rest
            cases bg with
            | none =>
                simp [walk, ha, hp] at hb
                rcases hb with hb | hb
                · subst hb; rfl
                · exact rest _ b hb
            | some g =>
                simp [walk, ha, hp] at hb
                rcases hb with hb | hb
                · subst hb; rfl
                · exact rest _ b hb

theorem any_run_only_gaps (h : HashFn C H) (ops : List (Lock × Op C)) :
    ∀ b ∈ walk h none none 0 (run h ops []), b.2 = .declaredGap := by
  have := run_inv h ops [] (by intro e he; simp at he) trivial
  exact walk_only_gaps h _ none none 0 this.1 this.2 (by intro a _ r hr; cases hr)

/-- The tampering the walk reports at index `i + k`. -/
theorem walk_mem_mismatch (h : HashFn C H) :
    ∀ (l : List (Event C H)) (st bg : Option H) (i k : Nat) (e : Event C H) (r : H),
      l[k]? = some e → e.hash = some r → h e.content e.prev ≠ r →
      (i + k, Reason.hashMismatch) ∈ walk h st bg i l
  | [], _, _, _, _, _, _, hk, _, _ => by simp at hk
  | a :: t, st, bg, i, 0, e, r, hk, he, hne => by
      simp at hk; subst hk
      simp [walk, he, hne]
  | a :: t, st, bg, i, k + 1, e, r, hk, he, hne => by
      simp at hk
      have ih := walk_mem_mismatch h t
      rw [show i + (k + 1) = (i + 1) + k by omega]
      cases ha : a.hash with
      | none => simp [walk, ha]; exact ih st bg (i + 1) k e r hk he hne
      | some ra =>
          simp only [walk, ha, List.mem_append]
          right; exact ih _ _ (i + 1) k e r hk he hne

/-- Tamper detection: change the content of event `k` of a sealed log without
recomputing its hash, and verification reports a hash mismatch at that event
(hash injective on canonical bytes) — whatever `expectedPrev` and `beforeGap` hold, so
a link past a gap never hides an edit. -/
theorem tamper_detected (h : HashFn C H) (hinj : HashInjective h) (l : List (Event C H))
    (hs : Sealed h l) (k : Nat) (e : Event C H) (hk : l[k]? = some e) (c' : C)
    (hc : c' ≠ e.content) (st bg : Option H) (i : Nat) :
    (i + k, Reason.hashMismatch) ∈ walk h st bg i (l.set k { e with content := c' }) := by
  have hlen : k < l.length := by
    rcases List.getElem?_eq_some_iff.mp hk with ⟨hl, _⟩; exact hl
  have he : e.hash = some (h e.content e.prev) := hs e (List.mem_of_getElem? hk)
  apply walk_mem_mismatch h _ st bg i k { e with content := c' } (h e.content e.prev)
  · simp [hlen]
  · exact he
  · intro heq
    exact hc (hinj _ _ _ _ heq).1

/-- A link past a gap excuses only `beforeGap`: a chained event whose `prev` is neither
`expectedPrev` nor `beforeGap` (and not null) is still a `prev_mismatch`. -/
theorem walk_prevMismatch (h : HashFn C H) (ep : H) (bg : Option H) (i : Nat)
    (e : Event C H) (rest : List (Event C H)) (r : H) (he : e.hash = some r)
    (h1 : e.prev ≠ some ep) (h2 : e.prev ≠ bg) (h3 : e.prev ≠ none) :
    (i, Reason.prevMismatch) ∈ walk h (some ep) bg i (e :: rest) := by
  simp [walk, he, h1, h2, h3]

/-! ### Where a gap lands, exactly -/

theorem walk_append (h : HashFn C H) :
    ∀ (l m : List (Event C H)) (st bg : Option H) (i : Nat),
      walk h st bg i (l ++ m) =
        walk h st bg i l ++ walk h (lastChained st l) (lastBg st bg l) (i + l.length) m
  | [], m, st, bg, i => by simp [walk, lastChained, lastBg]
  | a :: t, m, st, bg, i => by
      have ih := walk_append h t m
      cases ha : a.hash with
      | none =>
          simp [walk, ha, lastChained, lastBg, ih, Nat.add_assoc, Nat.add_comm 1]
      | some r =>
          simp [walk, ha, lastChained, lastBg, ih, Nat.add_assoc, Nat.add_comm 1]

/-- Finding 7: a locked append adds no break to ANY log — legacy events included, since
it links to the last chained event, which is exactly the `expectedPrev` the walk holds. -/
theorem locked_append_adds_no_break (h : HashFn C H) (l : List (Event C H)) (c : C) :
    walk h none none 0 (append h .taken l c) = walk h none none 0 l := by
  simp only [append, appendStamped, prevFor]
  rw [walk_append]
  generalize lastBg none none l = bg
  cases lastChained none l <;> simp [walk, stamp]

theorem walk_legacy (h : HashFn C H) :
    ∀ (ls : List (Event C H)) (st bg : Option H) (i : Nat), (∀ x ∈ ls, x.hash = none) →
      walk h st bg i ls = []
  | [], _, _, _, _ => rfl
  | x :: t, st, bg, i, hls => by
      simp only [walk, hls x (by simp)]
      exact walk_legacy h t st bg (i + 1) (fun y hy => hls y (by simp [hy]))

/-- Finding 7, the scenario: a clean chain, then events from an older PLUR still running
on the same store (no hash), then a locked append — verifies with no break (before
d067f808: a declared gap). -/
theorem legacy_interleave_verifies (h : HashFn C H) (l ls : List (Event C H)) (c : C)
    (hs : Sealed h l) (hl : Links l) (hls : ∀ x ∈ ls, x.hash = none) :
    walk h none none 0 (append h .taken (l ++ ls) c) = [] := by
  rw [locked_append_adds_no_break, walk_append,
    walk_clean h l none none 0 hs hl (by intro a _ r hr; cases hr), walk_legacy h ls _ _ _ hls]
  rfl

omit [DecidableEq H] in
theorem head_some_of_sealed (h : HashFn C H) (l : List (Event C H)) (hs : Sealed h l)
    (hne : l ≠ []) : ∃ r, head l = some r := by
  cases hlast : l.getLast? with
  | none => simp at hlast; exact absurd hlast hne
  | some x =>
      have hx : x ∈ l := List.mem_of_getLast? hlast
      exact ⟨h x.content x.prev, by simp [head, hlast, hs x hx]⟩

/-- One lock failure after a clean non-empty chain: exactly one break, at the gap
event, reason `declared_gap`. -/
theorem single_gap_reported (h : HashFn C H) (l : List (Event C H)) (c : C)
    (hs : Sealed h l) (hl : Links l) (hne : l ≠ []) :
    walk h none none 0 (append h .failed l c) = [(l.length, Reason.declaredGap)] := by
  have hclean := walk_clean h l none none 0 hs hl (by intro a _ r hr; cases hr)
  rcases head_some_of_sealed h l hs hne with ⟨r, hr⟩
  simp only [append, appendStamped, prevFor]
  rw [walk_append, hclean, lastChained_sealed h l none hs hne, hr]
  generalize lastBg none none l = bg
  cases bg <;> simp [walk, stamp]

/-- Finding 8, the interleaving: the lock holder read the tail (`head l`), a writer
that timed out on the lock appended a declared gap, then the holder wrote linking to
the pre-gap tail, and the next locked append links to the holder. Exactly one break:
the declared gap. (Before d067f808 the holder's link was also a `prev_mismatch`.) -/
theorem holder_past_gap_single_break (h : HashFn C H) (l : List (Event C H)) (g c1 c2 : C)
    (hs : Sealed h l) (hl : Links l) (hne : l ≠ []) :
    walk h none none 0 (append h .taken (append h .failed l g ++ [stamp h (head l) c1]) c2) =
      [(l.length, Reason.declaredGap)] := by
  have hclean := walk_clean h l none none 0 hs hl (by intro a _ r hr; cases hr)
  have hbg := lastBg_clean h l none none hs hl (by intro a _ r hr; cases hr) hne
  rcases head_some_of_sealed h l hs hne with ⟨r, hr⟩
  have hlc := lastChained_sealed h l none hs hne
  simp only [append, appendStamped, prevFor, lastChained_snoc_stamp]
  rw [List.append_assoc, List.append_assoc, walk_append, hclean, hlc, hbg, hr]
  simp [walk, stamp, nextBg]

/-- …and in the same interleaving, an event after the gap that links to neither the
gap event nor the pre-gap tail is still reported as `prev_mismatch`. -/
theorem link_past_gap_other_is_mismatch (h : HashFn C H) (l : List (Event C H)) (g : C)
    (x : Event C H) (rx : H) (hs : Sealed h l) (hl : Links l) (hne : l ≠ [])
    (hx : x.hash = some rx) (h1 : x.prev ≠ head l) (h2 : x.prev ≠ some (h g none))
    (h3 : x.prev ≠ none) :
    (l.length + 1, Reason.prevMismatch) ∈ walk h none none 0 (append h .failed l g ++ [x]) := by
  have hclean := walk_clean h l none none 0 hs hl (by intro a _ r hr; cases hr)
  have hbg := lastBg_clean h l none none hs hl (by intro a _ r hr; cases hr) hne
  rcases head_some_of_sealed h l hs hne with ⟨r, hr⟩
  have hlc := lastChained_sealed h l none hs hne
  rw [hr] at h1
  simp only [append, appendStamped, prevFor]
  rw [List.append_assoc, walk_append, hclean, hlc, hbg, hr]
  simp [walk, stamp, nextBg, hx, h1, h2, h3]

end Walk

/-! ### Forks

`HasFork` is a property of the LOG: two chained events with one `prev`. -/

def HasFork (l : List (Event C H)) : Prop :=
  ∃ (i j : Nat) (a b : Event C H), i < j ∧ l[i]? = some a ∧ l[j]? = some b ∧
    a.hash.isSome ∧ b.hash.isSome ∧ a.prev = b.prev

/-- Finding F2 (still true of the log): one lock failure in a store whose first event is
genesis gives two chained events with `prev = none`. Since d067f808 `verifyChain` no
longer REPORTS this as a fork once the chain has a real link (`claims` below,
`locked_log_gap_reports_no_fork`); it still does when the gap follows a lone genesis
event (`t = []`, `gap_after_lone_genesis_reports_fork`). -/
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

/-! ### Reported forks (`prevClaims` in `verifyChain`, commit d067f808)

Each chained event claims its `prev` (`(prev, index)`); a null `prev` is a genesis claim
only while every chained event so far had `prev = null` (`allGenesisSoFar`, `ag`);
after a real link it claims nothing (it is a declared gap). A fork is reported for a
key claimed twice. Legacy events claim nothing and leave `ag` alone. -/

def claims : Bool → Nat → List (Event C H) → List (Option H × Nat)
  | _, _, [] => []
  | ag, i, e :: rest =>
    match e.hash with
    | none => claims ag (i + 1) rest
    | some _ =>
      (if e.prev.isSome || ag then [(e.prev, i)] else []) ++
      claims (ag && e.prev.isNone) (i + 1) rest

/-- `allGenesisSoFar` after a list. -/
def allGen : Bool → List (Event C H) → Bool
  | ag, [] => ag
  | ag, e :: rest => allGen (match e.hash with | none => ag | some _ => ag && e.prev.isNone) rest

/-- `verifyChain` reports a fork: one key claimed at two indices. -/
def ReportsFork (l : List (Event C H)) : Prop :=
  ∃ (p : Option H) (i j : Nat), i ≠ j ∧ (p, i) ∈ claims true 0 l ∧ (p, j) ∈ claims true 0 l

theorem claims_append : ∀ (ag : Bool) (i : Nat) (l m : List (Event C H)),
    claims ag i (l ++ m) = claims ag i l ++ claims (allGen ag l) (i + l.length) m
  | ag, i, [], m => by simp [claims, allGen]
  | ag, i, e :: t, m => by
      have ih := fun ag' => claims_append ag' (i + 1) t m
      cases he : e.hash with
      | none => simp [claims, allGen, he, ih, Nat.add_assoc, Nat.add_comm 1]
      | some r => simp [claims, allGen, he, ih, Nat.add_assoc, Nat.add_comm 1]

theorem allGen_false : ∀ (l : List (Event C H)), allGen false l = false
  | [] => rfl
  | e :: t => by
      cases he : e.hash with
      | none => simp only [allGen, he]; exact allGen_false t
      | some r => simp only [allGen, he, Bool.false_and]; exact allGen_false t

theorem allGen_link : ∀ (ag : Bool) (l : List (Event C H)) (e : Event C H), e ∈ l →
    e.hash.isSome = true → e.prev.isSome = true → allGen ag l = false
  | _, [], _, he, _, _ => by simp at he
  | ag, a :: t, e, he, hh, hp => by
      rcases List.mem_cons.mp he with rfl | he'
      · obtain ⟨r, hr⟩ := Option.isSome_iff_exists.mp hh
        obtain ⟨q, hq⟩ := Option.isSome_iff_exists.mp hp
        simp only [allGen, hr, hq, Option.isNone_some, Bool.and_false]
        exact allGen_false t
      · exact allGen_link _ t e he' hh hp

/-- A lock failure after a chain with at least one real link (a chained event with a
non-null `prev`) adds no claim: the gap is not a second genesis. -/
theorem gap_after_link_adds_no_claim (h : HashFn C H) (l : List (Event C H)) (c : C)
    (e : Event C H) (he : e ∈ l) (hh : e.hash.isSome = true) (hp : e.prev.isSome = true) :
    claims true 0 (append h .failed l c) = claims true 0 l := by
  simp only [append, appendStamped, prevFor]
  rw [claims_append, allGen_link true l e he hh hp]
  simp [claims, stamp]

theorem gap_after_link_no_new_fork (h : HashFn C H) (l : List (Event C H)) (c : C)
    (e : Event C H) (he : e ∈ l) (hh : e.hash.isSome = true) (hp : e.prev.isSome = true) :
    ReportsFork (append h .failed l c) ↔ ReportsFork l := by
  unfold ReportsFork
  rw [gap_after_link_adds_no_claim h l c e he hh hp]

/-- The ambiguous case, kept as a counterexample: a gap right after a lone genesis event
(`t = []` in `gap_after_genesis_is_fork`) is reported as a fork of genesis. From the log
alone it cannot be told from two writers racing on an empty store, which IS a fork. -/
theorem gap_after_lone_genesis_reports_fork (h : HashFn C H) (a : Event C H) (c : C)
    (ha : a.hash.isSome = true) (hg : a.prev = none) :
    ReportsFork (append h .failed [a] c) := by
  obtain ⟨r, hr⟩ := Option.isSome_iff_exists.mp ha
  refine ⟨none, 0, 1, by decide, ?_, ?_⟩ <;>
    simp [append, appendStamped, prevFor, claims, stamp, hr, hg]

/-! #### A locked log, then one lock failure, reports no fork (hash injective)

Depth of a predecessor: `none` is depth 0, `some (h c q)` is one more than `q`. Under
`HashInjective` the depth is unique, so the predecessors along a chain from genesis
are pairwise distinct. -/

inductive Depth (h : HashFn C H) : Option H → Nat → Prop
  | genesis : Depth h none 0
  | link (c : C) (q : Option H) (n : Nat) : Depth h q n → Depth h (some (h c q)) (n + 1)

theorem depth_some_inv (h : HashFn C H) {x : H} {m : Nat} (hd : Depth h (some x) m) :
    ∃ c q m', x = h c q ∧ Depth h q m' ∧ m = m' + 1 := by
  cases hd with
  | link c q m' hq => exact ⟨c, q, m', rfl, hq, rfl⟩

theorem depth_unique (h : HashFn C H) (hinj : HashInjective h) :
    ∀ (x : Option H) (n m : Nat), Depth h x n → Depth h x m → n = m := by
  intro x n m hn
  induction hn generalizing m with
  | genesis => intro hm; cases hm; rfl
  | link c q n hq ih =>
      intro hm
      obtain ⟨c', q', m', hx, hq', rfl⟩ := depth_some_inv h hm
      have := (hinj _ _ _ _ hx).2
      subst this
      rw [ih m' hq']

/-- The `prev`s along `chainFrom h p cs`. -/
def prevs (h : HashFn C H) : Option H → List C → List (Option H)
  | _, [] => []
  | p, c :: cs => p :: prevs h (some (h c p)) cs

theorem prevs_depth (h : HashFn C H) :
    ∀ (cs : List C) (p : Option H) (n k : Nat) (x : Option H),
      Depth h p n → (prevs h p cs)[k]? = some x → Depth h x (n + k)
  | [], _, _, _, _, _, hk => by simp [prevs] at hk
  | c :: cs, p, n, 0, x, hp, hk => by
      simp [prevs] at hk; subst hk; exact hp
  | c :: cs, p, n, k + 1, x, hp, hk => by
      simp only [prevs, List.getElem?_cons_succ] at hk
      have := prevs_depth h cs _ (n + 1) k x (Depth.link c p n hp) hk
      rwa [show n + 1 + k = n + (k + 1) by omega] at this

theorem claims_chainFrom (h : HashFn C H) :
    ∀ (cs : List C) (q : Option H) (ag : Bool) (j i : Nat) (p : Option H),
      (p, i) ∈ claims ag j (chainFrom h q cs) → j ≤ i ∧ (prevs h q cs)[i - j]? = some p
  | [], _, _, _, _, _, hm => by simp [chainFrom, claims] at hm
  | c :: cs, q, ag, j, i, p, hm => by
      simp only [chainFrom, claims, stamp, List.mem_append] at hm
      rcases hm with hm | hm
      · split at hm
        · simp at hm; obtain ⟨rfl, rfl⟩ := hm; simp [prevs]
        · simp at hm
      · have ⟨hji, hk⟩ := claims_chainFrom h cs _ _ (j + 1) i p hm
        refine ⟨by omega, ?_⟩
        rw [show i - j = (i - (j + 1)) + 1 by omega]
        simpa [prevs] using hk

theorem chain_no_fork (h : HashFn C H) (hinj : HashInjective h) (cs : List C) :
    ¬ ReportsFork (chainFrom h none cs) := by
  rintro ⟨p, i, j, hij, hi, hj⟩
  have ⟨_, hi'⟩ := claims_chainFrom h cs none true 0 i p hi
  have ⟨_, hj'⟩ := claims_chainFrom h cs none true 0 j p hj
  simp only [Nat.sub_zero] at hi' hj'
  have di := prevs_depth h cs none 0 i p Depth.genesis hi'
  have dj := prevs_depth h cs none 0 j p Depth.genesis hj'
  have := depth_unique h hinj p _ _ di dj
  omega

/-- F2 fixed except the ambiguous case: a log written by locked appends from empty, with
at least one real link (two or more events), followed by one lock failure, reports no
fork (`HashInjective` a hypothesis). Contrast `gap_after_genesis_is_fork`: the log still
has two `prev = none` events; they are no longer reported as a fork. -/
theorem locked_log_gap_reports_no_fork (h : HashFn C H) (hinj : HashInjective h)
    (ops : List (Lock × Op C)) (hall : ∀ o ∈ ops, o.1 = .taken) (c : C)
    (hlen : 2 ≤ (run h ops []).length) :
    ¬ ReportsFork (append h .failed (run h ops []) c) := by
  have hrun : run h ops [] = chainFrom h none (opsContents ops) := by
    rw [run_locked_eq_batch h ops [] hall]; simp [appendBatch]; rfl
  rw [hrun] at hlen ⊢
  obtain ⟨c0, c1, cs, hcs⟩ : ∃ c0 c1 cs, opsContents ops = c0 :: c1 :: cs := by
    match hm : opsContents ops with
    | [] => rw [hm] at hlen; simp [chainFrom] at hlen
    | [_] => rw [hm] at hlen; simp [chainFrom] at hlen
    | c0 :: c1 :: cs => exact ⟨c0, c1, cs, rfl⟩
  rw [hcs]
  rw [gap_after_link_no_new_fork h _ c (stamp h (some (h c0 none)) c1)
    (by simp [chainFrom]) (by simp [stamp]) (by simp [stamp])]
  exact chain_no_fork h hinj _

theorem prevs_length (h : HashFn C H) :
    ∀ (cs : List C) (p : Option H), (prevs h p cs).length = cs.length
  | [], _ => rfl
  | c :: cs, p => by simp [prevs, prevs_length h cs]

theorem chainFrom_length (h : HashFn C H) :
    ∀ (cs : List C) (p : Option H), (chainFrom h p cs).length = cs.length
  | [], _ => rfl
  | c :: cs, p => by simp [chainFrom, chainFrom_length h cs]

theorem claims_chain_lt (h : HashFn C H) (cs : List C) (p : Option H) (i : Nat)
    (hm : (p, i) ∈ claims true 0 (chainFrom h none cs)) : i < cs.length := by
  have ⟨_, hk⟩ := claims_chainFrom h cs none true 0 i p hm
  have := (List.getElem?_eq_some_iff.mp hk).1
  rw [prevs_length] at this; omega

/-- Finding 8, the fork half: in the holder interleaving after a locked log with a real
link, the gap claims nothing and the holder's claim on the pre-gap tail is the only
one, so no fork is reported (`HashInjective` a hypothesis). -/
theorem holder_past_gap_no_fork (h : HashFn C H) (hinj : HashInjective h) (cs : List C)
    (g c1 c2 : C) (hlen : 2 ≤ cs.length) :
    ¬ ReportsFork (append h .taken
      (append h .failed (chainFrom h none cs) g ++ [stamp h (head (chainFrom h none cs)) c1]) c2) := by
  have hb : ∀ xs, appendBatch h .taken [] xs = chainFrom h none xs := fun xs => by
    simp [appendBatch]; rfl
  have hs : Sealed h (chainFrom h none cs) := by
    rw [← hb]; exact sealed_batch h cs .taken [] (by intro e he; simp at he)
  have hne : chainFrom h none cs ≠ [] := by
    intro he; have := congrArg List.length he; rw [chainFrom_length, List.length_nil] at this; omega
  obtain ⟨c0, c1', cs', hcs⟩ : ∃ a b t, cs = a :: b :: t := by
    match hm : cs with
    | [] => simp at hlen
    | [_] => simp at hlen
    | a :: b :: t => exact ⟨a, b, t, rfl⟩
  obtain ⟨r, hr⟩ := head_some_of_sealed h _ hs hne
  have hJ : chainFrom h none (cs ++ [c1, c2]) =
      chainFrom h none cs ++ [stamp h (some r) c1, stamp h (some (h c1 (some r))) c2] := by
    rw [← hb, ← batch_batch, hb]
    simp only [appendBatch, prevFor, lastChained_none_sealed h _ hs, hr, chainFrom]
  have hlink : allGen true (chainFrom h none cs) = false := by
    rw [hcs]
    exact allGen_link true _ (stamp h (some (h c0 none)) c1') (by simp [chainFrom])
      (by simp [stamp]) (by simp [stamp])
  have hcJ : claims true 0 (chainFrom h none (cs ++ [c1, c2])) =
      claims true 0 (chainFrom h none cs) ++
        [(some r, cs.length), (some (h c1 (some r)), cs.length + 1)] := by
    rw [hJ, claims_append, hlink, chainFrom_length]; simp [claims, stamp]
  have hcI : claims true 0 (append h .taken
      (append h .failed (chainFrom h none cs) g ++ [stamp h (head (chainFrom h none cs)) c1]) c2) =
      claims true 0 (chainFrom h none cs) ++
        [(some r, cs.length + 1), (some (h c1 (some r)), cs.length + 2)] := by
    simp only [append, appendStamped, prevFor, lastChained_snoc_stamp, hr]
    rw [List.append_assoc, List.append_assoc, claims_append, hlink, chainFrom_length]
    simp [claims, stamp]
  rintro ⟨p, i, j, hij, hi, hj⟩
  rw [hcI] at hi hj
  have hmap : ∀ k, (p, k) ∈ claims true 0 (chainFrom h none cs) ++
        [(some r, cs.length + 1), (some (h c1 (some r)), cs.length + 2)] →
      ∃ k', (p, k') ∈ claims true 0 (chainFrom h none cs) ++
          [(some r, cs.length), (some (h c1 (some r)), cs.length + 1)] ∧
        ((k' = k ∧ k < cs.length) ∨ (k' + 1 = k ∧ cs.length < k)) := by
    intro k hk
    rcases List.mem_append.mp hk with hk | hk
    · exact ⟨k, List.mem_append_left _ hk, Or.inl ⟨rfl, claims_chain_lt h cs p k hk⟩⟩
    · simp only [List.mem_cons, Prod.mk.injEq, List.not_mem_nil, or_false] at hk
      rcases hk with ⟨rfl, rfl⟩ | ⟨rfl, rfl⟩
      · exact ⟨cs.length, by simp, Or.inr ⟨rfl, by omega⟩⟩
      · exact ⟨cs.length + 1, by simp, Or.inr ⟨rfl, by omega⟩⟩
  obtain ⟨i', hi', hi''⟩ := hmap i hi
  obtain ⟨j', hj', hj''⟩ := hmap j hj
  exact chain_no_fork h hinj (cs ++ [c1, c2])
    ⟨p, i', j', by omega, by rw [hcJ]; exact hi', by rw [hcJ]; exact hj'⟩

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
  rcases lastChained_mem none l r hr with h | h
  · cases h
  · exact h

/-! ## 6. Month files (`appendHistoryBatch` in runs, commit 13cf8bab; `targetMonthFile`, commit e52b7e9b)

The history directory is one event list per month (`Files`); `N` bounds every month
that has a file, so `flat S N` (the files oldest first, which is how `verifyChain`
reads them) is the whole log. An empty list stands for a missing file; an existing
EMPTY file is treated as missing too, which since e52b7e9b is also what
`targetMonthFile` does (`size > 0`).

`target S cur m` is `targetMonthFile(dir, ownMonth)` with `cur` the current month
(`new Date()`; code review of 0.23 finding 5, then R3 and the third review): an event
stamped after the current month goes to the current month's file; otherwise the
newest month file in (own month, current month] that has events, else the own month.
Every append computes it under the chain lock (single appends inside
`stampAndWrite`, batches per run), so an event stamped before a month boundary that
another writer already crossed joins the newest file, and no month file beyond today
is ever started (`noLaterThan_sstep`). The event keeps its own timestamp.

`findPred` is `findPredecessorHash(dir, file)` under the chain lock, where the
validated cache and sidecar can only return the true tail, so it is the tail-seek:
the last chained hash of that file when it has events (`tailSeekLastHash`, which
since commit d067f808 steps back over legacy events; null when the file holds no
chained event), otherwise the same of the newest OTHER month file (`newestBelow`:
months newest first, the current one skipped, the first file found decides — null
there means no further walk). The tail-seek's 1 MiB window ceiling and a line that
will not parse (both null) are not modelled.

The batch (`runs`, `lockedRuns`, `gapRuns`): the events are split into runs of
consecutive events of one month. Under the lock, run by run, the run goes to
`target` of its month and its first event links to `findPred` of that file, both
read AFTER the earlier runs are written; the rest of the run chains within the run.
On lock failure, every run not yet written starts with a declared gap
(`prev = null`), in the file `target` names; runs already written under the lock are
not written again (`batchFiles h N done`, `done` = runs written under the lock).

Proved with no ordering condition on the months (`batch_eq_singles_months`): a
locked batch leaves every month file exactly as n single locked appends do, with the
one clock reading `cur` for the batch (a month boundary passing DURING one batch is
not modelled). Proved for single appends with any event timestamps
(`sstep_flat`, `singles_any_order_chain`): the log read in file order is exactly one
locked chain, so it verifies clean and reports no fork. The only condition is on the
clock: it does not step back across a month boundary between appends. A per-file
write failure (`ok = false`, the run's line not landing) is not modelled. -/

abbrev Files (C H : Type) := Nat → List (Event C H)

/-- The newest month below `k` other than `m` whose file has events: its tail. -/
def newestBelow (S : Files C H) (m : Nat) : Nat → Option H
  | 0 => none
  | k + 1 => if k ≠ m ∧ (S k).isEmpty = false then lastChained none (S k) else newestBelow S m k

/-- `findPredecessorHash` under the lock, per month file. -/
def findPred (S : Files C H) (N m : Nat) : Option H :=
  if (S m).isEmpty then newestBelow S m N else lastChained none (S m)

/-- The newest month below `k` later than `m` whose file has events, else `m`. -/
def newestFrom (S : Files C H) (m : Nat) : Nat → Nat
  | 0 => m
  | k + 1 => if m < k ∧ (S k).isEmpty = false then k else newestFrom S m k

/-- `targetMonthFile(dir, ownMonth)` at current month `cur`: the month file an event of
month `m` joins. `if (ownMonth > current) return current`, else the newest month in
`(m, cur]` whose file has events, else `m` (`newestFrom S m (cur + 1)`). -/
def target (S : Files C H) (cur m : Nat) : Nat :=
  if cur < m then cur else newestFrom S m (cur + 1)

/-- Append events to month `m`'s file. -/
def appendRun (S : Files C H) (m : Nat) (es : List (Event C H)) : Files C H :=
  fun k => if k = m then S k ++ es else S k

/-- One single locked `appendHistory`, at current month `cur`, of an event with month
`x.1`: to the file `targetMonthFile` names, linked to that file's predecessor. -/
def sstep (h : HashFn C H) (N cur : Nat) (S : Files C H) (x : Nat × C) : Files C H :=
  appendRun S (target S cur x.1) [stamp h (findPred S N (target S cur x.1)) x.2]

/-- Single appends at one current month. -/
def singleFiles (h : HashFn C H) (N cur : Nat) (D : Files C H) (evs : List (Nat × C)) :
    Files C H :=
  evs.foldl (sstep h N cur) D

/-- Single appends, each with its own clock reading: `(cur, month, content)`. -/
def timedFiles (h : HashFn C H) (N : Nat) (D : Files C H) (tevs : List (Nat × Nat × C)) :
    Files C H :=
  tevs.foldl (fun S x => sstep h N x.1 S x.2) D

/-- Split into runs of consecutive events of one month (each run non-empty). -/
def runs : List (Nat × C) → List (Nat × List C)
  | [] => []
  | x :: xs =>
    match runs xs with
    | [] => [(x.1, [x.2])]
    | r :: rs => if x.1 = r.1 then (x.1, x.2 :: r.2) :: rs else (x.1, [x.2]) :: r :: rs

/-- Runs written under the lock:
`file = targetMonthFile(dir, runMonth); writeRun(run, findPredecessorHash(dir, file), file)`. -/
def lockedRuns (h : HashFn C H) (N cur : Nat) (S : Files C H) (rs : List (Nat × List C)) :
    Files C H :=
  rs.foldl (fun S r =>
    appendRun S (target S cur r.1) (chainFrom h (findPred S N (target S cur r.1)) r.2)) S

/-- Runs written after a lock failure: `writeRun(run, null, targetMonthFile(dir, runMonth))`. -/
def gapRuns (h : HashFn C H) (cur : Nat) (S : Files C H) (rs : List (Nat × List C)) : Files C H :=
  rs.foldl (fun S r => appendRun S (target S cur r.1) (chainFrom h none r.2)) S

/-- `appendHistoryBatch`: the first `done` runs under the lock, the rest after it failed. -/
def batchFiles (h : HashFn C H) (N cur : Nat) (D : Files C H) (done : Nat)
    (evs : List (Nat × C)) : Files C H :=
  gapRuns h cur (lockedRuns h N cur D ((runs evs).take done)) ((runs evs).drop done)

theorem ne_nil_of_isEmpty_false {l : List (Event C H)} (h : l.isEmpty = false) : l ≠ [] := by
  intro hl; subst hl; simp at h

theorem nil_of_isEmpty_true {l : List (Event C H)} (h : l.isEmpty = true) : l = [] := by
  cases l with
  | nil => rfl
  | cons _ _ => simp at h

theorem newestBelow_eq (S : Files C H) (m j : Nat) (hj : j ≠ m) (hS : (S j).isEmpty = false)
    (hlater : ∀ k, j < k → k ≠ m → S k = []) :
    ∀ n, j < n → newestBelow S m n = lastChained none (S j)
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
    findPred S N m = lastChained none (S m) := by
  simp [findPred, h]

theorem findPred_after_append (S : Files C H) (N m : Nat) (e : Event C H) (r : H)
    (he : e.hash = some r) : findPred (appendRun S m [e]) N m = some r := by
  unfold findPred appendRun; simp [lastChained_snoc_chained _ _ _ _ he]

theorem appendRun_append (S : Files C H) (m : Nat) (es fs : List (Event C H)) :
    appendRun (appendRun S m es) m fs = appendRun S m (es ++ fs) := by
  funext k; by_cases hk : k = m <;> simp [appendRun, hk]

theorem appendRun_nil (S : Files C H) (m : Nat) : appendRun S m [] = S := by
  funext k; by_cases hk : k = m <;> simp [appendRun, hk]

/-! ### `targetMonthFile` -/

theorem empty_of_not_later (S : Files C H) (m k : Nat) (hmk : m < k)
    (hc : ¬ (m < k ∧ (S k).isEmpty = false)) : S k = [] := by
  cases hS : (S k).isEmpty
  · exact absurd ⟨hmk, hS⟩ hc
  · exact nil_of_isEmpty_true hS

/-- `target` stays on the own month when no later file has events. -/
theorem newestFrom_self (S : Files C H) (m : Nat) :
    ∀ n, (∀ k, m < k → k < n → S k = []) → newestFrom S m n = m
  | 0, _ => rfl
  | n + 1, h => by
      have hn : ¬ (m < n ∧ (S n).isEmpty = false) := by
        rintro ⟨h1, h2⟩; rw [h n h1 (Nat.lt_succ_self n)] at h2; simp at h2
      simp only [newestFrom]
      rw [ite_eq_right hn]
      exact newestFrom_self S m n (fun k h1 h2 => h k h1 (by omega))

/-- `target` is the newest later file with events. -/
theorem newestFrom_top (S : Files C H) (m t : Nat) (hmt : m < t) (ht : (S t).isEmpty = false) :
    ∀ n, t < n → (∀ k, t < k → k < n → S k = []) → newestFrom S m n = t
  | 0, hn, _ => absurd hn (Nat.not_lt_zero _)
  | n + 1, hn, h => by
      by_cases hnt : n = t
      · rw [hnt]; simp only [newestFrom]; rw [ite_eq_left ⟨hmt, ht⟩]
      · have htn : t < n := by omega
        have hne : ¬ (m < n ∧ (S n).isEmpty = false) := by
          rintro ⟨_, h2⟩; rw [h n htn (Nat.lt_succ_self n)] at h2; simp at h2
        simp only [newestFrom]
        rw [ite_eq_right hne]
        exact newestFrom_top S m t hmt ht n htn (fun k h1 h2 => h k h1 (by omega))

/-- What `target` returns: the own month with no later file holding events, or a later
month whose file has events and after which no file has events. -/
theorem newestFrom_spec (S : Files C H) (m : Nat) : ∀ n,
    (newestFrom S m n = m ∧ ∀ k, m < k → k < n → S k = []) ∨
    (m < newestFrom S m n ∧ newestFrom S m n < n ∧ (S (newestFrom S m n)).isEmpty = false ∧
      ∀ k, newestFrom S m n < k → k < n → S k = [])
  | 0 => Or.inl ⟨rfl, fun _ _ hk => absurd hk (Nat.not_lt_zero _)⟩
  | n + 1 => by
      by_cases hc : m < n ∧ (S n).isEmpty = false
      · right
        have he : newestFrom S m (n + 1) = n := by simp only [newestFrom]; rw [ite_eq_left hc]
        rw [he]
        exact ⟨hc.1, Nat.lt_succ_self n, hc.2, fun k h1 h2 => absurd h2 (by omega)⟩
      · have he : newestFrom S m (n + 1) = newestFrom S m n := by
          simp only [newestFrom]; rw [ite_eq_right hc]
        rw [he]
        rcases newestFrom_spec S m n with ⟨he', hall⟩ | ⟨h1, h2, h3, hall⟩
        · left
          refine ⟨he', fun k h1 h2 => ?_⟩
          by_cases hkn : k = n
          · rw [hkn] at h1 ⊢; exact empty_of_not_later S m n h1 hc
          · exact hall k h1 (by omega)
        · right
          refine ⟨h1, by omega, h3, fun k hk1 hk2 => ?_⟩
          by_cases hkn : k = n
          · rw [hkn]; exact empty_of_not_later S m n (by omega) hc
          · exact hall k hk1 (by omega)

/-- After appending to the file `target` named, `target` names it again: the events of a
run, or consecutive single appends of one month, all land in one file (when the file
was empty and stays the own month, appending makes it the newest file with events). -/
theorem newestFrom_appendRun (S : Files C H) (N m : Nat) (es : List (Event C H)) :
    newestFrom (appendRun S (newestFrom S m N) es) m N = newestFrom S m N := by
  rcases newestFrom_spec S m N with ⟨he, hall⟩ | ⟨h1, h2, h3, hall⟩
  · rw [he]
    apply newestFrom_self
    intro k hk1 hk2
    have : k ≠ m := by omega
    simp [appendRun, this, hall k hk1 hk2]
  · generalize newestFrom S m N = t at h1 h2 h3 hall ⊢
    apply newestFrom_top _ m t h1 _ N h2
    · intro k hk1 hk2
      have : k ≠ t := by omega
      simp [appendRun, this, hall k hk1 hk2]
    · cases hS : S t with
      | nil => rw [hS] at h3; simp at h3
      | cons a l => simp [appendRun, hS]

theorem target_appendRun (S : Files C H) (cur m : Nat) (es : List (Event C H)) :
    target (appendRun S (target S cur m) es) cur m = target S cur m := by
  by_cases hc : cur < m
  · simp [target, hc]
  · simp only [target, ite_eq_right hc]
    exact newestFrom_appendRun S (cur + 1) m es

/-! ### Batch equivalence -/

/-- Single appends of one run, from the state where `findPred` of the file `target`
names is `p`: the run lands in that file chained from `p`, exactly as
`writeRun(run, p, file)` writes it. -/
theorem singles_of_run (h : HashFn C H) (N cur m : Nat) :
    ∀ (cs : List C) (S : Files C H) (p : Option H), findPred S N (target S cur m) = p →
      (cs.map (fun c => (m, c))).foldl (sstep h N cur) S =
        appendRun S (target S cur m) (chainFrom h p cs)
  | [], S, _, _ => by simp [chainFrom, appendRun_nil]
  | c :: cs, S, p, hp => by
      simp only [List.map_cons, List.foldl_cons]
      have hs : sstep h N cur S (m, c) = appendRun S (target S cur m) [stamp h p c] := by
        simp [sstep, hp]
      have ht := target_appendRun S cur m [stamp h p c]
      rw [hs, singles_of_run h N cur m cs _ (some (h c p))
        (by rw [ht]; exact findPred_after_append _ _ _ _ _ rfl), ht, appendRun_append]
      rfl

/-- The runs, read back event by event, are the batch. -/
theorem runs_flatten : ∀ (evs : List (Nat × C)),
    (runs evs).flatMap (fun r => r.2.map (fun c => (r.1, c))) = evs
  | [] => rfl
  | (m, c) :: xs => by
      have ih := runs_flatten xs
      unfold runs
      cases hr : runs xs with
      | nil => rw [hr] at ih; simp at ih; simp [ih]
      | cons r rs =>
          obtain ⟨m', cs⟩ := r
          rw [hr] at ih
          by_cases hx : m = m'
          · subst hx; simp [← ih]
          · simp [hx, ← ih]

theorem foldl_flatMap {α β γ : Type} (f : α → List β) (g : γ → β → γ) :
    ∀ (rs : List α) (s : γ), (rs.flatMap f).foldl g s = rs.foldl (fun s r => (f r).foldl g s) s
  | [], _ => rfl
  | r :: rs, s => by simp [List.flatMap_cons, List.foldl_append, foldl_flatMap f g rs]

/-- Batch equivalence across month files, in every order: a locked batch (every run
written under the lock) leaves every month file exactly as n single locked appends
do — the same events in the same files, the same `prev` and `hash` links. No
hypothesis on the order of the months (none was needed since 13cf8bab, and
`targetMonthFile` adds none). -/
theorem batch_eq_singles_months (h : HashFn C H) (N cur : Nat) (D : Files C H)
    (evs : List (Nat × C)) :
    batchFiles h N cur D (runs evs).length evs = singleFiles h N cur D evs := by
  simp only [batchFiles, List.take_length, List.drop_length, gapRuns, List.foldl_nil, singleFiles]
  conv => rhs; rw [← runs_flatten evs]
  rw [foldl_flatMap]
  unfold lockedRuns
  generalize runs evs = rs
  induction rs generalizing D with
  | nil => rfl
  | cons r rs ih =>
      simp only [List.foldl_cons]
      rw [singles_of_run h N cur r.1 r.2 D _ rfl]
      exact ih _

/-- After a lock failure, every run not yet written starts with a declared gap: the
first event of each such run has `prev = none`, and the rest chain within the run. -/
theorem failed_batch_runs_gap (h : HashFn C H) (N cur : Nat) (D : Files C H) (done : Nat)
    (evs : List (Nat × C)) :
    batchFiles h N cur D done evs =
      ((runs evs).drop done).foldl
        (fun S r => appendRun S (target S cur r.1) (chainFrom h none r.2))
        (lockedRuns h N cur D ((runs evs).take done)) ∧
    ∀ r ∈ (runs evs).drop done, ∀ c cs, r.2 = c :: cs →
      chainFrom h none r.2 = stamp h none c :: chainFrom h (some (h c none)) cs := by
  refine ⟨rfl, ?_⟩
  intro r _ c cs hr
  rw [hr]; rfl

/-! ### The log in file order (code review of 0.23, finding 5)

`flat S N` is the log as `verifyChain` reads it: month files oldest first. Before
e52b7e9b an event stamped in October and appended after November's file had started
went to the October file, chained onto October's tail — a predecessor November's
first event had already claimed — so the file-order log forked and had a
`prev_mismatch`. Now it joins November's file and links to the global last chained
event.

No month file is later than the current month (`NoLaterThan S cur`): the clamp keeps
this (`noLaterThan_sstep`) as long as the clock does not step back across a month
boundary, and an empty history starts with it. A file beyond today written by code
before the clamp is outside these claims.

One more hypothesis: every month file that has events holds a CHAINED event
(`ChainedFiles`). A file of only legacy (pre-#1051) events has a null tail-seek, so an
append to it starts a gap instead of linking past it to an older file. Appends keep
the hypothesis (`chainedFiles_sstep`); a store whose history began on 0.23 meets it
from the start. -/

/-- The month files below `n`, oldest first. -/
def flat (S : Files C H) : Nat → List (Event C H)
  | 0 => []
  | n + 1 => flat S n ++ S n

/-- Every month file with events holds a chained event. -/
def ChainedFiles (S : Files C H) : Prop := ∀ k, S k ≠ [] → ∃ e ∈ S k, e.hash.isSome = true

theorem lastChained_of_chained : ∀ (l : List (Event C H)) (st : Option H),
    (∃ e ∈ l, e.hash.isSome = true) → lastChained st l = lastChained none l
  | [], _, ⟨_, he, _⟩ => by simp at he
  | e :: rest, st, ⟨x, hx, hxs⟩ => by
      cases he : e.hash with
      | some r => simp only [lastChained, he]
      | none =>
          simp only [lastChained, he]
          rcases List.mem_cons.mp hx with rfl | hx'
          · rw [he] at hxs; simp at hxs
          · exact lastChained_of_chained rest st ⟨x, hx', hxs⟩

theorem flat_congr (S S' : Files C H) : ∀ n, (∀ k, k < n → S k = S' k) → flat S n = flat S' n
  | 0, _ => rfl
  | n + 1, h => by
      simp only [flat]
      rw [flat_congr S S' n (fun k hk => h k (by omega)), h n (by omega)]

/-- The global last chained event is the last chained event of the newest file. -/
theorem lastChained_flat_top (S : Files C H) (hc : ChainedFiles S) (j : Nat) (hj : S j ≠ []) :
    ∀ n, j < n → (∀ k, j < k → k < n → S k = []) →
      lastChained none (flat S n) = lastChained none (S j)
  | 0, hn, _ => absurd hn (Nat.not_lt_zero _)
  | n + 1, hn, h => by
      simp only [flat]
      by_cases hnj : n = j
      · rw [hnj, lastChained_append, lastChained_of_chained _ _ (hc j hj)]
      · rw [h n (by omega) (by omega), List.append_nil]
        exact lastChained_flat_top S hc j hj n (by omega) (fun k h1 h2 => h k h1 (by omega))

/-- With the own file and every later file empty, the directory walk finds the global
last chained event. -/
theorem newestBelow_flat (S : Files C H) (hc : ChainedFiles S) (m : Nat) (hm : S m = []) :
    ∀ n, (∀ k, m < k → k < n → S k = []) → newestBelow S m n = lastChained none (flat S n)
  | 0, _ => rfl
  | n + 1, h => by
      simp only [newestBelow, flat]
      by_cases hc' : n ≠ m ∧ (S n).isEmpty = false
      · rw [ite_eq_left hc', lastChained_append,
          lastChained_of_chained (S n) (lastChained none (flat S n))
            (hc n (ne_nil_of_isEmpty_false hc'.2))]
      · rw [ite_eq_right hc']
        have hSn : S n = [] := by
          by_cases hnm : n = m
          · rw [hnm]; exact hm
          · cases hS : (S n).isEmpty
            · exact absurd ⟨hnm, hS⟩ hc'
            · exact nil_of_isEmpty_true hS
        rw [hSn, List.append_nil]
        exact newestBelow_flat S hc m hm n (fun k h1 h2 => h k h1 (by omega))

/-- No month file later than `cur`. -/
def NoLaterThan (S : Files C H) (cur : Nat) : Prop := ∀ k, cur < k → S k = []

/-- The predecessor of a file after which no file has events is the global last chained
event. -/
theorem findPred_global_of_top (S : Files C H) (N t : Nat) (hc : ChainedFiles S) (ht : t < N)
    (hall : ∀ k, t < k → k < N → S k = []) :
    findPred S N t = lastChained none (flat S N) := by
  unfold findPred
  cases hS : (S t).isEmpty
  · rw [ite_eq_right (by simp)]
    exact (lastChained_flat_top S hc t (ne_nil_of_isEmpty_false hS) N ht hall).symm
  · rw [ite_eq_left rfl]
    exact newestBelow_flat S hc t (nil_of_isEmpty_true hS) N hall

/-- The file `targetMonthFile` names is at most the current month and no file after it
has events. -/
theorem target_top (S : Files C H) (N cur m : Nat) (hb : NoLaterThan S cur) (hcN : cur < N) :
    target S cur m < N ∧ target S cur m ≤ cur ∧ ∀ k, target S cur m < k → k < N → S k = [] := by
  unfold target
  by_cases hc : cur < m
  · rw [ite_eq_left hc]
    exact ⟨hcN, Nat.le_refl _, fun k hk _ => hb k hk⟩
  · rw [ite_eq_right hc]
    rcases newestFrom_spec S m (cur + 1) with ⟨he, hall⟩ | ⟨h1, h2, _, hall⟩
    · rw [he]
      refine ⟨by omega, by omega, fun k hk1 _ => ?_⟩
      by_cases hkc : k ≤ cur
      · exact hall k hk1 (by omega)
      · exact hb k (by omega)
    · refine ⟨by omega, by omega, fun k hk1 _ => ?_⟩
      by_cases hkc : k ≤ cur
      · exact hall k hk1 (by omega)
      · exact hb k (by omega)

/-- Under the lock, the predecessor of the file `targetMonthFile` names is the global
last chained event, and no file after that one has events. -/
theorem findPred_target_global (S : Files C H) (N cur m : Nat) (hc : ChainedFiles S)
    (hb : NoLaterThan S cur) (hcN : cur < N) :
    findPred S N (target S cur m) = lastChained none (flat S N) ∧
    target S cur m < N ∧ ∀ k, target S cur m < k → k < N → S k = [] := by
  obtain ⟨h1, _, h3⟩ := target_top S N cur m hb hcN
  exact ⟨findPred_global_of_top S N _ hc h1 h3, h1, h3⟩

theorem flat_appendRun (S : Files C H) (t : Nat) (es : List (Event C H)) :
    ∀ n, t < n → (∀ k, t < k → k < n → S k = []) → flat (appendRun S t es) n = flat S n ++ es
  | 0, hn, _ => absurd hn (Nat.not_lt_zero _)
  | n + 1, hn, h => by
      simp only [flat]
      by_cases hnt : n = t
      · rw [hnt, flat_congr (appendRun S t es) S t
          (fun k hk => by simp [appendRun, Nat.ne_of_lt hk])]
        simp [appendRun]
      · rw [flat_appendRun S t es n (by omega) (fun k h1 h2 => h k h1 (by omega))]
        simp [appendRun, hnt, h n (by omega) (by omega)]

/-- Finding 5 fixed: a locked single append, whatever its timestamp, extends the
file-order log exactly as a §2 locked append extends one list — the event lands at the
end of the log, linked to the global last chained event. No condition on the event's
own month: one stamped before an existing later file, or after the current month,
alike. -/
theorem sstep_flat (h : HashFn C H) (N cur : Nat) (S : Files C H) (x : Nat × C)
    (hc : ChainedFiles S) (hb : NoLaterThan S cur) (hcN : cur < N) :
    flat (sstep h N cur S x) N = append h .taken (flat S N) x.2 := by
  obtain ⟨hp, ht, hall⟩ := findPred_target_global S N cur x.1 hc hb hcN
  simp only [sstep, append, appendStamped, prevFor]
  rw [hp, flat_appendRun S _ _ N ht hall]

/-- (a) The event a locked single append writes links to the global last chained event
— not to its own month file's tail when a later file already has events. -/
theorem late_stamp_links_global_last (h : HashFn C H) (N cur : Nat) (S : Files C H)
    (x : Nat × C) (hc : ChainedFiles S) (hb : NoLaterThan S cur) (hcN : cur < N) :
    (flat (sstep h N cur S x) N).getLast? = some (stamp h (lastChained none (flat S N)) x.2) := by
  rw [sstep_flat h N cur S x hc hb hcN]; exact locked_append_links h _ _

theorem chainedFiles_sstep (h : HashFn C H) (N cur : Nat) (S : Files C H) (x : Nat × C)
    (hc : ChainedFiles S) : ChainedFiles (sstep h N cur S x) := by
  intro k hk
  simp only [sstep, appendRun] at hk ⊢
  by_cases hkt : k = target S cur x.1
  · rw [ite_eq_left hkt]
    exact ⟨_, List.mem_append_right _ (List.mem_singleton_self _), by simp [stamp]⟩
  · rw [ite_eq_right hkt] at hk ⊢; exact hc k hk

/-- The clamp: an append never creates a file later than the current month, so the
bound carries to any later clock reading. -/
theorem noLaterThan_sstep (h : HashFn C H) (N cur cur' : Nat) (S : Files C H) (x : Nat × C)
    (hb : NoLaterThan S cur) (hle : cur ≤ cur') : NoLaterThan (sstep h N cur S x) cur' := by
  intro k hk
  have ht : target S cur x.1 ≤ cur := by
    unfold target
    by_cases hc : cur < x.1
    · rw [ite_eq_left hc]; exact Nat.le_refl _
    · rw [ite_eq_right hc]
      rcases newestFrom_spec S x.1 (cur + 1) with ⟨he, _⟩ | ⟨_, h2, _, _⟩
      · rw [he]; omega
      · omega
  have hkt : k ≠ target S cur x.1 := by omega
  simp only [sstep, appendRun, ite_eq_right hkt]
  exact hb k (by omega)

/-- Single locked appends with any event timestamps, and a clock that does not step
back across a month boundary (each reading `≥ cur0`, nondecreasing), extend the
file-order log one locked append at a time. -/
theorem timed_flat (h : HashFn C H) (N : Nat) :
    ∀ (tevs : List (Nat × Nat × C)) (S : Files C H) (cur0 : Nat), ChainedFiles S →
      NoLaterThan S cur0 → (∀ x ∈ tevs, cur0 ≤ x.1 ∧ x.1 < N) →
      tevs.Pairwise (fun a b => a.1 ≤ b.1) →
      flat (timedFiles h N S tevs) N =
        (tevs.map (fun x => x.2.2)).foldl (fun acc c => append h .taken acc c) (flat S N)
  | [], _, _, _, _, _, _ => rfl
  | x :: xs, S, cur0, hc, hb, hx, hp => by
      simp only [timedFiles, List.foldl_cons, List.map_cons]
      have hx0 := hx x (by simp)
      have hpx := List.pairwise_cons.mp hp
      have hb' : NoLaterThan S x.1 := fun k hk => hb k (by omega)
      have ih := timed_flat h N xs (sstep h N x.1 S x.2) x.1 (chainedFiles_sstep h N x.1 S x.2 hc)
        (noLaterThan_sstep h N x.1 x.1 S x.2 hb' (Nat.le_refl _))
        (fun y hy => ⟨hpx.1 y hy, (hx y (by simp [hy])).2⟩) hpx.2
      simp only [timedFiles] at ih
      rw [ih, sstep_flat h N x.1 S x.2 hc hb' hx0.2]

/-- No month file has events. -/
def noFiles : Files C H := fun _ => []

theorem flat_noFiles : ∀ n, flat (noFiles : Files C H) n = []
  | 0 => rfl
  | n + 1 => by simp [flat, flat_noFiles n, noFiles]

/-- From an empty history, single locked appends with ANY event timestamps (earlier
than a file already started, or after the current month) leave a file-order log that
is one locked chain of their contents. Conditions on the clock only: readings below
`N` and nondecreasing. -/
theorem singles_any_order_chain (h : HashFn C H) (N : Nat) (tevs : List (Nat × Nat × C))
    (hN : ∀ x ∈ tevs, x.1 < N) (hmono : tevs.Pairwise (fun a b => a.1 ≤ b.1)) :
    flat (timedFiles h N noFiles tevs) N = chainFrom h none (tevs.map (fun x => x.2.2)) := by
  rw [timed_flat h N tevs noFiles 0 (fun k hk => absurd rfl hk) (fun _ _ => rfl)
    (fun x hx => ⟨Nat.zero_le _, hN x hx⟩) hmono, flat_noFiles, ← batch_eq_singles]
  simp [appendBatch, prevFor, lastChained]

section FileOrder
variable [DecidableEq H]

/-- (a) A locked single append adds no break to the file-order log, whatever its
timestamp. -/
theorem late_stamp_adds_no_break (h : HashFn C H) (N cur : Nat) (S : Files C H) (x : Nat × C)
    (hc : ChainedFiles S) (hb : NoLaterThan S cur) (hcN : cur < N) :
    walk h none none 0 (flat (sstep h N cur S x) N) = walk h none none 0 (flat S N) := by
  rw [sstep_flat h N cur S x hc hb hcN]; exact locked_append_adds_no_break h _ _

/-- From an empty history, locked single appends with any event timestamps verify with
no break. -/
theorem singles_any_order_verifies (h : HashFn C H) (N : Nat) (tevs : List (Nat × Nat × C))
    (hN : ∀ x ∈ tevs, x.1 < N) (hmono : tevs.Pairwise (fun a b => a.1 ≤ b.1)) :
    walk h none none 0 (flat (timedFiles h N noFiles tevs) N) = [] := by
  rw [singles_any_order_chain h N tevs hN hmono]
  have hb : appendBatch h .taken [] (tevs.map (fun x => x.2.2)) =
      chainFrom h none (tevs.map (fun x => x.2.2)) := by
    simp [appendBatch]; rfl
  rw [← hb]
  exact walk_clean h _ none none 0 (sealed_batch h _ .taken [] (by intro e he; simp at he))
    (links_locked_batch h _ [] (by intro e he; simp at he) trivial)
    (by intro a _ r hr; cases hr)

omit [DecidableEq H] in
/-- …and report no fork (`HashInjective` a hypothesis). -/
theorem singles_any_order_no_fork (h : HashFn C H) (hinj : HashInjective h) (N : Nat)
    (tevs : List (Nat × Nat × C)) (hN : ∀ x ∈ tevs, x.1 < N)
    (hmono : tevs.Pairwise (fun a b => a.1 ≤ b.1)) :
    ¬ ReportsFork (flat (timedFiles h N noFiles tevs) N) := by
  rw [singles_any_order_chain h N tevs hN hmono]; exact chain_no_fork h hinj _

/-- The counterexample shape of code-review finding 5, now clean: in November (current
month 11) a November event is written, then an event stamped October. The October
event joins November's file, October's file stays empty, and the log verifies with no
break and no reported fork. -/
theorem finding5_shape_verifies (h : HashFn C H) (hinj : HashInjective h) (c1 c2 : C) :
    (timedFiles h 12 noFiles [(11, 11, c1), (11, 10, c2)]) 10 = [] ∧
    walk h none none 0 (flat (timedFiles h 12 noFiles [(11, 11, c1), (11, 10, c2)]) 12) = [] ∧
    ¬ ReportsFork (flat (timedFiles h 12 noFiles [(11, 11, c1), (11, 10, c2)]) 12) := by
  have hN : ∀ x ∈ [((11 : Nat), (11 : Nat), c1), (11, 10, c2)], x.1 < 12 := by
    intro x hx; simp at hx; rcases hx with rfl | rfl <;> simp
  have hmono : [((11 : Nat), (11 : Nat), c1), (11, 10, c2)].Pairwise (fun a b => a.1 ≤ b.1) := by
    simp
  refine ⟨?_, singles_any_order_verifies h 12 _ hN hmono,
    singles_any_order_no_fork h hinj 12 _ hN hmono⟩
  have h1 : target (noFiles : Files C H) 11 11 = 11 := by
    simp only [target, Nat.lt_irrefl, ite_false]
    exact newestFrom_self _ _ _ (fun k _ _ => rfl)
  let S1 := sstep h 12 11 (noFiles : Files C H) (11, c1)
  have h2 : target S1 11 10 = 11 := by
    simp only [target, show ¬ (11 < 10) by decide, ite_false]
    refine newestFrom_top S1 10 11 (by decide) ?_ 12 (by decide) ?_
    · simp [S1, sstep, h1, appendRun]
    · intro k hk1 hk2; omega
  show (sstep h 12 11 S1 (10, c2)) 10 = []
  simp only [sstep, h2, appendRun]
  simp [S1, sstep, h1, appendRun, noFiles]

/-- The clamp, third review: in October (current month 10) an event stamped November
is written to October's file, no November file is started, and an October event after
it links to it — the log verifies with no break and no reported fork. -/
theorem future_stamp_joins_current (h : HashFn C H) (hinj : HashInjective h) (c1 c2 : C) :
    (timedFiles h 12 noFiles [(10, 11, c1), (10, 10, c2)]) 11 = [] ∧
    walk h none none 0 (flat (timedFiles h 12 noFiles [(10, 11, c1), (10, 10, c2)]) 12) = [] ∧
    ¬ ReportsFork (flat (timedFiles h 12 noFiles [(10, 11, c1), (10, 10, c2)]) 12) := by
  have hN : ∀ x ∈ [((10 : Nat), (11 : Nat), c1), (10, 10, c2)], x.1 < 12 := by
    intro x hx; simp at hx; rcases hx with rfl | rfl <;> simp
  have hmono : [((10 : Nat), (11 : Nat), c1), (10, 10, c2)].Pairwise (fun a b => a.1 ≤ b.1) := by
    simp
  refine ⟨?_, singles_any_order_verifies h 12 _ hN hmono,
    singles_any_order_no_fork h hinj 12 _ hN hmono⟩
  have hb : NoLaterThan (timedFiles h 12 noFiles [(10, 11, c1), (10, 10, c2)]) 10 := by
    simp only [timedFiles, List.foldl_cons, List.foldl_nil]
    exact noLaterThan_sstep h 12 10 10 _ _
      (noLaterThan_sstep h 12 10 10 _ _ (fun _ _ => rfl) (Nat.le_refl _)) (Nat.le_refl _)
  exact hb 11 (by decide)

end FileOrder

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

/-- `nothingChecked` (commit c21b371e, 0.23 audit finding 12): engrams are listed, but
none MATCHED and none CHANGED — every one was NOT AVAILABLE. -/
def nothingChecked [DecidableEq K] (rh : R → K) (store : Nat → Option (Engram R B))
    (es : List (Entry K)) : Bool :=
  !es.isEmpty && !(es.any (fun en => checkEntry rh store en == .match_)) &&
    !(es.any (fun en => checkEntry rh store en == .changed))

/-- `ok: counts.CHANGED === 0 && !nothingChecked` (commit c21b371e). -/
def manifestOk [DecidableEq K] (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K)) : Bool :=
  !(es.any (fun en => checkEntry rh store en == .changed)) && !nothingChecked rh store es

variable [DecidableEq K]

theorem check_cases (c : Check) : c = .match_ ∨ c = .changed ∨ c = .notAvailable := by
  cases c <;> simp

/-- Nothing was checked exactly when engrams are listed and every one is NOT AVAILABLE. -/
theorem nothingChecked_iff (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K)) :
    nothingChecked rh store es = true ↔
      es ≠ [] ∧ ∀ en ∈ es, checkEntry rh store en = .notAvailable := by
  simp only [nothingChecked, Bool.and_eq_true, Bool.not_eq_true', List.isEmpty_eq_false_iff,
    List.any_eq_false, beq_iff_eq]
  constructor
  · rintro ⟨⟨hne, hm⟩, hc⟩
    refine ⟨hne, fun en hen => ?_⟩
    rcases check_cases (checkEntry rh store en) with h | h | h
    · exact absurd h (hm en hen)
    · exact absurd h (hc en hen)
    · exact h
  · rintro ⟨hne, ha⟩
    exact ⟨⟨hne, fun en hen h => by rw [ha en hen] at h; cases h⟩,
      fun en hen h => by rw [ha en hen] at h; cases h⟩

/-- `ok` is false iff some entry is CHANGED, or engrams are listed and every one is
NOT AVAILABLE (a check of nothing is not a pass). -/
theorem ok_false_iff_changed (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K)) :
    manifestOk rh store es = false ↔
      (∃ en ∈ es, checkEntry rh store en = .changed) ∨
      (es ≠ [] ∧ ∀ en ∈ es, checkEntry rh store en = .notAvailable) := by
  rw [← nothingChecked_iff]
  cases hn : nothingChecked rh store es <;> simp [manifestOk, hn]

/-- An empty manifest (no engram listed) is still ok. -/
theorem empty_manifest_ok (rh : R → K) (store : Nat → Option (Engram R B)) :
    manifestOk rh store ([] : List (Entry K)) = true := by
  simp [manifestOk, nothingChecked]

/-- A manifest checked where none of its engrams is held is not ok. -/
theorem all_not_available_not_ok (rh : R → K) (store : Nat → Option (Engram R B))
    (es : List (Entry K)) (hne : es ≠ [])
    (ha : ∀ en ∈ es, checkEntry rh store en = .notAvailable) :
    manifestOk rh store es = false :=
  (ok_false_iff_changed rh store es).mpr (Or.inr ⟨hne, ha⟩)

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

/-! ## 9. `plur verify --manifest` exit codes (commit c21b371e)

`runManifest` in `packages/cli/src/commands/verify-manifest.ts` and
`checkNotarySignature` in `packages/cli/src/lib/notary.ts`. Where the expected notary
comes from is the rule at the end of this section (`expectedNotary`, `downloadSource`);
the exit theorems below hold whatever that rule yields. -/

/-- The first notary signature on a downloaded document. `coversData`: its
`hashed_fields` is absent or includes `"data"` (otherwise `checkNotarySignature`
returns `signature_ok = false` at once). `checks`: the data hash matches, the message
format is known, and the recovered address equals the claimed signer. `fromExpected`:
the recovered address equals the expected notary (`expectedNotary`: pinned with `--notary`; else
the default notary for the default gateway; else, only with `--trust-gateway-notary`,
the address the gateway names). -/
structure NotarySig where
  coversData : Bool
  checks : Bool
  fromExpected : Bool

/-- `notary.signature_ok` after the expected-notary comparison. -/
def sigOk (s : NotarySig) : Bool := s.coversData && s.checks && s.fromExpected

/-- Where the manifest came from. A Swarm download carries the content-hash check, the
first notary signature (`none` = the document has none) and whether an expected notary
address exists (`(expectedNotary …).isSome`, see `downloadSource`). -/
inductive Source where
  | file
  | swarm (contentHashOk : Bool) (sig : Option NotarySig) (expected : Bool)

/-- The download returns cannot-verify before the manifest is checked: no notary
signature, or no notary address to check it against. -/
def preCannot : Source → Bool
  | .swarm _ none _ => true
  | .swarm _ (some _) false => true
  | _ => false

/-- `integrityOk = integrity === null || (content_hash_ok && notary !== null &&
notary.signature_ok)`. The cases `preCannot` covers never reach it; they are `false`. -/
def integrityOk : Source → Bool
  | .file => true
  | .swarm c (some s) true => c && sigOk s
  | .swarm _ _ _ => false

/-- How `runManifest` ends. `cannot` covers the other `cannot(...)` returns: no such file
or reference, download failure, no data field, not JSON, not a manifest
(`verifyManifest` throws). `checked changed nothing src`: the manifest was checked;
`changed` is `counts.CHANGED > 0`, `nothing` is `nothingChecked`. -/
inductive Outcome where
  | cannot
  | checked (changed : Bool) (nothing : Bool) (src : Source)

def exitCode : Outcome → Nat
  | .cannot => 2
  | .checked ch nc s =>
    if preCannot s then 2
    else if integrityOk s && nc then 2
    else if !ch && integrityOk s then 0 else 1

theorem integrityOk_not_preCannot (s : Source) (h : integrityOk s = true) : preCannot s = false := by
  match s, h with
  | .file, _ => rfl
  | .swarm _ (some _) true, _ => rfl

/-- Exit 0 exactly when the manifest was checked, nothing CHANGED, something was checked,
and the integrity checks pass (for a download: content hash ok and a notary signature
present, covering the data, valid, and from the expected notary). -/
theorem exit_zero_iff (o : Outcome) :
    exitCode o = 0 ↔ ∃ ch nc s, o = .checked ch nc s ∧ ch = false ∧ nc = false ∧ integrityOk s = true := by
  cases o with
  | cannot => simp [exitCode]
  | checked ch nc s =>
      simp only [exitCode, Outcome.checked.injEq]
      constructor
      · intro h0
        refine ⟨ch, nc, s, ⟨rfl, rfl, rfl⟩, ?_⟩
        cases hp : preCannot s <;> cases hi : integrityOk s <;> cases ch <;> cases nc <;> simp_all
      · rintro ⟨ch', nc', s', ⟨rfl, rfl, rfl⟩, hc, hn, hi⟩
        simp [hc, hn, hi, integrityOk_not_preCannot _ hi]

/-- Exit 2 exactly when it cannot verify: an early `cannot`, a download with no notary
signature or no notary address, or integrity passing while nothing was checked. -/
theorem exit_two_iff_cannot (o : Outcome) :
    exitCode o = 2 ↔ o = .cannot ∨
      ∃ ch nc s, o = .checked ch nc s ∧ (preCannot s = true ∨ (integrityOk s = true ∧ nc = true)) := by
  cases o with
  | cannot => simp [exitCode]
  | checked ch nc s =>
      simp only [exitCode, Outcome.checked.injEq, reduceCtorEq, false_or]
      constructor
      · intro h2
        refine ⟨ch, nc, s, ⟨rfl, rfl, rfl⟩, ?_⟩
        cases hp : preCannot s <;> cases hi : integrityOk s <;> cases ch <;> cases nc <;> simp_all
      · rintro ⟨ch', nc', s', ⟨rfl, rfl, rfl⟩, h⟩
        rcases h with h | ⟨hi, hn⟩
        · simp [h]
        · simp [hi, hn, integrityOk_not_preCannot _ hi]

theorem cannot_never_zero : exitCode .cannot ≠ 0 := by decide

/-- A downloaded document with no notary signature is cannot-verify. -/
theorem no_signature_cannot (ch nc c e : Bool) :
    exitCode (.checked ch nc (.swarm c none e)) = 2 := by
  simp [exitCode, preCannot]

/-- A signature with no expected notary address is cannot-verify: no pin and a gateway
other than the default one, untrusted (`untrusted_other_gateway_cannot`) or trusted
but naming none. -/
theorem no_notary_address_cannot (ch nc c : Bool) (s : NotarySig) :
    exitCode (.checked ch nc (.swarm c (some s) false)) = 2 := by
  simp [exitCode, preCannot]

/-- Listed engrams none of which is in this store (nothing checked), integrity passing:
cannot-verify. -/
theorem nothing_checked_cannot (ch : Bool) (s : Source) (hi : integrityOk s = true) :
    exitCode (.checked ch true s) = 2 := by
  simp [exitCode, hi, integrityOk_not_preCannot s hi]

/-- A Swarm download whose bytes do not match the stored content hash, or whose notary
signature fails (invalid, from another signer, or not covering `data`), exits 1. -/
theorem bad_integrity_not_zero (ch nc c : Bool) (s : NotarySig)
    (h : c = false ∨ sigOk s = false) : exitCode (.checked ch nc (.swarm c (some s) true)) = 1 := by
  rcases h with h | h <;> simp [exitCode, preCannot, integrityOk, h]

/-- A signature whose `hashed_fields` omit `"data"` fails the signature check. -/
theorem signature_must_cover_data (ch nc c : Bool) (s : NotarySig) (h : s.coversData = false) :
    exitCode (.checked ch nc (.swarm c (some s) true)) = 1 :=
  bad_integrity_not_zero ch nc c s (Or.inr (by simp [sigOk, h]))

/-- The outcome of checking manifest entries `es` against `store`, from source `src`. -/
def outcomeOf (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K))
    (src : Source) : Outcome :=
  .checked (es.any (fun en => checkEntry rh store en == .changed)) (nothingChecked rh store es) src

/-- Exit 0 iff `verifySessionManifest` says ok and the integrity checks pass. -/
theorem exit_zero_iff_ok (rh : R → K) (store : Nat → Option (Engram R B)) (es : List (Entry K))
    (src : Source) :
    exitCode (outcomeOf rh store es src) = 0 ↔ manifestOk rh store es = true ∧ integrityOk src = true := by
  rw [exit_zero_iff]
  simp only [outcomeOf, Outcome.checked.injEq, manifestOk, Bool.and_eq_true, Bool.not_eq_true']
  constructor
  · rintro ⟨ch, nc, s, ⟨h1, h2, rfl⟩, rfl, rfl, hi⟩
    exact ⟨⟨h1, h2⟩, hi⟩
  · rintro ⟨⟨h1, h2⟩, hi⟩
    exact ⟨_, _, _, ⟨rfl, rfl, rfl⟩, h1, h2, hi⟩

/-! ### Which notary a download is checked against (0.23 code review, finding 9)

`expectedNotaryFor(gateway, pinned)` in `packages/gateway/src/client.ts`, then the
`--trust-gateway-notary` fallback in `runManifest`: the pinned notary (`--notary`);
else, for the default gateway, the default notary (`DEFAULT_NOTARY_ADDRESS`); else
nothing — unless `--trust-gateway-notary` accepts the address the gateway reports
about itself (`notaryAddress()`, `named`). Addresses are compared after lower-casing;
the model's `A` is the normalised address. `isDefault` is `isDefaultGateway(url)`. -/

inductive NotarySource where
  | pinned
  | default_
  | gateway
  deriving DecidableEq

def expectedNotary {A : Type} (dflt : A) (isDefault : Bool) (pinned : Option A) (trust : Bool)
    (named : Option A) : Option (A × NotarySource) :=
  match pinned with
  | some a => some (a, .pinned)
  | none =>
    if isDefault then some (dflt, .default_)
    else if trust then named.map (fun a => (a, .gateway)) else none

section Notary
variable {A : Type}

theorem expected_pinned (dflt : A) (isDefault : Bool) (a : A) (trust : Bool) (named : Option A) :
    expectedNotary dflt isDefault (some a) trust named = some (a, .pinned) := rfl

/-- The default gateway is checked against the default notary, whatever the gateway
says about itself and whether or not it is trusted. -/
theorem expected_default_gateway (dflt : A) (trust : Bool) (named : Option A) :
    expectedNotary dflt true none trust named = some (dflt, .default_) := rfl

/-- Without `--trust-gateway-notary`, what the gateway reports about itself never
changes the expected notary. -/
theorem expected_ignores_gateway_claim (dflt : A) (isDefault : Bool) (pinned : Option A)
    (named named' : Option A) :
    expectedNotary dflt isDefault pinned false named = expectedNotary dflt isDefault pinned false named' := by
  cases pinned <;> cases isDefault <;> rfl

/-- Another gateway, no pin, not trusted: no expected notary. -/
theorem other_gateway_untrusted_none (dflt : A) (named : Option A) :
    expectedNotary dflt false none false named = none := rfl

/-- The gateway's own claim is used only when it is trusted, nothing is pinned and the
gateway is not the default one. -/
theorem gateway_source_needs_trust (dflt : A) (isDefault : Bool) (pinned : Option A) (trust : Bool)
    (named : Option A) (a : A) (h : expectedNotary dflt isDefault pinned trust named = some (a, .gateway)) :
    trust = true ∧ isDefault = false ∧ pinned = none ∧ named = some a := by
  cases pinned with
  | some p => simp [expectedNotary] at h
  | none =>
      cases isDefault <;> cases trust <;> cases named <;> simp_all [expectedNotary]

/-- A notary signature as `checkNotarySignature` reads it: `coversData`, `checks` (data
hash, message format, recovery equal to the claimed signer) and the `recovered`
address. -/
structure DownloadSig (A : Type) where
  coversData : Bool
  checks : Bool
  recovered : A

/-- The `Source` a download yields: `fromExpected` is the recovered address equalling
the expected notary; `expected` is whether there is one. -/
def downloadSource [DecidableEq A] (c : Bool) (sig : Option (DownloadSig A))
    (exp : Option (A × NotarySource)) : Source :=
  .swarm c (sig.map fun s => ⟨s.coversData, s.checks,
    match exp with
    | some (a, _) => decide (s.recovered = a)
    | none => false⟩) exp.isSome

variable [DecidableEq A]

/-- §9's exit-0 theorem for a download, with the expected notary spelled out: exit 0
iff nothing CHANGED, something was checked, the bytes match, and the signature covers
`data`, checks, and was made by the expected notary. -/
theorem download_exit_zero_iff (ch nc c : Bool) (sig : Option (DownloadSig A))
    (exp : Option (A × NotarySource)) :
    exitCode (.checked ch nc (downloadSource c sig exp)) = 0 ↔
      ch = false ∧ nc = false ∧ c = true ∧ ∃ s a src, sig = some s ∧ exp = some (a, src) ∧
        s.coversData = true ∧ s.checks = true ∧ s.recovered = a := by
  rw [exit_zero_iff]
  simp only [Outcome.checked.injEq]
  constructor
  · rintro ⟨ch', nc', s', ⟨rfl, rfl, rfl⟩, hc, hn, hi⟩
    refine ⟨hc, hn, ?_⟩
    cases sig with
    | none => simp [downloadSource, integrityOk] at hi
    | some s =>
        cases exp with
        | none => simp [downloadSource, integrityOk] at hi
        | some e =>
            obtain ⟨a, src⟩ := e
            simp [downloadSource, integrityOk, sigOk] at hi
            exact ⟨hi.1, s, a, src, rfl, rfl, hi.2.1.1, hi.2.1.2, hi.2.2⟩
  · rintro ⟨hc, hn, hcc, s, a, src, rfl, rfl, h1, h2, h3⟩
    refine ⟨ch, nc, _, ⟨rfl, rfl, rfl⟩, hc, hn, ?_⟩
    simp [downloadSource, integrityOk, sigOk, hcc, h1, h2, h3]

/-- A download from a gateway that is not the default one, with no `--notary` pin and
no `--trust-gateway-notary`, is cannot-verify (exit 2), signature or not. -/
theorem untrusted_other_gateway_cannot (ch nc c : Bool) (dflt : A) (sig : Option (DownloadSig A))
    (named : Option A) :
    exitCode (.checked ch nc (downloadSource c sig (expectedNotary dflt false none false named))) = 2 := by
  cases sig <;> simp [expectedNotary, downloadSource, exitCode, preCannot]

/-- Finding 9, the attack: without `--trust-gateway-notary`, an exit 0 means the
signature was made by the pinned notary, or (no pin, default gateway) by the default
notary — never by an address only the gateway vouches for. -/
theorem exit_zero_untrusted_signer (ch nc c : Bool) (dflt : A) (isDefault : Bool) (pinned : Option A)
    (sig : Option (DownloadSig A)) (named : Option A)
    (h : exitCode (.checked ch nc (downloadSource c sig (expectedNotary dflt isDefault pinned false named))) = 0) :
    ∃ s, sig = some s ∧
      (pinned = some s.recovered ∨ (pinned = none ∧ isDefault = true ∧ s.recovered = dflt)) := by
  obtain ⟨_, _, _, s, a, src, hs, he, _, _, hr⟩ := (download_exit_zero_iff ch nc c sig _).mp h
  refine ⟨s, hs, ?_⟩
  cases pinned with
  | some p =>
      simp [expectedNotary] at he
      left; rw [he.1, hr]
  | none =>
      cases isDefault with
      | true =>
          simp [expectedNotary] at he
          right; exact ⟨rfl, rfl, by rw [hr, he.1]⟩
      | false => simp [expectedNotary] at he

end Notary

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

/-! ## 11. The store check (`verifyChain`, code review of 0.23 finding 2, commit e52b7e9b)

The newest checkpoint attests the store (`store_hash`) and, since e52b7e9b, the same
records split into `STORE_BUCKETS` = 64 groups by a hash of the id (`storeBucketOf`),
each fingerprinted (`store_buckets`). When the store's hash differs from the attested
one, `verifyChain` asks whether the difference is explained: every group whose
fingerprint moved must hold an id that a content event after the checkpoint names
(`CONTENT_EVENTS`, including `store_synced`, which a sync pull records, and
`store_compacted`, which `compact()` records naming every removed row; ids from
`eventEngramIds`: the event's `engram_id`, the fixed id fields of `data` read
verbatim, and elsewhere in `data` only string values that are a whole ENG/ABS/META
id, never an id inside free text). Explained: `store_changed_since_checkpoint`. Otherwise a
`store_hash_mismatch` break. A checkpoint written before groups existed falls back to
"any content event since explains it".

Modelled abstractly. A store is `I → Option V` (each id's attested record — status
and record hash — or absent). `bucket : I → G` is `storeBucketOf` (`G` is `Fin 64` in
the code; any type here). A group's fingerprint `fp` reads only the records of that
group (`restrict`); `fp` (16 hex, truncated) and `sh` (the store hash) are collision
free only as hypotheses (`FpInjective`, `StoreHashInjective`). `after` lists, per
content event after the checkpoint, the ids it names — `eventEngramIds`' output, so
which strings count as an id is outside the model, and the theorems hold for any such
rule. The store being unreadable or
absent (`cannot_verify`, the `attestedCount` rule) is not modelled. -/

section StoreCheck
variable {I V G F Hs : Type} [DecidableEq G]

abbrev Store (I V : Type) := I → Option V

/-- The records of group `g` only: what one group fingerprint reads. -/
def restrict (bucket : I → G) (s : Store I V) (g : G) : Store I V :=
  fun i => if bucket i = g then s i else none

/-- `attestStore(...).store_buckets`. -/
def buckets (bucket : I → G) (fp : Store I V → F) (s : Store I V) : G → F :=
  fun g => fp (restrict bucket s g)

def FpInjective (fp : Store I V → F) : Prop := ∀ a b, fp a = fp b → a = b
def StoreHashInjective (sh : Store I V → Hs) : Prop := ∀ a b, sh a = sh b → a = b

/-- `attestedBuckets.every((b, i) => b === actualBuckets[i] || named.has(i))`. -/
def ExplainedBy (bucket : I → G) (fp : Store I V → F) (A : G → F) (s : Store I V)
    (after : List (List I)) : Prop :=
  ∀ g, A g = buckets bucket fp s g ∨ ∃ i ∈ after.flatten, bucket i = g

/-- `explained`: by groups when the checkpoint has them, else `since > 0`. -/
def Explained (bucket : I → G) (fp : Store I V → F) (attested : Option (G → F)) (s : Store I V)
    (after : List (List I)) : Prop :=
  match attested with
  | none => after ≠ []
  | some A => ExplainedBy bucket fp A s after

/-- A `store_hash_mismatch` break: the store hash differs and the difference is not
explained. `s0` is the store the checkpoint attested. -/
def StoreBreak (sh : Store I V → Hs) (bucket : I → G) (fp : Store I V → F) (s0 : Store I V)
    (attested : Option (G → F)) (s : Store I V) (after : List (List I)) : Prop :=
  sh s ≠ sh s0 ∧ ¬ Explained bucket fp attested s after

/-- (a) Soundness of localisation: an edit to a memory whose group no recorded event
names is always reported — whatever else history records. -/
theorem unrecorded_edit_reported (sh : Store I V → Hs) (bucket : I → G) (fp : Store I V → F)
    (hsh : StoreHashInjective sh) (hfp : FpInjective fp) (s0 s : Store I V)
    (after : List (List I)) (i : I) (hi : s i ≠ s0 i)
    (hnamed : ∀ j ∈ after.flatten, bucket j ≠ bucket i) :
    StoreBreak sh bucket fp s0 (some (buckets bucket fp s0)) s after := by
  refine ⟨fun heq => hi (by rw [hsh _ _ heq]), fun hex => ?_⟩
  have hex' : ExplainedBy bucket fp (buckets bucket fp s0) s after := hex
  rcases hex' (bucket i) with hb | ⟨j, hj, hji⟩
  · have hr := congrFun (hfp _ _ hb) i
    simp [restrict] at hr
    exact hi hr.symm
  · exact hnamed j hj hji

/-- (b) Recorded changes alone never break: when every changed memory shares a group
with an id a content event since the checkpoint names, the check passes. -/
theorem recorded_changes_never_break (sh : Store I V → Hs) (bucket : I → G) (fp : Store I V → F)
    (s0 s : Store I V) (after : List (List I))
    (hrec : ∀ i, s i ≠ s0 i → ∃ j ∈ after.flatten, bucket j = bucket i) :
    ¬ StoreBreak sh bucket fp s0 (some (buckets bucket fp s0)) s after := by
  rintro ⟨_, hne⟩
  apply hne
  show ExplainedBy bucket fp (buckets bucket fp s0) s after
  intro g
  by_cases hg : restrict bucket s0 g = restrict bucket s g
  · left; simp only [buckets, hg]
  · right
    have : ∃ i, restrict bucket s0 g i ≠ restrict bucket s g i :=
      Classical.byContradiction fun hall =>
        hg (funext fun i => Classical.byContradiction fun hi => hall ⟨i, hi⟩)
    obtain ⟨i, hi⟩ := this
    simp only [restrict] at hi
    by_cases hbi : bucket i = g
    · rw [ite_eq_left hbi, ite_eq_left hbi] at hi
      obtain ⟨j, hj, hji⟩ := hrec i (Ne.symm hi)
      exact ⟨j, hj, hji.trans hbi⟩
    · rw [ite_eq_right hbi, ite_eq_right hbi] at hi; exact absurd rfl hi

/-- (b), the plain case: every changed memory is itself named by a content event since
the checkpoint (PLUR's own writes, and a sync pull's `store_synced`). -/
theorem named_changes_never_break (sh : Store I V → Hs) (bucket : I → G) (fp : Store I V → F)
    (s0 s : Store I V) (after : List (List I))
    (hrec : ∀ i, s i ≠ s0 i → i ∈ after.flatten) :
    ¬ StoreBreak sh bucket fp s0 (some (buckets bucket fp s0)) s after :=
  recorded_changes_never_break sh bucket fp s0 s after (fun i hi => ⟨i, hrec i hi, rfl⟩)

/-- An untouched store never breaks, groups or not. -/
theorem unchanged_store_never_breaks (sh : Store I V → Hs) (bucket : I → G) (fp : Store I V → F)
    (s0 : Store I V) (attested : Option (G → F)) (after : List (List I)) :
    ¬ StoreBreak sh bucket fp s0 attested s0 after := fun h => h.1 rfl

/-- (c) The limit, as a counterexample: an unrecorded edit to memory `i` in the same group
as a recorded change to `j` is not detected. With 64 groups and `storeBucketOf` uniform
(`sha256(id)[0] % 64`, and 256 is a multiple of 64), one unrecorded edit escapes with
probability about the share of groups that recorded changes touch: `1/64` (≈1.6%) beside
one recorded memory, `1 - (63/64)^n` beside `n` — about half at `n = 44`. That is an
intuition about random ids, not a theorem: someone choosing which memory to edit can
always pick one in a group that history names. -/
theorem unrecorded_edit_beside_recorded_undetected (sh : Store I V → Hs) (bucket : I → G)
    (fp : Store I V → F) (s0 s : Store I V) (after : List (List I)) (i j : I)
    (hj : j ∈ after.flatten) (hij : bucket i = bucket j)
    (honly : ∀ k, s k ≠ s0 k → k = i ∨ k = j) :
    ¬ StoreBreak sh bucket fp s0 (some (buckets bucket fp s0)) s after := by
  apply recorded_changes_never_break
  intro k hk
  rcases honly k hk with rfl | rfl
  · exact ⟨j, hj, hij.symm⟩
  · exact ⟨k, hj, rfl⟩

/-- The fallback for a checkpoint written before groups existed: one content event
explains every difference, an unrecorded edit included (the behaviour finding 2
reported, still that of old checkpoints until the next one is written). -/
theorem legacy_checkpoint_one_event_excuses_all (sh : Store I V → Hs) (bucket : I → G)
    (fp : Store I V → F) (s0 s : Store I V) (after : List (List I)) (hne : after ≠ []) :
    ¬ StoreBreak sh bucket fp s0 none s after := fun h => h.2 hne

end StoreCheck

end PlurSpec.Provenance
