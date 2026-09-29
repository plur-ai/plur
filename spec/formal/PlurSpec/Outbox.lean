/-!
# PlurSpec.Outbox — delivery of queued team writes (field report, cluster 3)

Models `flushOutbox` / `_flushOutboxClaimed`, learn()'s immediate push and
learnRouted()'s direct write in `packages/core/src/index.ts`, the per-entry
claims (`_claimOutboxEntry`), the D2 row leases (`outbox-lease.ts`), the
refusal classification (`outbox-health.ts`) and the per-host breaker as the two
legs feed it. The remote-store surface itself (lookup by key, in-process host
mark, feedback payload) is in `R2CoreB.lean` §5–§7.
Findings, verdicts and replays: `spec/formal/findings/outbox.md`.

Everything about one LOGICAL write. Keys are opaque naturals; the server is
one of two kinds (`docs/remote-store-contract.md`): `honour` deduplicates POSTs
by key and answers lookup by key; `ignore` does neither. What the network does
to each attempt is an adversarial outcome chosen per event, so every theorem
holds for every schedule of outcomes.

Left out (stated as assumptions in the findings): the 7-day dedup window (a
retry after it on an honouring server is treated as inside it), a server that
honours lookup but not dedup (or the reverse), a claim file that cannot be
written at all, and a reset-after-commit network error (`netBefore` is a
failure BEFORE the server stored anything; §3 counts the other kind as
"silent").
-/

namespace PlurSpec.Outbox

/-! ## 1. The server -/

inductive Server where
  | honour
  | ignore
  deriving DecidableEq

/-- Rows the server holds for this logical write, as the keys they were posted with. -/
def post : Server → List Nat → Nat → List Nat
  | .honour, rows, k => if k ∈ rows then rows else k :: rows
  | .ignore, rows, k => k :: rows

/-- Honouring server, one key: whatever interleaving of POSTs (any number of
pushers, any retries), the write is stored at most once. -/
theorem honour_one_key (k : Nat) :
    ∀ (n : List Unit) (rows : List Nat), (rows = [] ∨ rows = [k]) →
      let r := n.foldl (fun rs _ => post .honour rs k) rows
      r = [] ∨ r = [k] := by
  intro n
  induction n with
  | nil => intro rows h; exact h
  | cons _ t ih =>
    intro rows h
    apply ih
    rcases h with h | h <;> subst h <;> simp [post]

/-- Two keys for one logical write: an honouring server keeps two rows. -/
theorem honour_two_keys_dup (k₁ k₂ : Nat) (h : k₁ ≠ k₂) :
    (post .honour (post .honour [] k₁) k₂).length = 2 := by
  simp [post, Ne.symm h]

/-! ## 2. Key choice (candidate 2)

`_claimOutboxEntry(id, orphanKey => outbox.idempotency_key ?? orphanKey ?? randomUUID())`.
An entry queued by learn()/learnRouted() carries its key from birth; one
queued by an older client does not, and the flush mints it. The minted key
lives in the claim file until the merge-back persists it on the row. -/

def keyFor (onRow orphan : Option Nat) (fresh : Nat) : Nat :=
  (onRow <|> orphan).getD fresh

/-- What survives a flush that minted `k` for a key-less entry, cut its POST,
and then threw before the merge-back: the key on the row (never written) and
the claim file. `keepDoubted` = the claim of an in-doubt entry is kept. -/
def afterThrow (keepDoubted : Bool) (k : Nat) : Option Nat × Option Nat :=
  (none, if keepDoubted then some k else none)

/-- Current code (`finally` releases every claim not `settled`; a cut push is
not settled): the next flush mints a different key. -/
theorem thrown_merge_new_key (k fresh : Nat) (h : fresh ≠ k) :
    let s := afterThrow false k
    keyFor s.1 s.2 fresh ≠ k := by
  simp [afterThrow, keyFor, h]

/-- … and on an honouring server both POSTs land: a duplicate. Replayed. -/
theorem thrown_merge_dup (k fresh : Nat) (h : fresh ≠ k) :
    let s := afterThrow false k
    (post .honour (post .honour [] k) (keyFor s.1 s.2 fresh)).length = 2 := by
  simp [afterThrow, keyFor, post, h]

/-- Keeping the claim of an in-doubt entry keeps the key. -/
theorem kept_claim_same_key (k fresh : Nat) :
    let s := afterThrow true k
    keyFor s.1 s.2 fresh = k := rfl

/-- A key already on the row always wins (learn/learnRouted entries). -/
theorem row_key_stable (k : Nat) (orphan : Option Nat) (fresh : Nat) :
    keyFor (some k) orphan fresh = k := rfl

/-! ## 3. One pusher at a time: retries, cuts, crashes (candidates 1a, 1b)

Key fixed (§2 handles its choice). `rows` counts stored copies; `silent` is a
ghost counter of attempts that LANDED while the client recorded a definite
failure (not in doubt) and kept the entry queued. -/

inductive Outcome where
  | ok                       -- stored and answered
  | refused                  -- HTTP error: not stored
  | netBefore                -- network failure before the server stored it
  | timeout (landed : Bool)  -- RemoteTimeoutError / budget cut
  | crash (landed : Bool)    -- process gone before recording anything

/-- The three design switches the code fixes. -/
structure Cfg where
  /-- learn()/learnRouted() record a timed-out first push as in doubt. -/
  firstDoubt : Bool
  /-- a thrown flush keeps the in-doubt mark (claim) of a cut push. -/
  keepOnThrow : Bool
  /-- a crash mid-POST leaves a claim file, so the next flush sees it in doubt. -/
  claims : Bool

def current : Cfg := ⟨false, false, true⟩
def fixed   : Cfg := ⟨true, true, true⟩
/-- Conflict I, "leases alone": no claim file survives a crash. -/
def leasesOnly : Cfg := ⟨false, false, false⟩

structure St where
  rows   : Nat
  queued : Bool
  doubt  : Bool
  silent : Nat

inductive Ev where
  /-- learn()'s immediate push (the row is already saved with `_outbox`). -/
  | first (o : Outcome)
  /-- one flush attempt; `thr` = its merge-back throws. -/
  | flush (o : Outcome) (thr : Bool)

/-- Record an attempt that posted. `rec` = would a timeout be recorded in doubt. -/
def afterPost (c : Cfg) (rec : Bool) (s : St) : Outcome → St
  | .ok => { s with rows := s.rows + 1, queued := false }
  | .refused | .netBefore => s
  | .timeout l =>
    let r := s.rows + (if l then 1 else 0)
    { s with rows := r, doubt := rec, silent := s.silent + (if l && !rec then 1 else 0) }
  | .crash l =>
    let r := s.rows + (if l then 1 else 0)
    { s with rows := r, doubt := c.claims, silent := s.silent + (if l && !c.claims then 1 else 0) }

/-- Key-ignoring server: an in-doubt entry is probed, the answer is always
`unknown`, and nothing is posted (`probe.status === 'unknown'` → `continue`). -/
def step (c : Cfg) (s : St) : Ev → St
  | .first o => if s.queued && !s.doubt then afterPost c c.firstDoubt s o else s
  | .flush o thr =>
    if !s.queued || s.doubt then s
    else afterPost c (!thr || c.keepOnThrow) s o

def run (c : Cfg) (s : St) (es : List Ev) : St := es.foldl (step c) s

def start : St := ⟨0, true, false, 0⟩

/-- Invariant: undoubted and queued ⇒ every stored copy was a silent landing;
and at most one copy beyond the silent ones. -/
def Inv (s : St) : Prop :=
  (s.queued = true → s.doubt = false → s.rows ≤ s.silent) ∧ s.rows ≤ s.silent + 1 ∧
  (s.queued = false → 1 ≤ s.rows)

theorem inv_afterPost (c : Cfg) (rec : Bool) (s : St) (o : Outcome)
    (hq : s.queued = true) (hd : s.doubt = false) (h : Inv s) : Inv (afterPost c rec s o) := by
  have h0 := h.1 hq hd
  have h2 := h.2.1
  cases o with
  | ok => simp [afterPost, Inv]; omega
  | refused => exact h
  | netBefore => exact h
  | timeout l =>
    cases l <;> cases rec <;> simp [afterPost, Inv, hq] <;> omega
  | crash l =>
    cases l <;> cases hc : c.claims <;> simp [afterPost, Inv, hq, hc] <;> omega

theorem inv_step (c : Cfg) (s : St) (e : Ev) (h : Inv s) : Inv (step c s e) := by
  cases e with
  | first o =>
    unfold step
    cases hq : s.queued <;> cases hd : s.doubt <;> simp <;> try exact h
    exact inv_afterPost c _ s o hq hd h
  | flush o thr =>
    unfold step
    cases hq : s.queued <;> cases hd : s.doubt <;> simp <;> try exact h
    exact inv_afterPost c _ s o hq hd h

theorem inv_run (c : Cfg) (es : List Ev) : ∀ s, Inv s → Inv (run c s es) := by
  induction es with
  | nil => intro s h; exact h
  | cons e t ih => intro s h; exact ih _ (inv_step c s e h)

/-- **Precise duplicate bound (key-ignoring server), any design, any schedule:**
copies ≤ 1 + silent landings, and a write is never dropped locally before a
copy is stored. -/
theorem ignore_bound (c : Cfg) (es : List Ev) :
    (run c start es).rows ≤ (run c start es).silent + 1 ∧
    ((run c start es).queued = false → 1 ≤ (run c start es).rows) := by
  have h := inv_run c es start ⟨fun _ _ => Nat.le_refl 0, by simp [start], by simp [start]⟩
  exact ⟨h.2.1, h.2.2⟩

/-- Silent landings only come from the switches that are off. -/
theorem afterPost_silent_ge (c : Cfg) (rec : Bool) (s : St) (o : Outcome) :
    s.silent ≤ (afterPost c rec s o).silent := by
  cases o <;> simp [afterPost]

theorem step_cases (c : Cfg) (s : St) (e : Ev) :
    step c s e = s ∨ ∃ rec o, step c s e = afterPost c rec s o := by
  cases e with
  | first o =>
    simp only [step]; split
    · exact Or.inr ⟨_, o, rfl⟩
    · exact Or.inl rfl
  | flush o thr =>
    simp only [step]; split
    · exact Or.inl rfl
    · exact Or.inr ⟨_, o, rfl⟩

theorem silent_mono (c : Cfg) (s : St) (e : Ev) : s.silent ≤ (step c s e).silent := by
  rcases step_cases c s e with h | ⟨rec, o, h⟩ <;> rw [h]
  · exact Nat.le_refl _
  · exact afterPost_silent_ge ..

theorem fixed_step_cases (s : St) (e : Ev) :
    step fixed s e = s ∨ ∃ o, step fixed s e = afterPost fixed true s o := by
  cases e with
  | first o =>
    simp only [step]; split
    · exact Or.inr ⟨o, rfl⟩
    · exact Or.inl rfl
  | flush o thr =>
    simp only [step]; split
    · exact Or.inl rfl
    · exact Or.inr ⟨o, by simp [fixed]⟩

theorem fixed_no_silent (s : St) (e : Ev) : (step fixed s e).silent = s.silent := by
  rcases fixed_step_cases s e with h | ⟨o, h⟩ <;> rw [h]
  cases o <;> simp [afterPost, fixed]

theorem fixed_run_silent (es : List Ev) : ∀ s, (run fixed s es).silent = s.silent := by
  induction es with
  | nil => intro s; rfl
  | cons e t ih => intro s; simp only [run, List.foldl] at *; rw [ih, fixed_no_silent]

/-- **Fixed design: exactly once** on a key-ignoring server too — at most one
copy, and none dropped. -/
theorem fixed_at_most_once (es : List Ev) :
    (run fixed start es).rows ≤ 1 ∧
    ((run fixed start es).queued = false → 1 ≤ (run fixed start es).rows) := by
  have ⟨h1, h2⟩ := ignore_bound fixed es
  have h3 : (run fixed start es).silent = 0 := fixed_run_silent es start
  exact ⟨by omega, h2⟩

/-- Non-vacuity: delivered after a refusal and a network failure. -/
theorem fixed_delivers :
    let s := run fixed start [.first .refused, .flush .netBefore false, .flush .ok false]
    s.rows = 1 ∧ s.queued = false := by decide

/-- Candidate 1a counterexample (current code): learn()'s / learnRouted()'s
first push times out after the server stored it; it is not recorded in doubt,
so the next flush posts it again unprobed. Replayed. -/
theorem firstLeg_timeout_dup :
    (run current start [.first (.timeout true), .flush .ok false]).rows = 2 := by decide

/-- Candidate 1b counterexample: a flush's cut POST landed, its merge-back
threw, the claim was released — the next flush posts again. Replayed. -/
theorem thrown_merge_loses_doubt :
    (run current start [.first .refused, .flush (.timeout true) true, .flush .ok false]).rows = 2 := by
  decide

/-- The good case of 1b: the same cut with a merge-back that lands is probed. -/
theorem cut_recorded_no_dup :
    let s := run current start [.first .refused, .flush (.timeout true) false, .flush .ok false]
    s.rows = 1 ∧ s.queued = true ∧ s.doubt = true := by decide

/-- **"At most one duplicate", stated precisely, for the current code:** on a
key-ignoring server, in any schedule whose merge-backs never throw, there are
at most two copies — the only silent landing is the first push. -/
theorem current_flush_no_silent (s : St) (o : Outcome) :
    (step current s (.flush o false)).silent = s.silent := by
  simp only [step]; split
  · rfl
  · cases o <;> simp [afterPost, current]

theorem current_flushes_no_silent (l : List Outcome) :
    ∀ s, (run current s (l.map (fun o => .flush o false))).silent = s.silent := by
  induction l with
  | nil => intro s; rfl
  | cons o t ih =>
    intro s
    show (run current (step current s (.flush o false)) (t.map (fun o => .flush o false))).silent = s.silent
    rw [ih, current_flush_no_silent]

theorem current_first_silent (o : Outcome) : (step current start (.first o)).silent ≤ 1 := by
  cases o with
  | timeout l => cases l <;> decide
  | crash l => cases l <;> decide
  | ok => decide
  | refused => decide
  | netBefore => decide

theorem current_no_throw_le_two (o : Outcome) (os : List Outcome) :
    (run current start (.first o :: os.map (fun o => .flush o false))).rows ≤ 2 := by
  have hb := (ignore_bound current (.first o :: os.map (fun o => .flush o false))).1
  have hs : (run current start (.first o :: os.map (fun o => .flush o false))).silent ≤ 1 := by
    show (run current (step current start (.first o)) (os.map (fun o => .flush o false))).silent ≤ 1
    rw [current_flushes_no_silent]
    exact current_first_silent o
  omega

/-- Conflict I: with leases alone a crash after the POST landed is silent,
so the next flush (after the lease TTL) duplicates. Replayed. -/
theorem leases_alone_crash_dup :
    (run leasesOnly start [.first .refused, .flush (.crash true) false, .flush .ok false]).rows = 2 := by
  decide

/-- … and with the claim it is probed instead. Replayed. -/
theorem claims_crash_no_dup :
    (run current start [.first .refused, .flush (.crash true) false, .flush .ok false]).rows = 1 := by
  decide

/-! ## 4. Concurrent pushers with claims alone (conflict I)

Any number of pushers (flushes in several processes, learn()'s background
push) contend for one entry, with NO lease. A claim file is `none`, `live p`,
or `stale p` (its 60 s lease ran out or its process is gone). Takeover of a
stale claim is atomic (a rename over it) and marks the entry in doubt; the
pusher then probes (`unknown` on a key-ignoring server) and releases.
`flyer` = the pusher whose unprobed POST is outstanding; `landed` = the server
has stored it. The model overwrites `flyer` on a second unprobed claim, so
`no_second_flyer` is what rules that out. -/

inductive Claim (P : Type) where
  | none
  | live (p : P)
  | stale (p : P)

structure C (P : Type) where
  rows   : Nat
  queued : Bool
  doubt  : Bool
  file   : Claim P
  flyer  : Option P
  landed : Bool

inductive Answer where
  | ok | definite | doubtful

inductive CEv (P : Type) where
  | claim (p : P)
  | lapse
  | land
  | answer (a : Answer)

variable {P : Type} [DecidableEq P]

def release (p : P) : Claim P → Claim P
  | .live q => if q = p then .none else .live q
  | .stale q => if q = p then .none else .stale q
  | .none => .none

def cstep (s : C P) : CEv P → C P
  | .claim p =>
    if !s.queued then s else
    match s.file with
    | .none => if s.doubt then s else { s with file := .live p, flyer := some p, landed := false }
    | .live _ => s
    | .stale _ => { s with doubt := true, file := .none }
  | .lapse =>
    match s.file with
    | .live q => { s with file := .stale q }
    | _ => s
  | .land =>
    if s.flyer.isSome && !s.landed then { s with rows := s.rows + 1, landed := true } else s
  | .answer a =>
    match s.flyer with
    | none => s
    | some p =>
      let done := { s with flyer := none, landed := false, file := release p s.file }
      match a with
      | .ok => { done with rows := if s.landed then s.rows else s.rows + 1, queued := false }
      | .definite => if s.landed then s else done
      | .doubtful => { done with doubt := true }

def CInv (s : C P) : Prop :=
  (∀ p, s.flyer = some p → (s.file = .live p ∨ s.file = .stale p ∨ s.doubt = true)) ∧
  (s.landed = true → s.flyer.isSome = true) ∧
  (s.flyer.isSome = true → s.queued = true) ∧
  s.rows ≤ 1 ∧
  (s.queued = true → s.doubt = false → s.rows = 1 → s.landed = true) ∧
  (s.landed = true → s.rows = 1) ∧
  (s.flyer.isSome = true → s.landed = false → s.rows = 0)

theorem cinv_step (s : C P) (e : CEv P) (h : CInv s) : CInv (cstep s e) := by
  obtain ⟨j1, j2, j3, j4, j5, j6, j7⟩ := h
  cases e with
  | claim p =>
    cases hq : s.queued
    · simp only [cstep, hq, Bool.not_false, ↓reduceIte]; exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
    · cases hf : s.file with
      | none =>
        cases hd : s.doubt
        · -- a new unprobed claimer: nobody else is flying, so nothing is stored
          have hfl : s.flyer = none := by
            cases hfy : s.flyer with
            | none => rfl
            | some q => have := j1 q hfy; simp [hf, hd] at this
          have hl : s.landed = false := by
            cases hl : s.landed
            · rfl
            · have := j2 hl; simp [hfl] at this
          have hr : s.rows = 0 := by
            cases hr : s.rows with
            | zero => rfl
            | succ n =>
              have h1 : s.rows = 1 := by omega
              have := j5 hq hd h1; simp [hl] at this
          simp only [cstep, hq, hf, hd, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
          refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
        · simp only [cstep, hq, hf, hd, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
          exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
      | live q =>
        simp only [cstep, hq, hf, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
        exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
      | stale q =>
        simp only [cstep, hq, hf, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
        refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
  | lapse =>
    cases hf : s.file with
    | live q =>
      simp only [cstep, hf]
      refine ⟨?_, j2, j3, j4, j5, j6, j7⟩
      intro r hr
      rcases j1 r hr with h | h | h
      · rw [hf] at h; cases h; exact Or.inr (Or.inl rfl)
      · rw [hf] at h; cases h
      · exact Or.inr (Or.inr h)
    | none => simp only [cstep, hf]; exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
    | stale q => simp only [cstep, hf]; exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
  | land =>
    by_cases hc : (s.flyer.isSome && !s.landed) = true
    · simp only [cstep, hc, ↓reduceIte]
      simp at hc
      obtain ⟨hs, hl⟩ := hc
      have hr := j7 hs hl
      refine ⟨j1, ?_, j3, ?_, ?_, ?_, ?_⟩ <;> simp_all
    · simp only [cstep, hc, Bool.false_eq_true, ↓reduceIte]
      exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
  | answer a =>
    cases hfy : s.flyer with
    | none => simp only [cstep, hfy]; exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
    | some p =>
      have hs : s.flyer.isSome = true := by simp [hfy]
      cases a with
      | ok =>
        cases hl : s.landed
        · have := j7 hs hl
          simp only [cstep, hfy, hl]
          refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
        · have := j6 hl
          simp only [cstep, hfy, hl]
          refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
      | definite =>
        cases hl : s.landed
        · have := j7 hs hl
          simp only [cstep, hfy, hl]
          refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
        · simp only [cstep, hfy, hl, ↓reduceIte]; exact ⟨j1, j2, j3, j4, j5, j6, j7⟩
      | doubtful =>
        simp only [cstep, hfy]
        refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp_all

def crun (s : C P) (es : List (CEv P)) : C P := es.foldl cstep s

theorem cinv_run (es : List (CEv P)) : ∀ s : C P, CInv s → CInv (crun s es) := by
  induction es with
  | nil => intro s h; exact h
  | cons e t ih => intro s h; exact ih _ (cinv_step s e h)

/-- A queued entry with nothing stored yet and any claim file. (A crash that
left a stored copy behind a stale claim is §3's `claims_crash_no_dup`.) -/
def cstart (f : Claim P) : C P := ⟨0, true, false, f, none, false⟩

omit [DecidableEq P] in
theorem cinv_start (f : Claim P) : CInv (cstart f) := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp [cstart]

/-- **Claims alone suffice (key-ignoring server):** under any interleaving of
any number of pushers, lapses and answers, at most one copy is stored. -/
theorem claims_suffice (f : Claim P) (es : List (CEv P)) : (crun (cstart f) es).rows ≤ 1 :=
  (cinv_run es _ (cinv_start f)).2.2.2.1

omit [DecidableEq P] in
/-- The mechanism behind it: a second unprobed claim never happens while one
is flying. -/
theorem no_second_flyer (s : C P) (h : CInv s) (hn : s.file = .none) (hd : s.doubt = false) : s.flyer = none := by
  cases hfy : s.flyer with
  | none => rfl
  | some r => have := h.1 r hfy; simp [hn, hd] at this

/-- Non-vacuity: two pushers, one delivers; the other is kept out. -/
theorem claims_deliver :
    let s := crun (cstart (P := Fin 2) .none)
      [.claim 0, .claim 1, .land, .claim 1, .answer .ok, .claim 1]
    s.rows = 1 ∧ s.queued = false := by decide

/-- Non-vacuity: the pusher's claim lapses mid-POST, a second pusher takes it
over — in doubt, probed, not posted. -/
theorem claims_lapse_takeover :
    let s := crun (cstart (P := Fin 2) .none)
      [.claim 0, .land, .lapse, .claim 1, .claim 1, .answer .doubtful]
    s.rows = 1 ∧ s.doubt = true ∧ s.queued = true := by decide

/-! ## 5. Why the takeover must be atomic (only without leases)

`_claimOutboxEntry` takes over a stale claim with `rmSync` then an O_EXCL
write. Between the two, the path is free: a second claimer that reads it then
writes a FRESH, non-orphan claim, and the in-doubt knowledge of the stale one
is lost (the orphan-taker then fails EEXIST and reports busy). With leases the
two claimers never reach one row together, so this is masked today. -/

inductive F where
  | none | stale | fresh
  deriving DecidableEq

/-- Claimer program counter: 0 read, 1 read-saw-stale (will rm, then write),
2 about to write, 3 done. `orphan` = it saw a stale claim. -/
structure Cl where
  pc : Nat
  orphan : Bool
  got : Bool
  deriving DecidableEq

/-- One step of claimer `c` against file `f` (non-atomic rm-then-write). -/
def clStep (f : F) (c : Cl) : F × Cl :=
  match c.pc with
  | 0 => match f with
    | .none => (f, { c with pc := 2 })
    | .stale => (f, { c with pc := 1, orphan := true })
    | .fresh => (f, { c with pc := 3 })
  | 1 => (.none, { c with pc := 2 })
  | 2 => if f = .none then (.fresh, { c with pc := 3, got := true }) else (f, { c with pc := 3 })
  | _ => (f, c)

def clRun : F × Cl × Cl → List Bool → F × Cl × Cl
  | st, [] => st
  | (f, a, b), true :: t => let (f', a') := clStep f a; clRun (f', a', b) t
  | (f, a, b), false :: t => let (f', b') := clStep f b; clRun (f', a, b') t

/-- Counterexample: A reads stale, removes it; B reads the free path and
claims NON-orphan; A's write fails. B posts unprobed although a crashed POST
may have landed. -/
theorem nonatomic_takeover_loses_doubt :
    let r := clRun (.stale, ⟨0, false, false⟩, ⟨0, false, false⟩) [true, true, false, false, true]
    r.2.2.got = true ∧ r.2.2.orphan = false ∧ r.2.1.got = false := by decide

/-- Atomic takeover (rename over the stale file): the path is never free, so
over a stale claim every claimer that gets it is an orphan (→ probes). -/
def clStepA (f : F) (c : Cl) : F × Cl :=
  match c.pc with
  | 0 => match f with
    | .none => (.fresh, { c with pc := 3, got := true })
    | .stale => (.fresh, { c with pc := 3, orphan := true, got := true })
    | .fresh => (f, { c with pc := 3 })
  | _ => (f, c)

theorem atomic_never_none (f : F) (c : Cl) (h : f ≠ .none) : (clStepA f c).1 ≠ .none := by
  unfold clStepA; split
  · cases f <;> simp_all
  · exact h

theorem atomic_got_orphan_step (f : F) (c : Cl) (h : f ≠ .none) (hc : c.got = true → c.orphan = true) :
    (clStepA f c).2.got = true → (clStepA f c).2.orphan = true := by
  unfold clStepA; split
  · cases f <;> simp_all
  · exact hc

/-! ## 6. Leases: selection under the store lock is a test-and-set -/

/-- Two selections serialised by the store lock: the second sees the first's
live lease. At most one wins while the lease lives. -/
def select (leased : Bool) : Bool × Bool := (true, !leased)

theorem lease_excludes : (select (select false).1).2 = false := rfl

/-! ## 7. The per-host breaker (candidate 4)

A failure feeds the persisted per-host breaker (`recordWriteOutcome` /
recall's `networkFailure`) or not. `none` = a network error. -/

def refusal (s : Nat) : Bool := s == 401 || s == 403 || s == 404 || s == 422

/-- Write leg (`flushOutbox`, #1308): counts unless the host answered a refusal. -/
def writeCounts : Option Nat → Bool
  | none => true
  | some s => !refusal s

/-- Recall leg (`remoteRecall.dialHost`): 401/403/404/429 have their own
branches (and reset the counter); every other non-ok status counts. -/
def recallCounts : Option Nat → Bool
  | none => true
  | some s => !(s == 401 || s == 403 || s == 404 || s == 429)

theorem write_refusal_never_counts (s : Nat) (h : refusal s = true) : writeCounts (some s) = false := by
  simp [writeCounts, h]

theorem write_5xx_counts : writeCounts (some 503) = true ∧ writeCounts none = true := by decide

theorem recall_401_403_404_no_count :
    recallCounts (some 401) = false ∧ recallCounts (some 403) = false ∧ recallCounts (some 404) = false := by
  decide

/-- Counterexample: a 422 on recall counts toward the same breaker, which
`flushOutbox` obeys (`isHostInCooldown`). Replayed. -/
theorem recall_422_counts : recallCounts (some 422) = true := by decide

/-- The fix the property asks for: route 422 with the refusals. -/
def recallCountsFixed (s : Option Nat) : Bool := writeCounts s && recallCounts s

theorem recall_fixed_refusal (s : Nat) (h : refusal s = true) : recallCountsFixed (some s) = false := by
  simp [recallCountsFixed, writeCounts, h]

/-! ## 8. needs_action entries (candidate 3)

An entry's local identity (scope, target, content) versus its retry
bookkeeping. One flush of one entry, branch for branch: `held` (back-off
window, automatic flush) or `unconfirmed` → untouched; otherwise the same
code path as a `retrying` entry: policy demotion (a verdict of the CURRENT
scope policy, not of the entry's state), success (hand-off), or failure
(bookkeeping only). -/

structure Entry (β : Type) where
  scope  : String
  target : String
  body   : Nat
  book   : β

inductive Res (β : Type) where
  | kept (e : Entry β)
  | handedOff
  | demoted (e : Entry β)

/-- `offends` and `delivered` are oracles; `bump` is the bookkeeping update. -/
def flushEntry {β : Type} (bump : β → β) (skip offends delivered : Bool) (e : Entry β) : Res β :=
  if skip then .kept e
  else if offends then .demoted { e with scope := "local" }
  else if delivered then .handedOff
  else .kept { e with book := bump e.book }

/-- Held/unconfirmed: exactly as it was. -/
theorem held_untouched {β} (bump : β → β) (o d : Bool) (e : Entry β) :
    flushEntry bump true o d e = .kept e := rfl

/-- A kept entry keeps scope, target and content: only bookkeeping changes. -/
theorem kept_only_bookkeeping {β} (bump : β → β) (sk o d : Bool) (e e' : Entry β)
    (h : flushEntry bump sk o d e = .kept e') :
    e'.scope = e.scope ∧ e'.target = e.target ∧ e'.body = e.body := by
  unfold flushEntry at h
  split at h
  · cases h; exact ⟨rfl, rfl, rfl⟩
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h; exact ⟨rfl, rfl, rfl⟩

/-- "Never for being needs_action": once dialled, a needs_action entry takes
the same branch as a retrying one — the verdict enters only through `skip`. -/
def skipOf (force needsAction inWindow unconfirmed : Bool) : Bool :=
  unconfirmed || (!force && needsAction && inWindow)

theorem verdict_only_skips {β} (bump : β → β) (o d f w u : Bool) (e : Entry β)
    (h : skipOf f true w u = false) :
    flushEntry bump (skipOf f true w u) o d e = flushEntry bump (skipOf f false w u) o d e := by
  have : skipOf f false w u = false := by cases f <;> cases w <;> cases u <;> simp_all [skipOf]
  rw [h, this]

theorem force_dials_needs_action (w : Bool) : skipOf true true w false = false := by
  cases w <;> rfl

/-! ## 9. Automatic feedback reaches only capable remotes (candidate 5)

`Plur.feedback`: both remote send sites (`scope`-targeted and the walk) call
`driver.feedback` only after `remoteAccepts(driver)` = `!auto || capable`, and
send `source: 'auto'` exactly when `auto`. `capable` is the cached `/me`
answer (a failed `/me` caches `[]`). -/

def remoteAccepts (auto capable : Bool) : Bool := !auto || capable

/-- What goes on the wire: `none` = not sent, `some src` = sent with that `source`. -/
def sent (auto capable : Bool) : Option Bool :=
  if remoteAccepts auto capable then some auto else none

theorem auto_only_to_capable (auto capable : Bool) (h : sent auto capable = some true) :
    capable = true := by
  cases auto <;> cases capable <;> simp_all [sent, remoteAccepts]

theorem explicit_always_sent (capable : Bool) : sent false capable = some false := by
  cases capable <;> rfl

theorem auto_capable_sent : sent true true = some true := rfl

end PlurSpec.Outbox
