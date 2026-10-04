/-!
# PlurSpec.R2Persist — round 2 of the persistence cluster

Models of `packages/core/src/{store/async-lock.ts, sync.ts, engrams.ts, backup.ts,
storage-pglite.ts, storage-postgres.ts, migrations/runner.ts}`.
Findings, verdicts and replays: `spec/formal/findings/r2-persist.md`.

Checked against commit af693450 (2026-09-27): storage-postgres.ts changed only `initSchema`'s
unlock failure path (the init advisory lock; modelled by `Persistence.PgLock`). The save/dup-id
paths these sections model (`resolveSaveBatch`, rename listeners) are untouched, so every
theorem here still holds.

Checked against the pre-merge audit fixes (commit c0ddc498, 2026-09-27): sync.ts now writes the
held records to a durable recovery file before resetting the tree (crash safety is modelled and
proved in Persistence §Sync, "Round 3": `crash_safe`, `recover_no_loss`), and engrams.ts records
duplicate-id renames on the next write instead of on every load. This file's DupIds and Restore
sections model WHICH ids are renamed and that every record stays readable — not when the history
event is written — so `resolve_ids_distinct`, `resolve_no_loss`, `restore_both_reachable` and the
rest still hold.

Checked against #1349 (merged into #1228 on 2026-09-30): still holds.
`withAsyncLock` now increments and decrements a per-process counter
(`pendingStoreLockOps`) around the same `processLocks.run(… withFileLock …)`
call. The counter only observes. Acquire, the crash-safe steal and release
are unchanged.
-/

set_option linter.deprecated false
set_option linter.unusedSimpArgs false

namespace PlurSpec.R2Persist

def upd {β : Type} (f : Nat → β) (p : Nat) (v : β) : Nat → β :=
  fun q => if q = p then v else f q

def upd2 {β : Type} (f : Nat → Nat → β) (h k : Nat) (v : β) : Nat → Nat → β :=
  fun h' k' => if h' = h ∧ k' = k then v else f h' k'

/-! ## 1. Lock steal with crash-safe guard (async-lock.ts `stealLock`,
`acquireStealSlot`, `clearStealSlots`; sync twin `stealLockSync`)

Round 1 (`Persistence.Lock`) proved mutual exclusion with ONE guard file, in a model
where a process that takes the guard never dies. Its residual: a guard abandoned by
a crashed stealer was removed by an unguarded read-then-unlink, and a double fault
reopened the race. Here processes die at any step (`dead` is state, monotone), and
the guard is the fixed code's ladder: slot `k` of the ladder for judged token `h` is
`slot h k`; its owner is the token written into it. -/
namespace Guard

/-! ### Before the fix: one guard, cleared by read-then-unlink (executable). -/

structure OS where
  lock  : Option Nat
  hold  : Nat → Bool
  dead  : Nat → Bool
  guard : Option Nat
  /-- the stale token a guard-holder has re-read at the lock -/
  seen  : Nat → Option Nat
  claim : Nat → Option (Nat × Nat)
  /-- `clearAbandonedGuard` read an abandoned guard and is about to unlink -/
  clr   : Nat → Bool

inductive OAct where
  | acq (p : Nat) | gAcq (p : Nat) | gRead (p h : Nat) | rename (p : Nat) | finish (p : Nat)
  | gRel (p : Nat) | clrRead (p : Nat) | clrUnlink (p : Nat)

def finishLock (lock : Option Nat) (h x : Nat) : Option Nat :=
  if x = h then lock else (if lock = none then some x else lock)

def ostep (s : OS) : OAct → Option OS
  | .acq p => if s.dead p = false ∧ s.lock = none then
      some { s with lock := some p, hold := upd s.hold p true } else none
  | .gAcq p => if s.dead p = false ∧ s.guard = none then
      some { s with guard := some p } else none
  | .gRead p h => if s.dead p = false ∧ s.guard = some p ∧ s.dead h = true ∧ s.lock = some h then
      some { s with seen := upd s.seen p (some h) } else none
  | .rename p => match s.seen p, s.lock with
      | some h, some x => if s.dead p = false then
          some { s with claim := upd s.claim p (some (h, x)), lock := none,
                        seen := upd s.seen p none } else none
      | _, _ => none
  | .finish p => match s.claim p with
      | some (h, x) => some { s with lock := finishLock s.lock h x, claim := upd s.claim p none }
      | none => none
  -- `releaseIfOurs(guard)`: token-checked.
  | .gRel p => some { s with guard := if s.guard = some p then none else s.guard }
  -- `clearAbandonedGuard`: stat + read: the guard's writer is dead.
  | .clrRead p => match s.guard with
      | some g => if s.dead p = false ∧ s.dead g = true then some { s with clr := upd s.clr p true }
                  else none
      | none => none
  -- ... then `unlink(guard)` — whatever sits there now.
  | .clrUnlink p => if s.clr p = true then
      some { s with guard := none, clr := upd s.clr p false } else none

def orun : OS → List OAct → Option OS
  | s, [] => some s
  | s, a :: as => match ostep s a with
    | some s' => orun s' as
    | none => none

/-- H=9 holds the lock and is dead; stealer S=5 crashed inside the guard. -/
def oinit : OS :=
  ⟨some 9, fun _ => false, fun p => p == 9 || p == 5, some 5, fun _ => none, fun _ => none,
   fun _ => false⟩

/-- **Counterexample (replayed: `formal-r2-persist-guard.test.ts`, maxInCS = 2).**
A=1 and B=2 both judge S's guard abandoned; A unlinks it, takes the guard, re-reads
H; B's unlink removes A's LIVE guard; B takes the guard and re-reads H too. A claims H
and acquires; B's rename moves A's live lock aside; C=3 acquires; B's put-back
loses. A and C are both in the critical section. -/
theorem old_two_holders :
    (orun oinit
      [.clrRead 1, .clrRead 2, .clrUnlink 1, .gAcq 1, .gRead 1 9, .clrUnlink 2, .gAcq 2,
       .gRead 2 9, .rename 1, .finish 1, .gRel 1, .acq 1, .rename 2, .acq 3, .finish 2]).map
      (fun s => (s.hold 1, s.hold 3)) = some (true, true) := by decide

/-! ### The fix: a guard ladder per judged token, verified after creation. -/

inductive Pc where
  | idle
  | scan (h k : Nat)
  | verify (h k i : Nat)
  | crit (h k : Nat)
  | seen (h k : Nat)
  | claimed (h k x : Nat)
  | done (h k : Nat) (ok : Bool)
  deriving DecidableEq

/-- The judged token of a stealing process. -/
def Pc.tok : Pc → Option Nat
  | .idle => none
  | .scan h _ | .verify h _ _ | .crit h _ | .seen h _ | .claimed h _ _ | .done h _ _ => some h

/-- The slot a process believes it holds. -/
def Pc.held : Pc → Option (Nat × Nat)
  | .idle | .scan _ _ => none
  | .verify h k _ | .crit h k | .seen h k | .claimed h k _ | .done h k _ => some (h, k)

/-- How many lower slots it has verified abandoned. -/
def Pc.low : Pc → Nat
  | .idle | .scan _ _ => 0
  | .verify _ _ i => i
  | .crit _ k | .seen _ k | .claimed _ k _ | .done _ k _ => k

structure S where
  lock : Option Nat
  hold : Nat → Bool
  dead : Nat → Bool
  slot : Nat → Nat → Option Nat
  pc   : Nat → Pc

/-- `releaseIfOurs(slot, token)`. -/
def relSlot (sl : Nat → Nat → Option Nat) (h k p : Nat) : Option Nat :=
  if sl h k = some p then none else sl h k

/-- One step of the fixed protocol. Every step but `die` is taken by a live process. -/
inductive Step : S → S → Prop
  | acq (p : Nat) (s : S) : s.dead p = false → s.pc p = .idle → s.lock = none →
      Step s { s with lock := some p, hold := upd s.hold p true }
  | rel (p : Nat) (s : S) : s.dead p = false → s.hold p = true →
      Step s { s with hold := upd s.hold p false,
                      lock := if s.lock = some p then none else s.lock }
  /-- `withFileLock` judged the lock abandoned (liveness false): `stealLock(lock, h)`. -/
  | start (p h : Nat) (s : S) : s.dead p = false → s.pc p = .idle → s.dead h = true →
      s.lock = some h → Step s { s with pc := upd s.pc p (.scan h 0) }
  /-- O_EXCL create of slot k succeeds. -/
  | scanNew (p h k : Nat) (s : S) : s.dead p = false → s.pc p = .scan h k → s.slot h k = none →
      Step s { s with slot := upd2 s.slot h k (some p), pc := upd s.pc p (.verify h k 0) }
  /-- EEXIST and the slot's writer is dead: walk up. -/
  | scanSkip (p h k q : Nat) (s : S) : s.dead p = false → s.pc p = .scan h k →
      s.slot h k = some q → s.dead q = true → Step s { s with pc := upd s.pc p (.scan h (k+1)) }
  /-- Live or vanished slot, other errors, out of slots: return and re-evaluate. -/
  | scanStop (p h k : Nat) (s : S) : s.dead p = false → s.pc p = .scan h k →
      Step s { s with pc := upd s.pc p .idle }
  /-- Verification: lower slot i still exists and its writer is dead. -/
  | verOk (p h k i q : Nat) (s : S) : s.dead p = false → s.pc p = .verify h k i → i < k →
      s.slot h i = some q → s.dead q = true → Step s { s with pc := upd s.pc p (.verify h k (i+1)) }
  | verDone (p h k : Nat) (s : S) : s.dead p = false → s.pc p = .verify h k k →
      Step s { s with pc := upd s.pc p (.crit h k) }
  /-- A lower slot live or gone: release our slot, re-evaluate. -/
  | verFail (p h k i : Nat) (s : S) : s.dead p = false → s.pc p = .verify h k i →
      Step s { s with slot := upd2 s.slot h k (relSlot s.slot h k p), pc := upd s.pc p .idle }
  /-- `now === expected` under the guard. -/
  | read (p h k : Nat) (s : S) : s.dead p = false → s.pc p = .crit h k →
      Step s { s with pc := upd s.pc p (if s.lock = some h then .seen h k else .done h k false) }
  | rename (p h k x : Nat) (s : S) : s.dead p = false → s.pc p = .seen h k → s.lock = some x →
      Step s { s with lock := none, pc := upd s.pc p (.claimed h k x) }
  | renameFail (p h k : Nat) (s : S) : s.dead p = false → s.pc p = .seen h k → s.lock = none →
      Step s { s with pc := upd s.pc p (.done h k false) }
  /-- `claimAndRemove` tail; `ok` = the claim is confirmed. -/
  | finish (p h k x : Nat) (s : S) : s.dead p = false → s.pc p = .claimed h k x →
      Step s { s with lock := finishLock s.lock h x, pc := upd s.pc p (.done h k (decide (x = h))) }
  /-- `clearStealSlots`: after a confirmed claim, unlink any slot of the ladder. -/
  | clean (p h k j : Nat) (s : S) : s.dead p = false → s.pc p = .done h k true →
      Step s { s with slot := upd2 s.slot h j none }
  | release (p h k : Nat) (b : Bool) (s : S) : s.dead p = false → s.pc p = .done h k b →
      Step s { s with slot := upd2 s.slot h k (relSlot s.slot h k p), pc := upd s.pc p .idle }
  /-- A crash, at any point. -/
  | die (p : Nat) (s : S) : s.dead p = false → Step s { s with dead := upd s.dead p true }

structure Inv (s : S) : Prop where
  holders : ∀ q, s.hold q = true → s.dead q = false → s.lock = some q
  tokDead : ∀ p h, s.dead p = false → (s.pc p).tok = some h → s.dead h = true
  seen    : ∀ p h k, s.dead p = false → s.pc p = .seen h k → s.lock = some h
  claims  : ∀ p h k x, s.dead p = false → s.pc p = .claimed h k x → x = h ∧ s.lock ≠ some h
  doneOk  : ∀ p h k, s.dead p = false → s.pc p = .done h k true → s.lock ≠ some h
  own     : ∀ p h k, s.dead p = false → (s.pc p).held = some (h, k) → s.lock = some h →
              s.slot h k = some p
  lower   : ∀ p h k j, s.dead p = false → (s.pc p).held = some (h, k) → j < (s.pc p).low →
              s.lock = some h → ∃ q, s.slot h j = some q ∧ s.dead q = true

theorem heldTok (c : Pc) (h k : Nat) (e : c.held = some (h, k)) : c.tok = some h := by
  cases c <;> simp_all [Pc.held, Pc.tok]

/-- The ladder's exclusion: two live processes past verification for the same judged
token, while that token is still the lock, are the same process. -/
theorem excl (s : S) (hi : Inv s) (p p' h k k' : Nat) (hp : s.dead p = false)
    (hp' : s.dead p' = false) (hh : (s.pc p).held = some (h, k)) (hl : (s.pc p).low = k)
    (hh' : (s.pc p').held = some (h, k')) (hl' : (s.pc p').low = k')
    (hL : s.lock = some h) : p = p' := by
  have o := hi.own p h k hp hh hL
  have o' := hi.own p' h k' hp' hh' hL
  rcases Nat.lt_trichotomy k k' with hk | hk | hk
  · obtain ⟨q, hq, hdq⟩ := hi.lower p' h k' k hp' hh' (by omega) hL
    rw [o] at hq; cases hq; rw [hp] at hdq; cases hdq
  · subst hk; rw [o] at o'; cases o'; rfl
  · obtain ⟨q, hq, hdq⟩ := hi.lower p h k k' hp hh (by omega) hL
    rw [o'] at hq; cases hq; rw [hp'] at hdq; cases hdq

/-- Steps that only change process `p`'s program counter. -/
theorem inv_pc (s : S) (hi : Inv s) (p : Nat) (c : Pc) (hp : s.dead p = false)
    (hTok : ∀ h, c.tok = some h → s.dead h = true)
    (hSeen : ∀ h k, c = .seen h k → s.lock = some h)
    (hClaim : ∀ h k x, c = .claimed h k x → x = h ∧ s.lock ≠ some h)
    (hDone : ∀ h k, c = .done h k true → s.lock ≠ some h)
    (hOwn : ∀ h k, c.held = some (h, k) → s.lock = some h → s.slot h k = some p)
    (hLow : ∀ h k j, c.held = some (h, k) → j < c.low → s.lock = some h →
      ∃ q, s.slot h j = some q ∧ s.dead q = true) :
    Inv { s with pc := upd s.pc p c } := by
  refine ⟨hi.holders, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp only [upd]
  · intro p' h hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; exact hTok h ht
    · rw [if_neg e] at ht; exact hi.tokDead p' h hd ht
  · intro p' h k hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; exact hSeen h k ht
    · rw [if_neg e] at ht; exact hi.seen p' h k hd ht
  · intro p' h k x hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; exact hClaim h k x ht
    · rw [if_neg e] at ht; exact hi.claims p' h k x hd ht
  · intro p' h k hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; exact hDone h k ht
    · rw [if_neg e] at ht; exact hi.doneOk p' h k hd ht
  · intro p' h k hd ht hL; by_cases e : p' = p
    · rw [if_pos e] at ht; subst e; exact hOwn h k ht hL
    · rw [if_neg e] at ht; exact hi.own p' h k hd ht hL
  · intro p' h k j hd ht hj hL; by_cases e : p' = p
    · rw [if_pos e] at ht hj; exact hLow h k j ht hj hL
    · rw [if_neg e] at ht hj; exact hi.lower p' h k j hd ht hj hL

/-- Releasing a slot one holds (`verFail`, `release`) and going idle. -/
theorem inv_relSlot (s : S) (hi : Inv s) (p h k : Nat) (hp : s.dead p = false)
    (hh : (s.pc p).held = some (h, k)) :
    Inv { s with slot := upd2 s.slot h k (relSlot s.slot h k p), pc := upd s.pc p .idle } := by
  refine ⟨hi.holders, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp only [upd]
  · intro p' h' hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; cases ht
    · rw [if_neg e] at ht; exact hi.tokDead p' h' hd ht
  · intro p' h' k' hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; cases ht
    · rw [if_neg e] at ht; exact hi.seen p' h' k' hd ht
  · intro p' h' k' x hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; cases ht
    · rw [if_neg e] at ht; exact hi.claims p' h' k' x hd ht
  · intro p' h' k' hd ht; by_cases e : p' = p
    · rw [if_pos e] at ht; cases ht
    · rw [if_neg e] at ht; exact hi.doneOk p' h' k' hd ht
  · intro p' h' k' hd ht hL; by_cases e : p' = p
    · rw [if_pos e] at ht; cases ht
    · rw [if_neg e] at ht
      have o := hi.own p' h' k' hd ht hL
      simp only [upd2, relSlot]
      by_cases hk : h' = h ∧ k' = k
      · rw [if_pos hk]; obtain ⟨rfl, rfl⟩ := hk
        have op := hi.own p h' k' hp hh hL
        rw [o] at op; cases op; exact absurd rfl e
      · rw [if_neg hk]; exact o
  · intro p' h' k' j hd ht hj hL; by_cases e : p' = p
    · rw [if_pos e] at ht; cases ht
    · rw [if_neg e] at ht hj
      obtain ⟨q, hq, hdq⟩ := hi.lower p' h' k' j hd ht hj hL
      refine ⟨q, ?_, hdq⟩
      simp only [upd2, relSlot]
      by_cases hk : h' = h ∧ j = k
      · obtain ⟨rfl, rfl⟩ := hk
        have op := hi.own p h' j hp hh hL
        rw [op] at hq; cases hq; rw [hp] at hdq; cases hdq
      · rw [if_neg hk]; exact hq

set_option maxHeartbeats 1000000 in
theorem inv_step (s s' : S) (hi : Inv s) (hs : Step s s') : Inv s' := by
  cases hs with
  | acq p s hd hpc hl =>
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · intro q hq hdq; simp only [upd] at hq ⊢
      by_cases e : q = p
      · subst e; rfl
      · rw [if_neg e] at hq; have := hi.holders q hq hdq; rw [hl] at this; cases this
    · exact hi.tokDead
    · intro p' h k hd ht; have := hi.seen p' h k hd ht; rw [hl] at this; cases this
    · intro p' h k x hd' ht
      refine ⟨(hi.claims p' h k x hd' ht).1, ?_⟩
      intro e; cases e
      have := hi.tokDead p' p hd' (by rw [ht]; rfl); rw [hd] at this; cases this
    · intro p' h k hd' ht e; cases e
      have := hi.tokDead p' p hd' (by rw [ht]; rfl); rw [hd] at this; cases this
    · intro p' h k hd' ht e; cases e
      have := hi.tokDead p' p hd' (heldTok _ _ k ht)
      rw [hd] at this; cases this
    · intro p' h k j hd' ht hj e; cases e
      have := hi.tokDead p' p hd' (heldTok _ _ k ht)
      rw [hd] at this; cases this
  | rel p s hd hh =>
    have hlp := hi.holders p hh hd
    have keep : ∀ h, (if s.lock = some p then none else s.lock) = some h → s.lock = some h := by
      intro h e; rw [if_pos hlp] at e; cases e
    have keepN : ∀ h, s.lock ≠ some h → (if s.lock = some p then none else s.lock) ≠ some h := by
      intro h _ e; exact absurd (keep h e) (by assumption)
    refine ⟨?_, hi.tokDead, ?_, ?_, ?_, ?_, ?_⟩
    · intro q hq hdq; simp only [upd] at hq ⊢
      by_cases e : q = p
      · rw [if_pos e] at hq; cases hq
      · rw [if_neg e] at hq; have := hi.holders q hq hdq; rw [hlp] at this; cases this
        exact absurd rfl e
    · intro p' h k hd' ht
      have := hi.seen p' h k hd' ht; rw [hlp] at this; cases this
      have := hi.tokDead p' p hd' (by rw [ht]; rfl); rw [hd] at this; cases this
    · intro p' h k x hd' ht
      exact ⟨(hi.claims p' h k x hd' ht).1, keepN h (hi.claims p' h k x hd' ht).2⟩
    · intro p' h k hd' ht; exact keepN h (hi.doneOk p' h k hd' ht)
    · intro p' h k hd' ht hL; exact hi.own p' h k hd' ht (keep h hL)
    · intro p' h k j hd' ht hj hL; exact hi.lower p' h k j hd' ht hj (keep h hL)
  | start p h s hd hpc hdh hl =>
    apply inv_pc s hi p _ hd
    · intro h' e; cases e; exact hdh
    all_goals (intros; simp_all [Pc.held, Pc.low])
  | scanNew p h k s hd hpc hsl =>
    refine ⟨hi.holders, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp only [upd]
    · intro p' h' hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht
        exact hi.tokDead p h hd (by rw [hpc]; rfl)
      · rw [if_neg e] at ht; exact hi.tokDead p' h' hd' ht
    · intro p' h' k' hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht
      · rw [if_neg e] at ht; exact hi.seen p' h' k' hd' ht
    · intro p' h' k' x hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht
      · rw [if_neg e] at ht; exact hi.claims p' h' k' x hd' ht
    · intro p' h' k' hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht
      · rw [if_neg e] at ht; exact hi.doneOk p' h' k' hd' ht
    · intro p' h' k' hd' ht hL; simp only [upd2]; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht; rw [if_pos ⟨rfl, rfl⟩, e]
      · rw [if_neg e] at ht
        have o := hi.own p' h' k' hd' ht hL
        by_cases hk : h' = h ∧ k' = k
        · obtain ⟨rfl, rfl⟩ := hk; rw [hsl] at o; cases o
        · rw [if_neg hk]; exact o
    · intro p' h' k' j hd' ht hj hL; simp only [upd2]; by_cases e : p' = p
      · rw [if_pos e] at ht hj; cases ht; simp [Pc.low] at hj
      · rw [if_neg e] at ht hj
        obtain ⟨q, hq, hdq⟩ := hi.lower p' h' k' j hd' ht hj hL
        by_cases hk : h' = h ∧ j = k
        · obtain ⟨rfl, rfl⟩ := hk; rw [hsl] at hq; cases hq
        · rw [if_neg hk]; exact ⟨q, hq, hdq⟩
  | scanSkip p h k q s hd hpc _ _ =>
    apply inv_pc s hi p _ hd
    · intro h' e; cases e; exact hi.tokDead p h hd (by rw [hpc]; rfl)
    all_goals (intros; simp_all [Pc.held, Pc.low])
  | scanStop p h k s hd hpc =>
    apply inv_pc s hi p _ hd <;> (intros; simp_all [Pc.held, Pc.low, Pc.tok])
  | verOk p h k i q s hd hpc hik hq hdq =>
    apply inv_pc s hi p _ hd
    · intro h' e; cases e; exact hi.tokDead p h hd (by rw [hpc]; rfl)
    · intro h' k' e; cases e
    · intro h' k' x e; cases e
    · intro h' k' e; cases e
    · intro h' k' e hL; cases e; exact hi.own p h k hd (by rw [hpc]; rfl) hL
    · intro h' k' j e hj hL; cases e
      simp only [Pc.low] at hj
      by_cases hji : j = i
      · subst hji; exact ⟨q, hq, hdq⟩
      · exact hi.lower p h k j hd (by rw [hpc]; rfl) (by rw [hpc]; simp [Pc.low]; omega) hL
  | verDone p h k s hd hpc =>
    apply inv_pc s hi p _ hd
    · intro h' e; cases e; exact hi.tokDead p h hd (by rw [hpc]; rfl)
    · intro h' k' e; cases e
    · intro h' k' x e; cases e
    · intro h' k' e; cases e
    · intro h' k' e hL; cases e; exact hi.own p h k hd (by rw [hpc]; rfl) hL
    · intro h' k' j e hj hL; cases e
      exact hi.lower p h k j hd (by rw [hpc]; rfl) (by rw [hpc]; simpa [Pc.low] using hj) hL
  | verFail p h k i s hd hpc =>
    exact inv_relSlot s hi p h k hd (by rw [hpc]; rfl)
  | read p h k s hd hpc =>
    by_cases hL : s.lock = some h
    · rw [if_pos hL]
      apply inv_pc s hi p _ hd
      · intro h' e; cases e; exact hi.tokDead p h hd (by rw [hpc]; rfl)
      · intro h' k' e; cases e; exact hL
      · intro h' k' x e; cases e
      · intro h' k' e; cases e
      · intro h' k' e hL'; cases e; exact hi.own p h k hd (by rw [hpc]; rfl) hL'
      · intro h' k' j e hj hL'; cases e
        exact hi.lower p h k j hd (by rw [hpc]; rfl) (by rw [hpc]; simpa [Pc.low] using hj) hL'
    · rw [if_neg hL]
      apply inv_pc s hi p _ hd
      · intro h' e; cases e; exact hi.tokDead p h hd (by rw [hpc]; rfl)
      · intro h' k' e; cases e
      · intro h' k' x e; cases e
      · intro h' k' e; cases e
      · intro h' k' e hL'; cases e; exact absurd hL' hL
      · intro h' k' j e hj hL'; cases e; exact absurd hL' hL
  | rename p h k x s hd hpc hl =>
    have hLh := hi.seen p h k hd hpc
    rw [hl] at hLh; injection hLh with hxh
    subst hxh
    have hdh := hi.tokDead p x hd (by rw [hpc]; rfl)
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp only [upd]
    · intro q hq hdq; have := hi.holders q hq hdq; rw [hl] at this; cases this
      rw [hdh] at hdq; cases hdq
    · intro p' h' hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht; exact hdh
      · rw [if_neg e] at ht; exact hi.tokDead p' h' hd' ht
    · intro p' h' k' hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht
      · rw [if_neg e] at ht
        have hs' := hi.seen p' h' k' hd' ht; rw [hl] at hs'; cases hs'
        have := excl s hi p p' x k k' hd hd' (by rw [hpc]; rfl) (by rw [hpc]; rfl)
          (by rw [ht]; rfl) (by rw [ht]; rfl) hl
        exact absurd this.symm e
    · intro p' h' k' x' hd' ht; by_cases e : p' = p
      · rw [if_pos e] at ht; cases ht; exact ⟨rfl, by simp⟩
      · rw [if_neg e] at ht; exact ⟨(hi.claims p' h' k' x' hd' ht).1, by simp⟩
    · intro p' h' k' _ _; simp
    · intro p' h' k' _ _ hL; cases hL
    · intro p' h' k' j _ _ _ hL; cases hL
  | renameFail p h k s hd hpc hl =>
    apply inv_pc s hi p _ hd
    · intro h' e; cases e; exact hi.tokDead p h hd (by rw [hpc]; rfl)
    all_goals (intros; simp_all [Pc.held, Pc.low])
  | finish p h k x s hd hpc =>
    have ⟨hxh, hLn⟩ := hi.claims p h k x hd hpc
    subst hxh
    have hf : finishLock s.lock x x = s.lock := by simp [finishLock]
    have hdec : decide (x = x) = true := by simp
    rw [hf, hdec]
    apply inv_pc s hi p _ hd
    · intro h' e; cases e; exact hi.tokDead p x hd (by rw [hpc]; rfl)
    · intro h' k' e; cases e
    · intro h' k' x' e; cases e
    · intro h' k' e; cases e; exact hLn
    · intro h' k' e hL; cases e; exact absurd hL hLn
    · intro h' k' j e _ hL; cases e; exact absurd hL hLn
  | clean p h k j s hd hpc =>
    have hLn := hi.doneOk p h k hd hpc
    refine ⟨hi.holders, hi.tokDead, hi.seen, hi.claims, hi.doneOk, ?_, ?_⟩
    · intro p' h' k' hd' ht hL; simp only [upd2]
      by_cases hk : h' = h ∧ k' = j
      · obtain ⟨rfl, rfl⟩ := hk; exact absurd hL hLn
      · rw [if_neg hk]; exact hi.own p' h' k' hd' ht hL
    · intro p' h' k' j' hd' ht hj hL; simp only [upd2]
      by_cases hk : h' = h ∧ j' = j
      · obtain ⟨rfl, rfl⟩ := hk; exact absurd hL hLn
      · rw [if_neg hk]; exact hi.lower p' h' k' j' hd' ht hj hL
  | release p h k b s hd hpc =>
    exact inv_relSlot s hi p h k hd (by rw [hpc]; rfl)
  | die p s hd =>
    have kd : ∀ q, s.dead q = true → upd s.dead p true q = true := by
      intro q hq; simp only [upd]; by_cases e : q = p
      · rw [if_pos e]
      · rw [if_neg e]; exact hq
    have kl : ∀ q, upd s.dead p true q = false → s.dead q = false := by
      intro q hq; simp only [upd] at hq; by_cases e : q = p
      · rw [if_pos e] at hq; cases hq
      · rw [if_neg e] at hq; exact hq
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · intro q hq hdq; exact hi.holders q hq (kl q hdq)
    · intro p' h ht' ht; exact kd h (hi.tokDead p' h (kl p' ht') ht)
    · intro p' h k ht' ht; exact hi.seen p' h k (kl p' ht') ht
    · intro p' h k x ht' ht; exact hi.claims p' h k x (kl p' ht') ht
    · intro p' h k ht' ht; exact hi.doneOk p' h k (kl p' ht') ht
    · intro p' h k ht' ht hL; exact hi.own p' h k (kl p' ht') ht hL
    · intro p' h k j ht' ht hj hL
      obtain ⟨q, hq, hdq⟩ := hi.lower p' h k j (kl p' ht') ht hj hL
      exact ⟨q, hq, kd q hdq⟩

inductive Reach (s0 : S) : S → Prop
  | refl : Reach s0 s0
  | step (s s' : S) : Reach s0 s → Step s s' → Reach s0 s'

theorem reach_inv (s0 s : S) (h0 : Inv s0) (hr : Reach s0 s) : Inv s := by
  induction hr with
  | refl => exact h0
  | step s s' _ hs ih => exact inv_step s s' ih hs

/-- **Mutual exclusion, crashes included (fixed protocol).** From any state
satisfying the invariant — in particular a dead holder's lock, nobody inside, and any
number of abandoned guard slots — at most one LIVE process is ever in the critical
section, however many stealers crash wherever they crash. -/
theorem ladder_mutex (s0 s : S) (h0 : Inv s0) (hr : Reach s0 s) (p q : Nat)
    (hp : s.hold p = true) (hdp : s.dead p = false)
    (hq : s.hold q = true) (hdq : s.dead q = false) : p = q := by
  have hi := reach_inv s0 s h0 hr
  have := hi.holders p hp hdp
  rw [hi.holders q hq hdq] at this
  cases this; rfl

/-- The steal guard itself: while the judged lock is in place, at most one live
process is past verification (the property round 1's proof used a single guard for). -/
theorem ladder_guard_excl (s0 s : S) (h0 : Inv s0) (hr : Reach s0 s) (p p' h k k' : Nat)
    (hp : s.dead p = false) (hp' : s.dead p' = false)
    (hc : s.pc p = .crit h k ∨ s.pc p = .seen h k)
    (hc' : s.pc p' = .crit h k' ∨ s.pc p' = .seen h k') (hL : s.lock = some h) : p = p' := by
  have hi := reach_inv s0 s h0 hr
  apply excl s hi p p' h k k' hp hp'
  · rcases hc with e | e <;> rw [e] <;> rfl
  · rcases hc with e | e <;> rw [e] <;> rfl
  · rcases hc' with e | e <;> rw [e] <;> rfl
  · rcases hc' with e | e <;> rw [e] <;> rfl
  · exact hL

/-- H=9 holds the lock and is dead; stealer 5 crashed holding slot 0 of H's ladder. -/
def init1 : S :=
  ⟨some 9, fun _ => false, fun p => p == 9 || p == 5,
   fun h k => if h = 9 ∧ k = 0 then some 5 else none, fun _ => .idle⟩

theorem init1_inv : Inv init1 := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intros <;> simp_all [init1, Pc.tok, Pc.held]

/-- Non-vacuity: the abandoned slot does not block recovery — process 1 walks past it,
verifies it abandoned, steals H's lock and gets into the critical section. -/
theorem ladder_recovers : ∃ s, Reach init1 s ∧ s.hold 1 = true ∧ s.dead 1 = false := by
  let s1 : S := { init1 with pc := upd init1.pc 1 (.scan 9 0) }
  let s2 : S := { s1 with pc := upd s1.pc 1 (.scan 9 1) }
  let s3 : S := { s2 with slot := upd2 s2.slot 9 1 (some 1), pc := upd s2.pc 1 (.verify 9 1 0) }
  let s4 : S := { s3 with pc := upd s3.pc 1 (.verify 9 1 1) }
  let s5 : S := { s4 with pc := upd s4.pc 1 (.crit 9 1) }
  let s6 : S := { s5 with pc := upd s5.pc 1 (if s5.lock = some 9 then .seen 9 1 else .done 9 1 false) }
  let s7 : S := { s6 with lock := none, pc := upd s6.pc 1 (.claimed 9 1 9) }
  let s8 : S := { s7 with lock := finishLock s7.lock 9 9, pc := upd s7.pc 1 (.done 9 1 (decide (9 = 9))) }
  let s9 : S := { s8 with slot := upd2 s8.slot 9 0 none }
  let s10 : S := { s9 with slot := upd2 s9.slot 9 1 (relSlot s9.slot 9 1 1), pc := upd s9.pc 1 .idle }
  let s11 : S := { s10 with lock := some 1, hold := upd s10.hold 1 true }
  refine ⟨s11, ?_, rfl, rfl⟩
  have r1 : Reach init1 s1 := .step _ _ .refl (.start 1 9 init1 rfl rfl rfl rfl)
  have r2 : Reach init1 s2 := .step _ _ r1 (.scanSkip 1 9 0 5 s1 rfl rfl rfl rfl)
  have r3 : Reach init1 s3 := .step _ _ r2 (.scanNew 1 9 1 s2 rfl rfl rfl)
  have r4 : Reach init1 s4 := .step _ _ r3 (.verOk 1 9 1 0 5 s3 rfl rfl (by decide) rfl rfl)
  have r5 : Reach init1 s5 := .step _ _ r4 (.verDone 1 9 1 s4 rfl rfl)
  have r6 : Reach init1 s6 := .step _ _ r5 (.read 1 9 1 s5 rfl rfl)
  have r7 : Reach init1 s7 := .step _ _ r6 (.rename 1 9 1 9 s6 rfl rfl rfl)
  have r8 : Reach init1 s8 := .step _ _ r7 (.finish 1 9 1 9 s7 rfl rfl)
  have r9 : Reach init1 s9 := .step _ _ r8 (.clean 1 9 1 0 s8 rfl rfl)
  have r10 : Reach init1 s10 := .step _ _ r9 (.release 1 9 1 true s9 rfl rfl)
  exact .step _ _ r10 (.acq 1 s10 rfl rfl rfl)

end Guard

/-! ## 2. One store-shape rule, one duplicate-id rule (core-persistence#11)

engrams.ts `engramStoreEntries` / `parseEngramEntry` / `duplicateEngramIds`; sync.ts
`readEngramList`; backup.ts `validateStore`; storage-postgres.ts `save`/`updateMany`. -/
namespace Shape

/-- What a store file parses to, as far as the shape rule cares. `bare`: a top-level
list; `map (some l)`: a mapping whose `engrams:` is a list; `mapNull`: `engrams:` with
no value; `mapNoKey`, `other`: anything else. -/
inductive Doc (α : Type) where
  | bare (l : List α) | map (l : Option (List α)) | mapNoKey | other

/-- The loader's rule (`parseEngramFile`, via `engramStoreEntries`). -/
def loader {α : Type} : Doc α → Option (List α)
  | .map (some l) => some l
  | _ => none

/-- sync `readEngramList` before the fix: also a bare list. -/
def syncOld {α : Type} : Doc α → Option (List α)
  | .bare l => some l
  | .map (some l) => some l
  | _ => none

/-- sync after the fix: the loader's function itself. -/
def syncNew {α : Type} (d : Doc α) : Option (List α) := loader d

/-- backup `validateStore` shape check: "a mapping with an `engrams` list". -/
def backupShape {α : Type} : Doc α → Option (List α)
  | .map (some l) => some l
  | _ => none

/-- **Counterexample (replayed on HEAD: the loader refuses, sync commits the blob).** -/
theorem old_sync_accepts_unloadable {α : Type} (l : List α) :
    syncOld (.bare l) = some l ∧ loader (.bare l) = none := ⟨rfl, rfl⟩

/-- Fixed: every reader applies one shape rule. -/
theorem readers_agree {α : Type} (d : Doc α) : syncNew d = loader d ∧ backupShape d = loader d := by
  cases d with
  | bare => exact ⟨rfl, rfl⟩
  | map o => cases o <;> exact ⟨rfl, rfl⟩
  | mapNoKey => exact ⟨rfl, rfl⟩
  | other => exact ⟨rfl, rfl⟩

/-- Non-vacuity: the canonical shape is accepted by all of them. -/
theorem canonical_accepted {α : Type} (l : List α) :
    syncNew (.map (some l)) = some l ∧ backupShape (.map (some l)) = some l := ⟨rfl, rfl⟩

/-! ### Postgres `save`: a batch of (id, value) rows, written in chunks. -/

/-- "No id twice" — `duplicateEngramIds l = []`. -/
def nodupB : List (Nat × Nat) → Bool
  | [] => true
  | x :: xs => !(xs.any (fun y => y.1 == x.1)) && nodupB xs

def upsertAll (s : Nat → Option Nat) : List (Nat × Nat) → Nat → Option Nat
  | [] => s
  | (i, v) :: xs => upsertAll (fun j => if j = i then some v else s j) xs

/-- One multi-row `INSERT … ON CONFLICT DO UPDATE`: Postgres errors when the statement
touches one id twice. -/
def chunkStmt (s : Nat → Option Nat) (c : List (Nat × Nat)) : Option (Nat → Option Nat) :=
  if nodupB c then some (upsertAll s c) else none

/-- Before the fix: chunks run in order in one transaction (`none` = rolled back). -/
def saveOld (s : Nat → Option Nat) : List (List (Nat × Nat)) → Option (Nat → Option Nat)
  | [] => some s
  | c :: cs => match chunkStmt s c with
    | some s' => saveOld s' cs
    | none => none

/-- The fix: `refuseDuplicateIds` first, over the whole batch. -/
def saveNew (s : Nat → Option Nat) (cs : List (List (Nat × Nat))) : Option (Nat → Option Nat) :=
  if nodupB cs.flatten then saveOld s cs else none

/-- **Counterexample (replayed on the test database).** The same batch — id 1 twice —
errors when both copies share a chunk, and silently keeps the later copy when the
chunk boundary separates them. -/
theorem old_chunk_dependent :
    saveOld (fun _ => none) [[(1, 10), (1, 20)]] = none ∧
    (saveOld (fun _ => none) [[(1, 10)], [(1, 20)]]).map (fun s => s 1) = some (some 20) := by
  decide

theorem nodupB_append (a b : List (Nat × Nat)) (h : nodupB (a ++ b) = true) :
    nodupB a = true ∧ nodupB b = true := by
  induction a with
  | nil => exact ⟨rfl, h⟩
  | cons x xs ih =>
    simp only [List.cons_append, nodupB, Bool.and_eq_true, Bool.not_eq_true'] at h ⊢
    have ⟨h1, h2⟩ := h
    refine ⟨⟨?_, (ih h2).1⟩, (ih h2).2⟩
    rw [List.any_append] at h1
    simp only [Bool.or_eq_false_iff] at h1
    exact h1.1

theorem upsertAll_append (s : Nat → Option Nat) (a b : List (Nat × Nat)) :
    upsertAll s (a ++ b) = upsertAll (upsertAll s a) b := by
  induction a generalizing s with
  | nil => rfl
  | cons x xs ih => obtain ⟨i, v⟩ := x; exact ih _

/-- Fixed: the outcome does not depend on how the batch is chunked — refused iff an id
repeats, otherwise every row is upserted in order. -/
theorem fixed_chunk_independent (s : Nat → Option Nat) (cs : List (List (Nat × Nat))) :
    saveNew s cs = if nodupB cs.flatten then some (upsertAll s cs.flatten) else none := by
  unfold saveNew
  by_cases h : nodupB cs.flatten = true
  · rw [if_pos h, if_pos h]
    induction cs generalizing s with
    | nil => rfl
    | cons c cs ih =>
      rw [List.flatten_cons] at h ⊢
      have ⟨hc, hr⟩ := nodupB_append c cs.flatten h
      simp only [saveOld, chunkStmt, hc, if_true]
      rw [upsertAll_append]
      exact ih _ hr
  · rw [if_neg h, if_neg h]

/-- Fixed, no silent loss: when the save goes through, every row is stored as given. -/
theorem fixed_no_loss (s : Nat → Option Nat) (l : List (Nat × Nat)) (h : nodupB l = true)
    (i v : Nat) (hm : (i, v) ∈ l) : upsertAll s l i = some v := by
  induction l generalizing s with
  | nil => cases hm
  | cons x xs ih =>
    obtain ⟨j, w⟩ := x
    simp only [nodupB, Bool.and_eq_true, Bool.not_eq_true'] at h
    rcases List.mem_cons.mp hm with e | e
    · cases e
      -- i is not re-set later: no later row carries id i
      have key : ∀ (t : Nat → Option Nat) (ys : List (Nat × Nat)),
          ys.any (fun y => y.1 == i) = false → upsertAll t ys i = t i := by
        intro t ys hy
        induction ys generalizing t with
        | nil => rfl
        | cons y ys ihy =>
          obtain ⟨k, u⟩ := y
          simp only [List.any_cons, Bool.or_eq_false_iff] at hy
          simp only [upsertAll]
          rw [ihy _ hy.2]
          have : k ≠ i := by intro e; subst e; simp at hy
          simp [Ne.symm this]
      simp only [upsertAll]
      rw [key _ xs h.1]; simp
    · exact ih _ h.2 e

end Shape

/-! ## 3. Sync restore after a pull (sync.ts `restoreWithheld`): a withheld id that
also arrives from the remote. Records are (id, text); the store is a list. -/
namespace Restore

/-- `restoreWithheld`, pull changed engrams.yaml: the pulled file plus every held record. -/
def restore (pulled held : List (Nat × Nat)) : List (Nat × Nat) := pulled ++ held

/-- What a YAML-path lookup by id returns (`Array.find`). -/
def lookup (l : List (Nat × Nat)) (i : Nat) : Option Nat := (l.find? (fun r => r.1 == i)).map (·.2)

/-- **OLD behaviour, before P1b — counterexample (replayed: `<scratch>/r3/replay3.mts`).**
`restore` is the pre-P1b `restoreWithheld`. Machine A holds local
engram 2 (text 7); machine B mints id 2 the same day for a different engram (text 8)
and pushes it. After A's sync the store holds id 2 twice and a lookup of id 2 returns
B's record: A's local engram is no longer reachable by id. -/
theorem old_restore_shadows_local :
    restore [(1, 5), (2, 8)] [(2, 7)] = [(1, 5), (2, 8), (2, 7)] ∧
    lookup (restore [(1, 5), (2, 8)] [(2, 7)]) 2 = some 8 := by decide

/-- Non-vacuity: without a collision the held record stays reachable. -/
theorem restore_no_collision_reachable :
    lookup (restore [(1, 5), (3, 8)] [(2, 7)]) 2 = some 7 := by decide

/-! ### Owner decision P1b (2026-09-27): re-id the held LOCAL record.
`sync.ts` `rekeyHeldAgainstPulled`: the pulled record keeps the id; the held record,
never pushed, gets a fresh id (`fr`, the loader's `freshDuplicateId`), recorded in
history; an exact copy of a pulled record is not appended twice. -/

def ids (l : List (Nat × Nat)) : List Nat := l.map (·.1)

/-- P1b: a held record whose id the pull brought gets `fr r` (fresh); an exact copy of a pulled record is not appended twice. -/
def restoreNew (fr : Nat × Nat → Nat) (pulled held : List (Nat × Nat)) : List (Nat × Nat) :=
  pulled ++ held.filterMap (fun r =>
    if r ∈ pulled then none else if r.1 ∈ ids pulled then some (fr r, r.2) else some r)

theorem find_none (l : List (Nat × Nat)) (i : Nat) (h : i ∉ ids l) :
    l.find? (fun r => r.1 == i) = none := by
  rw [List.find?_eq_none]
  intro x hx hb
  exact h (by simp at hb; exact hb ▸ List.mem_map_of_mem hx)

theorem find_some (l : List (Nat × Nat)) (i : Nat) (h : i ∈ ids l) :
    (l.find? (fun r => r.1 == i)).isSome = true := by
  obtain ⟨x, hx, rfl⟩ := List.mem_map.mp h
  rw [List.find?_isSome]
  exact ⟨x, hx, by simp⟩

theorem restore_example :
    restoreNew (fun r => 100 + r.1) [(1, 5), (2, 8)] [(2, 7)] = [(1, 5), (2, 8), (102, 7)] ∧
    lookup (restoreNew (fun r => 100 + r.1) [(1, 5), (2, 8)] [(2, 7)]) 2 = some 8 ∧
    lookup (restoreNew (fun r => 100 + r.1) [(1, 5), (2, 8)] [(2, 7)]) 102 = some 7 ∧
    restoreNew (fun r => 100 + r.1) [(2, 7)] [(2, 7)] = [(2, 7)] := by decide

/-- **P1b fixed**: after a pull, every pulled id still answers with the pulled record,
and the held local record is readable by its own (possibly new) id. -/
theorem restore_both_reachable (fr : Nat × Nat → Nat) (pulled : List (Nat × Nat)) (h : Nat × Nat)
    (hfr : fr h ∉ ids pulled) (hne : h ∉ pulled) :
    lookup (restoreNew fr pulled [h]) (if h.1 ∈ ids pulled then fr h else h.1) = some h.2 ∧
    ∀ i ∈ ids pulled, lookup (restoreNew fr pulled [h]) i = lookup pulled i := by
  constructor
  · by_cases hin : h.1 ∈ ids pulled
    · simp only [restoreNew, lookup, if_pos hin, List.find?_append, find_none pulled _ hfr,
        List.filterMap_cons, List.filterMap_nil, if_neg hne]
      simp
    · simp only [restoreNew, lookup, if_neg hin, List.find?_append, find_none pulled _ hin,
        List.filterMap_cons, List.filterMap_nil, if_neg hne]
      simp
  · intro i hi
    unfold lookup restoreNew
    rw [List.find?_append]
    have := find_some pulled i hi
    cases hf : pulled.find? (fun r => r.1 == i) with
    | none => rw [hf] at this; cases this
    | some x => simp


/-! ### Follow-up 1 (owner principle "nothing lost or hidden"): references in sibling
records written on THIS machine before the pull (committed ones too, on a personal remote)
follow the renamed held record (`sync.ts` `rewriteLocalSiblingRefs`); references the pull
brought are left alone. A reference is modelled as the id it names. -/

/-- How a local reference is rewritten: the held record's old id becomes its new id. -/
def rewriteRef (fr : Nat × Nat → Nat) (pulled : List (Nat × Nat)) (h : Nat × Nat) (i : Nat) : Nat :=
  if i = h.1 ∧ h.1 ∈ ids pulled then fr h else i

/-- **OLD behaviour (P1b without follow-up 1) — counterexample.** A local episode naming
the local engram (id 2, text 7) resolves after the pull to the OTHER machine's engram. -/
theorem old_local_ref_hijacked :
    lookup (restoreNew (fun r => 100 + r.1) [(2, 8)] [(2, 7)]) 2 = some 8 := by decide

/-- **Fixed:** a local reference to the held record still resolves to it after the pull. -/
theorem local_ref_follows (fr : Nat × Nat → Nat) (pulled : List (Nat × Nat)) (h : Nat × Nat)
    (hfr : fr h ∉ ids pulled) (hne : h ∉ pulled) :
    lookup (restoreNew fr pulled [h]) (rewriteRef fr pulled h h.1) = some h.2 := by
  have := (restore_both_reachable fr pulled h hfr hne).1
  unfold rewriteRef
  by_cases hin : h.1 ∈ ids pulled
  · rw [if_pos ⟨rfl, hin⟩]; rw [if_pos hin] at this; exact this
  · rw [if_neg (fun hc => hin hc.2)]; rw [if_neg hin] at this; exact this

/-- References to any other id are not touched. -/
theorem other_refs_unchanged (fr : Nat × Nat → Nat) (pulled : List (Nat × Nat)) (h : Nat × Nat)
    (i : Nat) (hi : i ≠ h.1) : rewriteRef fr pulled h i = i := by
  unfold rewriteRef; rw [if_neg (fun hc => hi hc.1)]

end Restore

/-! ## 3b. Duplicate ids — owner decision P1 (2026-09-27, "keep both, rename one").
engrams.ts `resolveDuplicateIds`, the one rule the loader (`parseEngramFile`), the PGLite
index (`upsertEngramsTx`) and Postgres `save` apply. Records are (id, content). The first
copy keeps the id; a later copy with different content gets a fresh id (modelled as
`freshNat`: any id outside every id seen, which the TS `freshDuplicateId` loop guarantees);
an exact duplicate is read once. -/
namespace DupIds

/-- Fresh id outside `taken` (the TS loop appends `-2`, `-3`, … until unused). -/
def freshNat (taken : List Nat) : Nat := taken.foldr max 0 + 1

theorem le_foldr_max (taken : List Nat) (x : Nat) (h : x ∈ taken) : x ≤ taken.foldr max 0 := by
  induction taken with
  | nil => cases h
  | cons a t ih =>
    simp only [List.foldr]
    cases h with
    | head => exact Nat.le_max_left _ _
    | tail _ h' => exact Nat.le_trans (ih h') (Nat.le_max_right _ _)

theorem freshNat_not_mem (taken : List Nat) : freshNat taken ∉ taken := by
  intro h
  have := le_foldr_max taken _ h
  unfold freshNat at this
  omega

/-- kept entries: (original id, id it is read under, content). -/
def resolveAux : List Nat → List (Nat × Nat × Nat) → List (Nat × Nat) → List (Nat × Nat × Nat)
  | _, kept, [] => kept
  | taken, kept, r :: rs =>
    if kept.any (fun k => k.1 == r.1 && k.2.2 == r.2) then resolveAux taken kept rs
    else if kept.any (fun k => k.1 == r.1) then
      resolveAux (freshNat taken :: taken) (kept ++ [(r.1, freshNat taken, r.2)]) rs
    else resolveAux taken (kept ++ [(r.1, r.1, r.2)]) rs

/-- `resolveDuplicateIds`: records are (id, content). -/
def resolve (l : List (Nat × Nat)) : List (Nat × Nat) :=
  (resolveAux (l.map (·.1)) [] l).map (fun k => (k.2.1, k.2.2))

/-- **OLD behaviour, before P1 — counterexample.** The loader returned both copies; an id
lookup (`Array.find`) sees the first, and the later engram (content 8) answers to NO id. -/
theorem old_loader_shadows :
    Restore.lookup [(2, 7), (1, 5), (2, 8)] 2 = some 7 ∧
    ∀ i, Restore.lookup [(2, 7), (1, 5), (2, 8)] i ≠ some 8 := by
  refine ⟨by decide, ?_⟩
  intro i
  unfold Restore.lookup
  by_cases h1 : i = 2
  · subst h1; decide
  · by_cases h2 : i = 1
    · subst h2; decide
    · have a : (2 == i) = false := beq_false_of_ne (Ne.symm h1)
      have b : (1 == i) = false := beq_false_of_ne (Ne.symm h2)
      simp [List.find?, a, b]

/-- Example: a clash renamed, an exact duplicate read once. -/
theorem resolve_example : resolve [(2, 7), (1, 5), (2, 8), (2, 8)] = [(2, 7), (1, 5), (3, 8)] := by decide

/-- Invariant of `resolveAux`. -/
structure RInv (ids taken : List Nat) (kept : List (Nat × Nat × Nat)) : Prop where
  sub : ∀ x ∈ ids, x ∈ taken
  newIn : ∀ k ∈ kept, k.2.1 ∈ taken
  shape : ∀ k ∈ kept, k.2.1 = k.1 ∨ k.2.1 ∉ ids
  nodup : (kept.map (fun k => k.2.1)).Nodup

theorem rinv_step (ids taken : List Nat) (kept : List (Nat × Nat × Nat)) (r : Nat × Nat)
    (hr : r.1 ∈ ids) (hi : RInv ids taken kept) :
    (kept.any (fun k => k.1 == r.1) = true →
      RInv ids (freshNat taken :: taken) (kept ++ [(r.1, freshNat taken, r.2)])) ∧
    (kept.any (fun k => k.1 == r.1) = false →
      RInv ids taken (kept ++ [(r.1, r.1, r.2)])) := by
  have hf := freshNat_not_mem taken
  constructor
  · intro _
    refine ⟨fun x hx => List.mem_cons_of_mem _ (hi.sub x hx), ?_, ?_, ?_⟩
    · intro k hk
      rcases List.mem_append.mp hk with hk | hk
      · exact List.mem_cons_of_mem _ (hi.newIn k hk)
      · simp at hk; subst hk; exact List.mem_cons_self
    · intro k hk
      rcases List.mem_append.mp hk with hk | hk
      · exact hi.shape k hk
      · simp at hk; subst hk; right; intro hm; exact hf (hi.sub _ hm)
    · rw [List.map_append, List.nodup_append]
      refine ⟨hi.nodup, by simp, ?_⟩
      intro a ha b hb heq
      simp at hb
      obtain ⟨k, hk, hk2⟩ := List.mem_map.mp ha
      have := hi.newIn k hk
      rw [hk2, heq, hb] at this
      exact hf this
  · intro hn
    refine ⟨hi.sub, ?_, ?_, ?_⟩
    · intro k hk
      rcases List.mem_append.mp hk with hk | hk
      · exact hi.newIn k hk
      · simp at hk; subst hk; exact hi.sub _ hr
    · intro k hk
      rcases List.mem_append.mp hk with hk | hk
      · exact hi.shape k hk
      · simp at hk; subst hk; left; rfl
    · rw [List.map_append, List.nodup_append]
      refine ⟨hi.nodup, by simp, ?_⟩
      intro a ha b hb heq
      simp at hb
      obtain ⟨k, hk, hka⟩ := List.mem_map.mp ha
      have hkr : k.2.1 = r.1 := by rw [hka, heq, hb]
      rcases hi.shape k hk with hs | hs
      · have : k.1 = r.1 := by rw [← hs]; exact hkr
        have : kept.any (fun k => k.1 == r.1) = true := List.any_eq_true.mpr ⟨k, hk, by simp [this]⟩
        rw [this] at hn; cases hn
      · rw [hkr] at hs; exact hs hr

theorem resolveAux_inv (ids : List Nat) (rs : List (Nat × Nat)) (hrs : ∀ r ∈ rs, r.1 ∈ ids) :
    ∀ taken kept, RInv ids taken kept →
      ∃ taken', RInv ids taken' (resolveAux taken kept rs) := by
  induction rs with
  | nil => intro taken kept hi; exact ⟨taken, hi⟩
  | cons r rs ih =>
    intro taken kept hi
    have hr : r.1 ∈ ids := hrs r List.mem_cons_self
    have hrs' : ∀ r ∈ rs, r.1 ∈ ids := fun x hx => hrs x (List.mem_cons_of_mem _ hx)
    have ⟨h1, h2⟩ := rinv_step ids taken kept r hr hi
    simp only [resolveAux]
    split
    · exact ih hrs' taken kept hi
    · split
      · rename_i _ h; exact ih hrs' _ _ (h1 h)
      · rename_i _ h; exact ih hrs' _ _ (h2 (by revert h; cases kept.any (fun k => k.1 == r.1) <;> simp))

/-- **P1, distinct ids**: after the rule, no two records share an id. -/
theorem resolve_ids_distinct (l : List (Nat × Nat)) : ((resolve l).map (·.1)).Nodup := by
  have hi : RInv (l.map (·.1)) (l.map (·.1)) [] :=
    ⟨fun _ h => h, by simp, by simp, by simp⟩
  obtain ⟨_, h⟩ := resolveAux_inv (l.map (·.1)) l (fun r hr => List.mem_map_of_mem hr) _ [] hi
  unfold resolve
  rw [List.map_map]
  exact h.nodup

/-- Every processed record's content is kept, under some id. -/
theorem resolveAux_keeps (rs : List (Nat × Nat)) :
    ∀ taken kept, (∀ k ∈ kept, k ∈ resolveAux taken kept rs) ∧
      (∀ r ∈ rs, ∃ k ∈ resolveAux taken kept rs, k.1 = r.1 ∧ k.2.2 = r.2) := by
  induction rs with
  | nil => intro taken kept; exact ⟨fun k hk => hk, fun r hr => by cases hr⟩
  | cons r rs ih =>
    intro taken kept
    simp only [resolveAux]
    split
    · rename_i hex
      obtain ⟨hA, hB⟩ := ih taken kept
      refine ⟨hA, ?_⟩
      intro x hx
      rcases List.mem_cons.mp hx with rfl | hx
      · obtain ⟨k, hk, hk2⟩ := List.any_eq_true.mp hex
        simp at hk2
        exact ⟨k, hA k hk, hk2.1, hk2.2⟩
      · exact hB x hx
    · split
      · obtain ⟨hA, hB⟩ := ih (freshNat taken :: taken) (kept ++ [(r.1, freshNat taken, r.2)])
        refine ⟨fun k hk => hA k (List.mem_append_left _ hk), ?_⟩
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hx
        · exact ⟨_, hA _ (List.mem_append_right _ List.mem_cons_self), rfl, rfl⟩
        · exact hB x hx
      · obtain ⟨hA, hB⟩ := ih taken (kept ++ [(r.1, r.1, r.2)])
        refine ⟨fun k hk => hA k (List.mem_append_left _ hk), ?_⟩
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hx
        · exact ⟨_, hA _ (List.mem_append_right _ List.mem_cons_self), rfl, rfl⟩
        · exact hB x hx

/-- **P1, nothing lost**: every record's content is readable, by some id. -/
theorem resolve_no_loss (l : List (Nat × Nat)) (r : Nat × Nat) (hr : r ∈ l) :
    ∃ j, (j, r.2) ∈ resolve l := by
  obtain ⟨k, hk, _, hk2⟩ := (resolveAux_keeps l (l.map (·.1)) []).2 r hr
  exact ⟨k.2.1, by unfold resolve; exact List.mem_map.mpr ⟨k, hk, by simp [hk2]⟩⟩

theorem resolveAux_prefix (rs : List (Nat × Nat)) :
    ∀ taken kept, ∃ t, resolveAux taken kept rs = kept ++ t := by
  induction rs with
  | nil => intro taken kept; exact ⟨[], by simp [resolveAux]⟩
  | cons r rs ih =>
    intro taken kept
    simp only [resolveAux]
    split
    · exact ih taken kept
    · split
      · obtain ⟨t, ht⟩ := ih (freshNat taken :: taken) (kept ++ [(r.1, freshNat taken, r.2)])
        exact ⟨(r.1, freshNat taken, r.2) :: t, by rw [ht]; simp⟩
      · obtain ⟨t, ht⟩ := ih taken (kept ++ [(r.1, r.1, r.2)])
        exact ⟨(r.1, r.1, r.2) :: t, by rw [ht]; simp⟩

/-- **P1, first copy keeps its id.** -/
theorem resolve_first_keeps (r : Nat × Nat) (rs : List (Nat × Nat)) :
    (resolve (r :: rs)).head? = some r := by
  unfold resolve
  simp only [resolveAux, List.any_nil, Bool.false_eq_true, if_false, List.nil_append]
  obtain ⟨t, ht⟩ := resolveAux_prefix rs ((r :: rs).map (·.1)) [(r.1, r.1, r.2)]
  rw [ht]
  simp

theorem resolveAux_distinct (rs : List (Nat × Nat)) (hn : (rs.map (·.1)).Nodup) :
    ∀ taken kept, (∀ k ∈ kept, ∀ r ∈ rs, k.1 ≠ r.1) →
      resolveAux taken kept rs = kept ++ rs.map (fun r => (r.1, r.1, r.2)) := by
  induction rs with
  | nil => intro taken kept _; simp [resolveAux]
  | cons r rs ih =>
    intro taken kept hk
    have hn' : (rs.map (·.1)).Nodup := (List.nodup_cons.mp (by simpa using hn)).2
    have hr : r.1 ∉ rs.map (·.1) := (List.nodup_cons.mp (by simpa using hn)).1
    have h1 : kept.any (fun k => k.1 == r.1) = false := by
      rw [List.any_eq_false]; intro k hkm; simpa using hk k hkm r List.mem_cons_self
    have h2 : kept.any (fun k => k.1 == r.1 && k.2.2 == r.2) = false := by
      rw [List.any_eq_false]; intro k hkm; simp [hk k hkm r List.mem_cons_self]
    simp only [resolveAux, h1, h2, Bool.false_eq_true, if_false]
    rw [ih hn' taken _ ?_]
    · simp
    · intro k hkm x hx
      rcases List.mem_append.mp hkm with hkm | hkm
      · exact hk k hkm x (List.mem_cons_of_mem _ hx)
      · simp at hkm; subst hkm; intro heq; exact hr (heq ▸ List.mem_map_of_mem hx)

/-- **P1, one rule applied twice changes nothing**: the PGLite index and the
Postgres writer re-apply the rule to a batch the loader already resolved. -/
theorem resolve_idem (l : List (Nat × Nat)) (hn : (l.map (·.1)).Nodup) : resolve l = l := by
  unfold resolve
  rw [resolveAux_distinct l hn _ [] (by simp)]
  simp only [List.nil_append, List.map_map]
  conv => rhs; rw [← List.map_id l]
  apply List.map_congr_left
  intro x _
  rfl

theorem resolve_twice (l : List (Nat × Nat)) : resolve (resolve l) = resolve l :=
  resolve_idem _ (resolve_ids_distinct l)


/-! ### Follow-up 2: renames made by a store's `save` (Postgres) are REPORTED — the list
handed to the rename listener, which `Plur` records as `engram_rekeyed` in its history. -/

/-- The renames `resolveDuplicateIds` reports: every kept copy whose id changed. -/
def renames (l : List (Nat × Nat)) : List (Nat × Nat) :=
  (resolveAux (l.map (·.1)) [] l).filterMap (fun k => if k.2.1 = k.1 then none else some (k.1, k.2.1))

/-- **Complete**: every stored record read under a changed id is in the report. -/
theorem renames_complete (l : List (Nat × Nat)) (k : Nat × Nat × Nat)
    (hk : k ∈ resolveAux (l.map (·.1)) [] l) (hc : k.2.1 ≠ k.1) : (k.1, k.2.1) ∈ renames l := by
  unfold renames
  exact List.mem_filterMap.mpr ⟨k, hk, by simp [hc]⟩

/-- **Sound**: every reported rename changes an id, and its new id is stored. -/
theorem renames_sound (l : List (Nat × Nat)) (a b : Nat) (h : (a, b) ∈ renames l) :
    a ≠ b ∧ ∃ c, (b, c) ∈ resolve l := by
  unfold renames at h
  obtain ⟨k, hk, hkv⟩ := List.mem_filterMap.mp h
  by_cases hc : k.2.1 = k.1
  · simp [hc] at hkv
  · simp [hc] at hkv
    obtain ⟨rfl, rfl⟩ := hkv
    exact ⟨Ne.symm hc, k.2.2, by unfold resolve; exact List.mem_map.mpr ⟨k, hk, rfl⟩⟩


/-! Delivery (`PostgresAdapter.addRenameListener`): every attached `Plur` instance is a
subscriber with its own history root. A save delivers its renames to EVERY subscriber.
Roots are `Nat`; a history is the list of renames it holds. -/

/-- OLD (single slot, `setRenameListener`): each registration replaced the previous one. -/
def subscribeOld (_subs : List Nat) (r : Nat) : List Nat := [r]
/-- NEW: a set of subscribers; `close()` removes its own. -/
def subscribe (subs : List Nat) (r : Nat) : List Nat := r :: subs
def unsubscribe (subs : List Nat) (r : Nat) : List Nat := subs.filter (· != r)

/-- A save delivering `rs` to every subscriber's history. -/
def deliver (subs : List Nat) (hist : Nat → List (Nat × Nat)) (rs : List (Nat × Nat)) :
    Nat → List (Nat × Nat) :=
  fun root => if root ∈ subs then hist root ++ rs else hist root

/-- **OLD — counterexample**: two instances attach; the first one's history misses the rename. -/
theorem old_first_instance_misses :
    deliver (subscribeOld (subscribeOld [] 1) 2) (fun _ => []) [(5, 6)] 1 = [] := by decide

/-- **Fixed**: every attached instance records every rename of the save. -/
theorem every_subscriber_records (subs : List Nat) (hist : Nat → List (Nat × Nat))
    (rs : List (Nat × Nat)) (root : Nat) (h : root ∈ subs) (x : Nat × Nat) (hx : x ∈ rs) :
    x ∈ deliver subs hist rs root := by
  unfold deliver; rw [if_pos h]; exact List.mem_append_right _ hx

/-- A closed instance records nothing more. -/
theorem closed_records_nothing (subs : List Nat) (hist : Nat → List (Nat × Nat))
    (rs : List (Nat × Nat)) (root : Nat) :
    deliver (unsubscribe subs root) hist rs root = hist root := by
  unfold deliver unsubscribe
  rw [if_neg]
  intro h
  have := (List.mem_filter.mp h).2
  simp at this

theorem two_instances_both_record :
    deliver (subscribe (subscribe [] 1) 2) (fun _ => []) [(5, 6)] 1 = [(5, 6)] ∧
    deliver (subscribe (subscribe [] 1) 2) (fun _ => []) [(5, 6)] 2 = [(5, 6)] := by decide

/-! ### Follow-up 3: `saveEngrams` re-attaching quarantined (schema-invalid) entries. -/

/-- OLD: a quarantined entry whose id a valid engram carries was dropped. -/
def reattachOld (valid : List Nat) (q : List (Nat × Nat)) : List (Nat × Nat) :=
  q.filter (fun x => !(valid.contains x.1))

/-- NEW: it is kept under a fresh id (`freshDuplicateId`; here `freshNat`). -/
def reattach : List Nat → List Nat → List (Nat × Nat) → List (Nat × Nat)
  | _, _, [] => []
  | taken, valid, x :: xs =>
    if x.1 ∈ valid then (freshNat taken, x.2) :: reattach (freshNat taken :: taken) valid xs
    else x :: reattach taken valid xs

/-- **OLD behaviour — counterexample**: the invalid entry (content 9) is lost on save. -/
theorem old_quarantine_dropped : reattachOld [1] [(1, 9)] = [] := by decide

/-- **Fixed, nothing lost**: every quarantined entry is written back, under some id. -/
theorem reattach_no_loss (taken valid : List Nat) (q : List (Nat × Nat)) (x : Nat × Nat)
    (hx : x ∈ q) : ∃ j, (j, x.2) ∈ reattach taken valid q := by
  induction q generalizing taken with
  | nil => cases hx
  | cons y ys ih =>
    simp only [reattach]
    rcases List.mem_cons.mp hx with rfl | hx
    · split
      · exact ⟨_, List.mem_cons_self⟩
      · exact ⟨x.1, List.mem_cons_self⟩
    · split
      · obtain ⟨j, hj⟩ := ih (freshNat taken :: taken) hx; exact ⟨j, List.mem_cons_of_mem _ hj⟩
      · obtain ⟨j, hj⟩ := ih taken hx; exact ⟨j, List.mem_cons_of_mem _ hj⟩

/-- **Fixed, both addressable**: no re-attached entry carries a valid engram's id. -/
theorem reattach_clear (taken valid : List Nat) (q : List (Nat × Nat))
    (hsub : ∀ v ∈ valid, v ∈ taken) (x : Nat × Nat) (hx : x ∈ reattach taken valid q) :
    x.1 ∉ valid := by
  induction q generalizing taken with
  | nil => cases hx
  | cons y ys ih =>
    simp only [reattach] at hx
    split at hx
    · rcases List.mem_cons.mp hx with rfl | hx
      · intro hv; exact freshNat_not_mem taken (hsub _ hv)
      · exact ih (freshNat taken :: taken) (fun v hv => List.mem_cons_of_mem _ (hsub v hv)) hx
    · rename_i hy
      rcases List.mem_cons.mp hx with rfl | hx
      · exact hy
      · exact ih taken hsub hx

theorem reattach_example : reattach [1, 3] [1] [(1, 9), (3, 4)] = [(4, 9), (3, 4)] := by decide

end DupIds

/-! ## 4. Corpus write and version stamp (migrations/runner.ts `saveAndStamp`). The
corpus is abstracted to the schema version it is at; `stamp` is config.yaml's
`schema_version`. -/
namespace Stamp

structure St where
  corpus : Nat
  stamp  : Nat
  /-- a loud error telling the user the two disagree, and how to fix it -/
  loud   : Bool
  deriving DecidableEq

/-- Before the fix: save, then stamp; a failed stamp leaves the saved corpus. -/
def runOld (s : St) (target : Nat) (stampOk : Bool) : St :=
  if stampOk then ⟨target, target, false⟩ else ⟨target, s.stamp, false⟩

/-- The fix: a failed stamp puts the previous corpus back; if that restore also fails
the error names both versions and the manual fix. -/
def runFixed (s : St) (target : Nat) (stampOk restoreOk : Bool) : St :=
  if stampOk then ⟨target, target, false⟩
  else if restoreOk then s else ⟨target, s.stamp, true⟩

/-- **Counterexample (replayed: `formal-r2-persist-schema-stamp.test.ts`).** A rollback
from 6 to 0 whose stamp fails leaves a schema-0 corpus that claims 6 — and no later run
touches it again, since nothing is pending at 6. -/
theorem old_rollback_split : runOld ⟨6, 6, false⟩ 0 false = ⟨0, 6, false⟩ := rfl

/-- **Fixed:** starting consistent, the corpus and the stamp agree after the run,
whatever fails — or the double fault is reported loudly. -/
theorem fixed_consistent (s : St) (h : s.corpus = s.stamp) (target : Nat) (a b : Bool) :
    (runFixed s target a b).corpus = (runFixed s target a b).stamp ∨
    (runFixed s target a b).loud = true := by
  cases a <;> cases b <;> simp [runFixed, h]

/-- Non-vacuity: without a fault the run writes and stamps the target. -/
theorem fixed_success (s : St) (target : Nat) (b : Bool) :
    runFixed s target true b = ⟨target, target, false⟩ := by simp [runFixed]

end Stamp

/-! ## 5. PGLite skip-if-unchanged (storage-pglite.ts `syncFromYaml`, `yamlStat`).

Time is `Nat`; a filesystem with timestamp granularity `g` stamps a write at time `t`
with `tick g t = t / g * g`. A file version is (size, content, time of write). The
content hash is modelled by the content itself (collision-free hash assumption). -/
namespace Fingerprint

def tick (g t : Nat) : Nat := t / g * g

structure Ver where
  size : Nat
  content : Nat
  wrote : Nat

/-- What the index recorded when it last synced version `v` at time `r ≥ v.wrote`. -/
structure Rec where
  stat : Nat × Nat      -- (size, mtime)
  hash : Nat
  racy : Bool

def statOf (g : Nat) (v : Ver) : Nat × Nat := (v.size, tick g v.wrote)

def record (g R : Nat) (v : Ver) (r : Nat) : Rec :=
  ⟨statOf g v, v.content, decide (r - tick g v.wrote < R)⟩

/-- Before the fix: skip iff `size:mtime` matches. -/
def skipOld (g : Nat) (old new : Ver) : Bool := statOf g old == statOf g new

/-- The fix: skip on a non-racy stat match, or when the bytes hash the same. -/
def skipNew (g : Nat) (rc : Rec) (new : Ver) : Bool :=
  (rc.stat == statOf g new && !rc.racy) || rc.hash == new.content

/-- **Counterexample (replayed: `formal-r2-persist-fingerprint.test.ts`).** Granularity 1000:
synced version written at 5000, a same-size rewrite at 5400 with other content is
skipped, and the index keeps serving the old text. -/
theorem old_skips_change : skipOld 1000 ⟨10, 1, 5000⟩ ⟨10, 2, 5400⟩ = true := by decide

/-- **Fixed (soundness):** let `d` bound the time between the read of the bytes and the
moment the record's clock is taken (`Date.now()` just after the hash). If the window
covers granularity plus that delay (`g + d ≤ R`), then for any later version — written
after the synced one was read, i.e. no earlier than `r - d` — a skip means the index is
current. -/
theorem fixed_skip_sound (g R d : Nat) (hg : 0 < g) (hR : g + d ≤ R) (old new : Ver) (r : Nat)
    (hw : r ≤ new.wrote + d)
    (hs : skipNew g (record g R old r) new = true) : new.content = old.content := by
  simp only [skipNew, record, Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq,
    Bool.not_eq_true', decide_eq_false_iff_not] at hs
  rcases hs with ⟨hst, hnr⟩ | hh
  · exfalso
    simp only [statOf, Prod.mk.injEq] at hst
    have ht := hst.2
    -- same tick ⇒ new.wrote < tick old + g, so r - tick old < g ≤ R: the record was racy
    have h1 : tick g old.wrote ≤ old.wrote := Nat.div_mul_le_self _ _
    have h2 : new.wrote < tick g new.wrote + g := by
      unfold tick
      have := Nat.lt_div_mul_add (a := new.wrote) hg
      omega
    omega
  · exact hh.symm

/-- Non-vacuity: a version recorded long after its write, unchanged since, is skipped
for free (no hash needed: the stat match is not racy). -/
theorem fixed_quiet_skip : skipNew 1000 (record 1000 3000 ⟨10, 1, 5000⟩ 9000) ⟨10, 1, 5000⟩ = true := by
  decide

end Fingerprint

/-! ## 6. Save-side shrink guard (engrams.ts `assertShrinkAllowed`, `countEngramsOnDisk`).
A write of `out` records over a file the guard counts as `disk` is allowed iff
`out ≥ 90% of disk`, i.e. `out * 10 ≥ disk * 9`. -/
namespace Shrink

def allowed (disk out : Nat) : Bool := decide (out * 10 ≥ disk * 9)

/-- Undeclared writes in sequence: each is judged against the file as it is now. -/
def ratchet : Nat → List Nat → Option Nat
  | disk, [] => some disk
  | disk, out :: outs => if allowed disk out then ratchet out outs else none

/-- **OLD behaviour, before P2 — counterexample (replayed: `<scratch>/r6/replay6.mts`).** Ten undeclared
writes, each inside the 10% tolerance, take a 100-engram store to 37 without one refusal. -/
theorem ratchet_to_37 : ratchet 100 [90, 81, 73, 66, 60, 54, 49, 45, 41, 37] = some 37 := by decide

/-- The count the guard sees. Before the fix an existing file that could not be
counted gave `none`, and `none` let the write through. -/
inductive Disk | missing | counted (n : Nat) | uncountable

def guardOld (d : Disk) (out : Nat) : Bool :=
  match d with
  | .counted n => allowed n out
  | _ => true

/-- The fix: an existing file that cannot be counted refuses (unless `allowShrink`). -/
def guardNew (d : Disk) (out : Nat) : Bool :=
  match d with
  | .missing => true
  | .counted n => allowed n out
  | .uncountable => false

/-- **Counterexample (replayed: `formal-r2-persist-shrink.test.ts`, conflict markers /
zero bytes / unreadable).** A one-engram write replaces a store nobody could count. -/
theorem old_fails_open : guardOld .uncountable 1 = true := rfl

/-- **Fixed:** an allowed undeclared write never lands on an existing store it could not
count, and never drops more than 10% of one it could. -/
theorem fixed_fail_closed (d : Disk) (out : Nat) (h : guardNew d out = true) :
    d = .missing ∨ ∃ n, d = .counted n ∧ out * 10 ≥ n * 9 := by
  cases d with
  | missing => exact .inl rfl
  | counted n => exact .inr ⟨n, rfl, by simpa [guardNew, allowed] using h⟩
  | uncountable => simp [guardNew] at h

/-- Non-vacuity: a first write and a growing write still go through. -/
theorem fixed_allows : guardNew .missing 1 = true ∧ guardNew (.counted 10) 11 = true := by decide

/-! ### Owner decision P2 (2026-09-27, "gate every removal"): cumulative tolerance.
engrams.ts `judgeShrink` / `shrinkRuns`, branch for branch. Per store file, in process
only: `run = (base, last)` — the baseline of the current run of undeclared shrinks and the
count this process last wrote. `write` = an undeclared save; `declared` = `allowShrink`;
`ext` = someone else rewrote the file (another process, a sync pull), which this process
cannot judge, so the run restarts at the file as it is (the `last = disk` test). -/

inductive Ev | write (out : Nat) | declared (out : Nat) | ext (n : Nat)

structure RS where
  disk : Nat
  run : Option (Nat × Nat)

def judge (s : RS) (out : Nat) : Option (Nat × Nat) :=
  if out ≥ s.disk then some (out, out) else
  let base := match s.run with
    | some (b, l) => if l = s.disk then max b s.disk else s.disk
    | none => s.disk
  if allowed base out then some (base, out) else none

def stepR (s : RS) : Ev → Option RS
  | .write out => (judge s out).map (fun r => ⟨out, some r⟩)
  | .declared out => some ⟨out, some (out, out)⟩
  | .ext n => some ⟨n, s.run⟩

def runR : RS → List Ev → Option RS
  | s, [] => some s
  | s, e :: es => match stepR s e with
    | some s' => runR s' es
    | none => none

/-- A run of writes each smaller than the one before (no growth in between). -/
def Shrinking : Nat → List Nat → Prop
  | _, [] => True
  | disk, o :: os => o < disk ∧ Shrinking o os

/-- **Never weaker than the old per-write rule**: whatever the new guard allows, the
old one allowed (the baseline is never below the file's count). -/
theorem new_implies_old (s : RS) (out : Nat) (r : Nat × Nat) (h : judge s out = some r) :
    allowed s.disk out = true := by
  unfold judge at h
  by_cases hg : out ≥ s.disk
  · simp [allowed]; omega
  · rw [if_neg hg] at h
    simp only at h
    split at h
    · rename_i b l _
      split at h
      · split at h
        · rename_i ha; simp [allowed] at ha ⊢; omega
        · cases h
      · split at h
        · assumption
        · cases h
    · split at h
      · assumption
      · cases h

theorem base_bounds_aux (d : Nat) (outs : List Nat) (s s' : RS)
    (hrun : s.run = some (d, s.disk)) (hle : s.disk ≤ d) (h0 : s.disk * 10 ≥ d * 9)
    (hs : Shrinking s.disk outs) (hr : runR s (outs.map .write) = some s') :
    s'.disk * 10 ≥ d * 9 := by
  induction outs generalizing s with
  | nil => simp [runR] at hr; subst hr; exact h0
  | cons o os ih =>
    have ⟨ho, hos⟩ := hs
    simp only [List.map, runR, stepR] at hr
    have hj : judge s o = if allowed d o then some (d, o) else none := by
      unfold judge
      rw [if_neg (by omega), hrun]
      simp only [if_true]
      rw [Nat.max_eq_left hle]
    rw [hj] at hr
    by_cases ha : allowed d o = true
    · rw [if_pos ha] at hr
      simp only [Option.map] at hr
      have ha' : o * 10 ≥ d * 9 := by simpa [allowed] using ha
      exact ih ⟨o, some (d, o)⟩ rfl (by simp; omega) ha' hos hr
    · rw [if_neg ha] at hr; simp [Option.map] at hr

/-- **P2 (fixed)**: after a write of `d`, a run of undeclared shrinking writes never ends
below 90% of `d` — however many individually tolerated steps it takes. -/
theorem base_bounds (d : Nat) (outs : List Nat) (s' : RS)
    (hs : Shrinking d outs) (hr : runR ⟨d, some (d, d)⟩ (outs.map .write) = some s') :
    s'.disk * 10 ≥ d * 9 :=
  base_bounds_aux d outs ⟨d, some (d, d)⟩ s' rfl (Nat.le_refl _) (by simp; omega) hs hr

/-- The replayed run (`ratchet_to_37`) is refused at its second step. -/
theorem base_refuses_replay : runR ⟨100, some (100, 100)⟩ [.write 90, .write 81] = none := by decide

/-- Non-vacuity: growth, a declared shrink, and someone else's write each start a new run. -/
theorem growth_resets : (runR ⟨100, some (100, 100)⟩ [.write 91, .write 95, .write 86]).isSome = true := by decide

theorem declared_resets : (runR ⟨100, some (100, 100)⟩ [.write 95, .declared 50, .write 46]).isSome = true := by decide

theorem ext_restarts : (runR ⟨100, some (100, 100)⟩ [.write 95, .ext 80, .write 79]).isSome = true := by decide

end Shrink

/-! ## 7. Follow-ups: a pulled rewrite records its count (sync.ts `recordPulledCount`);
short custom stale thresholds are called out (async-lock.ts `warnIfThresholdTooShort`). -/
namespace Followups

/-- Backup gate state, as in `Persistence.Backup` (decision P2): `file` = engrams on
disk, `lw` = what PLUR last recorded writing, `snaps` = snapshots taken. -/
structure PS where
  file : Nat
  lw : Nat
  snaps : Nat
  deriving DecidableEq

inductive Ev | write (n : Nat) | ext (n : Nat) | pull (n : Nat) | snap

/-- The daily gate: snapshot iff the file is not below 90% of the recorded count. -/
def okB (file lw : Nat) : Bool := decide (file * 10 ≥ lw * 9)

def gate (s : PS) : PS :=
  if okB s.file s.lw then { s with lw := s.file, snaps := s.snaps + 1 } else s

def stepOld (s : PS) : Ev → PS
  | .write n => { s with file := n, lw := n }
  | .ext n | .pull n => { s with file := n }
  | .snap => gate s

/-- The fix: a pull that rewrites the store is a PLUR write — it records its count. -/
def stepNew (s : PS) : Ev → PS
  | .write n | .pull n => { s with file := n, lw := n }
  | .ext n => { s with file := n }
  | .snap => gate s

/-- **Counterexample (replayed on HEAD: `day2 taken: false [ 'shrunk' ]`).** 20 engrams,
a pulled legitimate shrink to 10: the next day's backup is refused. -/
theorem old_pulled_shrink_refused : (stepOld (stepOld ⟨20, 20, 1⟩ (.pull 10)) .snap).snaps = 1 := by
  decide

/-- **Fixed:** after any pull, the next daily check snapshots. -/
theorem pull_then_snap (s : PS) (n : Nat) : (stepNew (stepNew s (.pull n)) .snap).snaps = s.snaps + 1 := by
  have h : okB n n = true := by simp [okB]; omega
  simp [stepNew, gate, h]

/-- An external truncation (no PLUR write, no pull) is still refused. -/
theorem ext_still_refused (s : PS) (m : Nat) (hm : m * 10 < s.lw * 9) :
    stepNew (stepNew s (.ext m)) .snap = { s with file := m } := by
  have h : okB m s.lw = false := by simp [okB]; omega
  simp [stepNew, gate, h]

/-- Heartbeat bound (`Persistence.Heartbeat.sync_age_bound`): a lock's age stays below
`T/3 + B` for blocking steps ≤ `B`. The warning fires exactly when that bound does not
keep it under the threshold. -/
def warns (T B : Nat) : Bool := decide (T / 3 + B ≥ T)

theorem warns_iff (T B : Nat) : warns T B = false ↔ T / 3 + B < T := by
  simp [warns]

/-- With git's 30 s timeout: 40 s warns, the 60 s default does not. -/
theorem warns_examples : warns 40000 30000 = true ∧ warns 60000 30000 = false := by decide

end Followups

end PlurSpec.R2Persist
