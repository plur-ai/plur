/-!
# PlurSpec.Persistence — sync, migrations, locks, backups, outbox order, packs

Models of `packages/core/src/{sync.ts, migrations/runner.ts, store/async-lock.ts,
storage-postgres.ts, backup.ts, outbox-order.ts, learn-async.ts, packs.ts}`.
Findings, verdicts and replays: `spec/formal/findings/persistence.md`.

Payloads (engram records, YAML bytes, git merges) are abstract: every theorem holds
for every record type, keep-predicate and merge oracle satisfying the stated
hypotheses.
-/

namespace PlurSpec.Persistence

/-! ## 1. Git sync (sync.ts `sync` State 3, `pullRebase`, `holdWithheld`, `restoreWithheld`)

Three snapshots of `engrams.yaml`: the working tree `W`, `HEAD`, and the remote.
`commitChanges` makes `HEAD = strip W` (the push-set filter, #396/#640). `git pull`
refuses when a file it must update is dirty (`W ≠ HEAD`). The remote merge is an
oracle `merge : List α → List α` (HEAD ↦ new HEAD). -/
namespace Sync

variable {α : Type} (keep : α → Bool)

/-- `stageStrippedEngrams`: the committed blob keeps only the push set. -/
def strip (w : List α) : List α := w.filter keep

/-- Records the push set withholds (scope:local, or personal/private on `shared`). -/
def held (w : List α) : List α := w.filter (fun x => !keep x)

structure Tree (α : Type) where
  work : List α
  head : List α

/-- Before the fix: `git pull` on a tree whose tracked file differs from HEAD refuses
(`none` = "NOT pulled — still N commit(s) behind"). -/
def pullOld [DecidableEq α] (merge : List α → List α) (t : Tree α) : Option (Tree α) :=
  if t.work = t.head then some ⟨merge t.head, merge t.head⟩ else none

/-- The fix: hold the withheld records in memory, reset the file to HEAD (clean
tree), pull, then restore — verbatim when the pull left the file alone, otherwise
the pulled file with the held records appended. -/
def pullFixed [DecidableEq α] (merge : List α → List α) (w : List α) : Tree α :=
  if merge (strip keep w) = strip keep w then ⟨w, merge (strip keep w)⟩
  else ⟨merge (strip keep w) ++ held keep w, merge (strip keep w)⟩

/-- **Counterexample (confirmed by replay).** After any commit, one withheld record
makes every pull refuse — forever, since nothing changes between retries. -/
theorem old_never_pulls [DecidableEq α] (merge : List α → List α) (w : List α)
    (x : α) (hx : x ∈ w) (hk : keep x = false) :
    pullOld merge ⟨w, strip keep w⟩ = none := by
  unfold pullOld
  have hne : w ≠ strip keep w := by
    intro heq
    have : ∀ a, a ∈ w → keep a = true := List.filter_eq_self.mp heq.symm
    rw [this x hx] at hk
    exact Bool.noConfusion hk
  simp [hne]

/-- Non-vacuity: with no withheld record the old code does pull. -/
theorem old_pulls_when_nothing_withheld [DecidableEq α] (merge : List α → List α)
    (w : List α) (hall : ∀ a, a ∈ w → keep a = true) :
    pullOld merge ⟨w, strip keep w⟩ = some ⟨merge w, merge w⟩ := by
  have : strip keep w = w := List.filter_eq_self.mpr hall
  simp [pullOld, this]

/-- Fixed: the pull always happens (HEAD is the merged remote). -/
theorem fixed_pulls [DecidableEq α] (merge : List α → List α) (w : List α) :
    (pullFixed keep merge w).head = merge (strip keep w) := by
  unfold pullFixed; split <;> rfl

/-- Fixed: no record of the working tree is lost, provided the merge keeps what
HEAD had (a merge that deletes a committed record is the remote's decision). -/
theorem fixed_no_loss [DecidableEq α] (merge : List α → List α) (w : List α)
    (hm : ∀ y, y ∈ strip keep w → y ∈ merge (strip keep w)) :
    ∀ x, x ∈ w → x ∈ (pullFixed keep merge w).work := by
  intro x hx
  unfold pullFixed
  split
  · exact hx
  · simp only [List.mem_append]
    cases hk : keep x
    · right; exact List.mem_filter.mpr ⟨hx, by simp [hk]⟩
    · left; exact hm x (List.mem_filter.mpr ⟨hx, hk⟩)

/-- Fixed: nothing withheld leaks — the next commit's stripped blob is exactly the
pulled HEAD (no spurious commit, no withheld record in it), provided the remote only
ever carries push-set records. -/
theorem fixed_no_leak [DecidableEq α] (merge : List α → List α) (w : List α)
    (hr : ∀ y, y ∈ merge (strip keep w) → keep y = true) :
    strip keep (pullFixed keep merge w).work = (pullFixed keep merge w).head := by
  unfold pullFixed
  split
  · rename_i h; simp only [strip] at h ⊢; exact h.symm
  · simp only [strip, held, List.filter_append, List.filter_filter]
    have h1 : List.filter keep (merge (List.filter keep w)) = merge (List.filter keep w) :=
      List.filter_eq_self.mpr hr
    have h2 : List.filter (fun a => keep a && !keep a) w = [] := by
      simp
    rw [h1, h2, List.append_nil]

end Sync

/-! ## 2. Migration runner (migrations/runner.ts `runMigrations`, `rollbackMigrations`)

`createBackup` is no-clobber: an existing `.bak.<v>` is kept, whatever the live file
now holds. Each step is an oracle `σ → Option σ` (`none` = the step threw). Steps run
on an in-memory copy; the live file is written only after all succeed. -/
namespace Migration

variable {σ : Type}

/-- Run the steps in memory: `none` as soon as one throws. -/
def runSteps : List (σ → Option σ) → σ → Option σ
  | [], s => some s
  | m :: ms, s => match m s with
    | none => none
    | some s' => runSteps ms s'

structure Disk (σ : Type) where
  live : σ
  bak : Option σ

/-- No-clobber backup: keep an existing one. -/
def backup (d : Disk σ) : σ := d.bak.getD d.live

/-- Before the fix: on failure, copy the backup over the live file. -/
def runOld (steps : List (σ → Option σ)) (d : Disk σ) : Disk σ :=
  let b := backup d
  match runSteps steps d.live with
  | none => ⟨b, some b⟩
  | some s => ⟨s, some b⟩

/-- The fix: on failure, write nothing. -/
def runFixed (steps : List (σ → Option σ)) (d : Disk σ) : Disk σ :=
  let b := backup d
  match runSteps steps d.live with
  | none => ⟨d.live, some b⟩
  | some s => ⟨s, some b⟩

/-- **Counterexample (confirmed by replay: 3 engrams → 1).** A stale backup plus a
failing step replaces the live store. -/
theorem old_failed_run_replaces_live :
    (runOld (σ := Nat) [fun _ => none] ⟨3, some 1⟩).live = 1 := rfl

/-- Fixed: a failed run leaves the live file identical, for every backup state. -/
theorem fixed_failed_run_keeps_live (steps : List (σ → Option σ)) (d : Disk σ)
    (hfail : runSteps steps d.live = none) :
    (runFixed steps d).live = d.live := by
  simp [runFixed, hfail]

/-- Non-vacuity: a successful run writes the migrated corpus. -/
theorem fixed_success_writes (steps : List (σ → Option σ)) (d : Disk σ) (s : σ)
    (hok : runSteps steps d.live = some s) :
    (runFixed steps d).live = s := by
  simp [runFixed, hok]

/-- The backup is still taken (kept for manual recovery), unchanged by the fix. -/
theorem fixed_keeps_backup (steps : List (σ → Option σ)) (d : Disk σ) :
    (runFixed steps d).bak = some (backup d) := by
  unfold runFixed; split <;> rfl

end Migration

/-! ## 3. File lock steal (store/async-lock.ts `stealLock`; sync twin `stealLockSync`)

Processes are `Nat`s. `lock` is the token in `<file>.lock` (the holder's id). A
process is `dead` (liveness probe = false) forever and never acts. `hold p` = p is in
the critical section. `claim p = some (h, x)`: p renamed the lock aside, having judged
`h` stale; the moved file actually carried `x`. -/
namespace Lock

def upd {β : Type} (f : Nat → β) (p : Nat) (v : β) : Nat → β :=
  fun q => if q = p then v else f q

structure LS where
  lock  : Option Nat
  hold  : Nat → Bool
  guard : Option Nat
  seen  : Nat → Option Nat
  claim : Nat → Option (Nat × Nat)

/-- `claimAndRemove` tail: unlink when the moved file is the stale one, otherwise
put it back with `wx` (only if the path is still empty). -/
def finishLock (s : LS) (h x : Nat) : Option Nat :=
  if x = h then s.lock else (if s.lock = none then some x else s.lock)

/-! ### Before the fix: no guard, the judgement `seen` may be arbitrarily old. -/

inductive Act where
  | acq (p : Nat) | rel (p : Nat) | judge (p h : Nat) | rename (p : Nat) | finish (p : Nat)

/-- Old protocol, executable. `judge p h`: p observed stale `h` at `lock` (liveness
false). `rename p`: moves WHATEVER is at `lock` now. -/
def stepOld (dead : Nat → Bool) (s : LS) : Act → Option LS
  | .acq p => if dead p = false ∧ s.lock = none then
      some { s with lock := some p, hold := upd s.hold p true } else none
  | .rel p => if s.hold p = true then
      some { s with hold := upd s.hold p false, lock := if s.lock = some p then none else s.lock } else none
  | .judge p h => if dead p = false ∧ dead h = true ∧ s.lock = some h then
      some { s with seen := upd s.seen p (some h) } else none
  | .rename p => match s.seen p, s.lock with
      | some h, some x => some { s with claim := upd s.claim p (some (h, x)), lock := none,
                                        seen := upd s.seen p none }
      | _, _ => none
  | .finish p => match s.claim p with
      | some (h, x) => some { s with lock := finishLock s h x, claim := upd s.claim p none }
      | none => none

def runOld (dead : Nat → Bool) : LS → List Act → Option LS
  | s, [] => some s
  | s, a :: as => match stepOld dead s a with
    | some s' => runOld dead s' as
    | none => none

def init0 : LS := ⟨some 9, fun _ => false, none, fun _ => none, fun _ => none⟩
def dead9 : Nat → Bool := fun p => p == 9

/-- **Counterexample (confirmed by replay, `formal-persistence-lock.test.ts`).**
H=9 is dead. A=1 and B=2 both judge it stale; A claims, confirms and acquires; B's
rename moves A's live lock aside; C=3 O_EXCL-acquires; B's put-back loses. A and C
are both in the critical section. -/
theorem old_two_holders :
    (runOld dead9 init0
      [.judge 1 9, .judge 2 9, .rename 1, .finish 1, .acq 1, .rename 2, .acq 3, .finish 2]).map
      (fun s => (s.hold 1, s.hold 3)) = some (true, true) := by decide

/-! ### The fix: a guard serializes stealers, and the lock is re-read under it. -/

inductive FStep (dead : Nat → Bool) : LS → LS → Prop
  | acq (p : Nat) (s : LS) : dead p = false → s.lock = none →
      FStep dead s { s with lock := some p, hold := upd s.hold p true }
  | rel (p : Nat) (s : LS) : s.hold p = true →
      FStep dead s { s with hold := upd s.hold p false,
                            lock := if s.lock = some p then none else s.lock }
  | gAcq (p : Nat) (s : LS) : dead p = false → s.guard = none →
      FStep dead s { s with guard := some p, seen := upd s.seen p none }
  /-- `now === expected` under the guard; `expected` came from a liveness=false probe. -/
  | gRead (p h : Nat) (s : LS) : dead p = false → s.guard = some p → dead h = true →
      FStep dead s { s with seen := upd s.seen p (if s.lock = some h then some h else none) }
  | gRename (p h x : Nat) (s : LS) : dead p = false → s.guard = some p → s.seen p = some h →
      s.lock = some x →
      FStep dead s { s with claim := upd s.claim p (some (h, x)), lock := none,
                            seen := upd s.seen p none }
  | gFinish (p h x : Nat) (s : LS) : dead p = false → s.claim p = some (h, x) →
      FStep dead s { s with lock := finishLock s h x, claim := upd s.claim p none }
  | gRel (p : Nat) (s : LS) : dead p = false → s.guard = some p → s.claim p = none →
      FStep dead s { s with guard := none, seen := upd s.seen p none }

structure Inv (dead : Nat → Bool) (s : LS) : Prop where
  holders : ∀ q, s.hold q = true → s.lock = some q ∧ dead q = false
  seen    : ∀ p h, s.seen p = some h → s.guard = some p ∧ s.lock = some h ∧ dead h = true
  claims  : ∀ p h x, s.claim p = some (h, x) → x = h

set_option linter.deprecated false in
theorem inv_step (dead : Nat → Bool) (s s' : LS) (hi : Inv dead s) (hs : FStep dead s s') :
    Inv dead s' := by
  cases hs with
  | acq p s hd hl =>
    refine ⟨?_, ?_, ?_⟩
    · intro q hq
      simp only [upd] at hq ⊢
      by_cases hqp : q = p
      · subst hqp; exact ⟨rfl, hd⟩
      · rw [if_neg hqp] at hq
        have := (hi.holders q hq).1; rw [hl] at this; cases this
    · intro p' h hh
      have := (hi.seen p' h hh).2.1; rw [hl] at this; cases this
    · exact hi.claims
  | rel p s hp =>
    have ⟨hlp, hdp⟩ := hi.holders p hp
    refine ⟨?_, ?_, ?_⟩
    · intro q hq
      simp only [upd] at hq ⊢
      by_cases hqp : q = p
      · rw [if_pos hqp] at hq; cases hq
      · rw [if_neg hqp] at hq
        have ⟨hlq, hdq⟩ := hi.holders q hq
        rw [hlp] at hlq; cases hlq; exact absurd rfl hqp
    · intro p' h hh
      have ⟨_, hl, hdh⟩ := hi.seen p' h hh
      rw [hlp] at hl; cases hl; rw [hdp] at hdh; cases hdh
    · exact hi.claims
  | gAcq p s hd hg =>
    refine ⟨hi.holders, ?_, hi.claims⟩
    intro p' h hh
    simp only [upd] at hh ⊢
    by_cases hq : p' = p
    · rw [if_pos hq] at hh; cases hh
    · rw [if_neg hq] at hh
      have := (hi.seen p' h hh).1; rw [hg] at this; cases this
  | gRead p h s hd hg hdh =>
    refine ⟨hi.holders, ?_, hi.claims⟩
    intro p' h' hh
    simp only [upd] at hh ⊢
    by_cases hq : p' = p
    · rw [if_pos hq] at hh
      by_cases hl : s.lock = some h
      · rw [if_pos hl] at hh; cases hh; exact ⟨hq ▸ hg, hl, hdh⟩
      · rw [if_neg hl] at hh; cases hh
    · rw [if_neg hq] at hh; exact hi.seen p' h' hh
  | gRename p h x s hd hg hsp hl =>
    have ⟨_, hlh, hdh⟩ := hi.seen p h hsp
    rw [hl] at hlh; cases hlh
    refine ⟨?_, ?_, ?_⟩
    · intro q hq
      have ⟨hlq, hdq⟩ := hi.holders q hq
      rw [hl] at hlq; cases hlq; rw [hdh] at hdq; cases hdq
    · intro p' h' hh
      simp only [upd] at hh ⊢
      by_cases hq : p' = p
      · rw [if_pos hq] at hh; cases hh
      · rw [if_neg hq] at hh
        have ⟨hg', _, _⟩ := hi.seen p' h' hh
        rw [hg] at hg'; cases hg'; exact absurd rfl hq
    · intro p' h' x' hc
      simp only [upd] at hc
      by_cases hq : p' = p
      · rw [if_pos hq] at hc; cases hc; rfl
      · rw [if_neg hq] at hc; exact hi.claims p' h' x' hc
  | gFinish p h x s hd hc =>
    have hxh := hi.claims p h x hc
    have hfl : finishLock s h x = s.lock := by simp [finishLock, hxh]
    refine ⟨?_, ?_, ?_⟩
    · intro q hq; rw [hfl]; exact hi.holders q hq
    · intro p' h' hh; rw [hfl]; exact hi.seen p' h' hh
    · intro p' h' x' hc'
      simp only [upd] at hc'
      by_cases hq : p' = p
      · rw [if_pos hq] at hc'; cases hc'
      · rw [if_neg hq] at hc'; exact hi.claims p' h' x' hc'
  | gRel p s hd hg hc =>
    refine ⟨hi.holders, ?_, hi.claims⟩
    intro p' h hh
    simp only [upd] at hh ⊢
    by_cases hq : p' = p
    · rw [if_pos hq] at hh; cases hh
    · rw [if_neg hq] at hh
      have ⟨hg', hl, hd'⟩ := hi.seen p' h hh
      rw [hg] at hg'; cases hg'; exact absurd rfl hq

inductive Reach (dead : Nat → Bool) (s0 : LS) : LS → Prop
  | refl : Reach dead s0 s0
  | step (s s' : LS) : Reach dead s0 s → FStep dead s s' → Reach dead s0 s'

/-- **Mutual exclusion (fixed protocol):** from any state satisfying the invariant —
in particular a dead holder's lock and nobody inside — at most one process is ever in
the critical section. -/
theorem reach_inv (dead : Nat → Bool) (s0 s : LS) (h0 : Inv dead s0) (hr : Reach dead s0 s) :
    Inv dead s := by
  induction hr with
  | refl => exact h0
  | step s s' _ hs ih => exact inv_step dead s s' ih hs

/-- **Mutual exclusion (fixed protocol):** from any state satisfying the invariant —
in particular a dead holder's lock and nobody inside — at most one process is ever in
the critical section. -/
theorem fixed_mutex (dead : Nat → Bool) (s0 s : LS) (h0 : Inv dead s0) (hr : Reach dead s0 s)
    (p q : Nat) (hp : s.hold p = true) (hq : s.hold q = true) : p = q := by
  have hi := reach_inv dead s0 s h0 hr
  have := (hi.holders p hp).1
  rw [(hi.holders q hq).1] at this
  cases this; rfl

theorem init0_inv : Inv dead9 init0 := by
  refine ⟨?_, ?_, ?_⟩
  · intro q hq; exact absurd hq (by simp [init0])
  · intro p h hh; exact absurd hh (by simp [init0])
  · intro p h x hc; exact absurd hc (by simp [init0])

/-- Non-vacuity: under the fixed protocol the dead holder's lock IS stolen and a live
process gets in. -/
theorem fixed_steal_reachable :
    ∃ s, Reach dead9 init0 s ∧ s.hold 1 = true := by
  let s1 : LS := { init0 with guard := some 1, seen := upd init0.seen 1 none }
  let s2 : LS := { s1 with seen := upd s1.seen 1 (if s1.lock = some 9 then some 9 else none) }
  let s3 : LS := { s2 with claim := upd s2.claim 1 (some (9, 9)), lock := none,
                           seen := upd s2.seen 1 none }
  let s4 : LS := { s3 with lock := finishLock s3 9 9, claim := upd s3.claim 1 none }
  let s5 : LS := { s4 with guard := none, seen := upd s4.seen 1 none }
  let s6 : LS := { s5 with lock := some 1, hold := upd s5.hold 1 true }
  refine ⟨s6, ?_, rfl⟩
  have r1 : Reach dead9 init0 s1 := .step _ _ .refl (.gAcq 1 init0 rfl rfl)
  have r2 : Reach dead9 init0 s2 := .step _ _ r1 (.gRead 1 9 s1 rfl rfl rfl)
  have r3 : Reach dead9 init0 s3 := .step _ _ r2 (.gRename 1 9 9 s2 rfl rfl rfl rfl)
  have r4 : Reach dead9 init0 s4 := .step _ _ r3 (.gFinish 1 9 9 s3 rfl rfl)
  have r5 : Reach dead9 init0 s5 := .step _ _ r4 (.gRel 1 s4 rfl rfl rfl)
  exact .step _ _ r5 (.acq 1 s5 rfl rfl)

end Lock

/-! ## 3b. Lock heartbeat (decision P1; async-lock.ts `startHeartbeat`,
`heartbeatHeldLocks`; sync.ts `withLock`, `git`)

A contender that cannot probe the holder (another host) steals iff the lock's
age exceeds `T` (staleThreshold). Time in whole units; `age` = time since the
lock file was last touched. -/
namespace Heartbeat

/-- Pre-fix: the file is touched only at acquisition (time 0). -/
def staleOld (T t : Nat) : Bool := decide (t > T)

/-- Post-fix, async work: a timer touches every `H` units, so at time `t` the
age is `t % H`. -/
def staleTimer (T H t : Nat) : Bool := decide (t % H > T)

/-- Replayed pre-fix: a holder on another host 61 s into a 90 s hold, threshold 60 s. -/
theorem old_stolen_mid_hold : staleOld 60 61 = true := by decide

/-- **Fixed code (P1), timer:** with the interval `T / 3` (T ≥ 3), a holder is
never judged stale at any time during its hold. -/
theorem timer_never_stale (T t : Nat) (hT : 3 ≤ T) : staleTimer T (T / 3) t = false := by
  have hH : 0 < T / 3 := by omega
  have h := Nat.mod_lt t hH
  simp only [staleTimer, decide_eq_false_iff_not]
  omega

/-- Post-fix, synchronous work (git under `Plur.sync`): touch points are the
starts of blocking segments (`gaps`, each ≤ `B`); a touch point re-touches iff the
last touch is ≥ `H` old (the throttle in `heartbeatHeldLocks`). The list is the
lock's age at the END of each segment — the oldest it gets. -/
def syncAges (H : Nat) : Nat → List Nat → List Nat
  | _, [] => []
  | a, g :: gs =>
    let a' := if a ≥ H then 0 else a
    (a' + g) :: syncAges H (a' + g) gs

/-- **Fixed code (P1), synchronous touch points:** the age never reaches
`H + B`, for every sequence of blocking segments of length ≤ `B`. With the
defaults (H = 60/3 = 20 s, git timeout B = 30 s) that is < 50 s < 60 s. -/
theorem sync_age_bound (H B : Nat) (hH : 0 < H) :
    ∀ (a : Nat) (gs : List Nat), (∀ g ∈ gs, g ≤ B) → ∀ x ∈ syncAges H a gs, x < H + B := by
  intro a gs
  induction gs generalizing a with
  | nil => intro _ x hx; cases hx
  | cons g gs ih =>
    intro hg x hx
    simp only [syncAges, List.mem_cons] at hx
    have hg0 := hg g (List.mem_cons_self ..)
    rcases hx with rfl | hx
    · split <;> omega
    · exact ih _ (fun g' h' => hg g' (List.mem_cons_of_mem _ h')) x hx

/-- The default sync hold (three 30 s git commands) stays below the 60 s
threshold; before the fix its age reached 90 s. -/
theorem default_sync_fresh : ∀ x ∈ syncAges 20 0 [30, 30, 30], x < 60 := by decide
theorem old_default_sync_stale : staleOld 60 (30 + 30 + 30) = true := by decide

end Heartbeat

/-! ## 4. Postgres advisory lock session (storage-postgres.ts `withExclusiveAccess`)

A checkout ends in `release()` (back to idle) or `release(err)` (destroyed). The
advisory lock belongs to the session. `unlockOk` is the oracle outcome of
`pg_advisory_unlock`. -/
namespace PgLock

/-- Where the session ends up: `some locked?` = back in the pool (with its lock
state), `none` = destroyed. -/
def endOld (unlockOk : Bool) : Option Bool :=
  some (!unlockOk)                          -- bare `client.release()`

def endFixed (unlockOk : Bool) : Option Bool :=
  if unlockOk then some false else none     -- `client.release(poisoned)`

/-- **Counterexample (confirmed by replay):** a failed unlock returns a session that
still holds the lock to the pool. -/
theorem old_pool_gets_locked_session : endOld false = some true := rfl

/-- Fixed: no pooled session ever holds the advisory lock. -/
theorem fixed_pool_never_locked (u : Bool) : endFixed u ≠ some true := by
  cases u <;> simp [endFixed]

/-- Non-vacuity: a clean unlock still returns the session for reuse. -/
theorem fixed_clean_reuses : endFixed true = some false := rfl

end PgLock

/-! ## 5. Daily backup gate (backup.ts `maybeDailyBackup`, `validateStore`, `idsCreatedAfter`)

The shrink gate refuses a snapshot when `count < 0.9 · last_good_count`
(`count * 10 < last * 9` in ℕ); `last_good_count` is written ONLY by a successful
snapshot. -/
namespace Backup

structure BState where
  lastGood : Nat
  taken : Nat          -- snapshots taken

def day (s : BState) (count : Nat) : BState :=
  if count * 10 < s.lastGood * 9 then s else ⟨count, s.taken + 1⟩

def days (s : BState) : List Nat → BState
  | [] => s
  | c :: cs => days (day s c) cs

/-- **Confirmed (replayed; NEEDS-OWNER):** after one legitimate drop below 90% of the
last good count, no later day ever snapshots while the corpus stays below that floor —
the baseline that would have to move is only moved by a snapshot. -/
theorem backups_stop (s : BState) (cs : List Nat) (h : ∀ c, c ∈ cs → c * 10 < s.lastGood * 9) :
    days s cs = s := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    have hc := h c (List.mem_cons_self ..)
    simp only [days, day, hc, ↓reduceIte]
    exact ih s (fun c' hc' => h c' (List.mem_cons_of_mem _ hc'))

/-- Non-vacuity: a healthy day does snapshot and moves the baseline. -/
theorem healthy_day_snapshots : day ⟨100, 1⟩ 95 = ⟨95, 2⟩ := by simp [day]

/-- `idsCreatedAfter`, fixed: only canonical engram ids are reported. `isEngramId`
abstracts the `^(ENG|ABS|META)-…$` test. -/
def unrecoverable (isEngramId : String → Bool) (inBackup : String → Bool)
    (events : List String) : List String :=
  (events.filter isEngramId).filter (fun i => !inBackup i)

theorem unrecoverable_only_engrams (isEngramId inBackup : String → Bool) (evs : List String)
    (i : String) (hi : i ∈ unrecoverable isEngramId inBackup evs) : isEngramId i = true := by
  simp only [unrecoverable, List.mem_filter] at hi
  exact hi.1.2

/-! ### Decision P2 (last-written), post-fix.
The write path records the count PLUR wrote (`saveEngrams` → `recordLastWritten`);
the gate compares the file against that. `file` is what is on disk, `lw` the
recorded count. -/

structure PState where
  file : Nat
  lw : Nat
  taken : Nat
  deriving DecidableEq, Repr

inductive Ev | write (n : Nat) | ext (n : Nat) | snap

/-- One event: a PLUR write sets both the file and the record; an external change
(truncation, hand edit) moves only the file; a daily snapshot is taken iff the
file is not below 90% of what PLUR last wrote. -/
def stepP (s : PState) : Ev → PState
  | .write n => ⟨n, n, s.taken⟩
  | .ext n => ⟨n, s.lw, s.taken⟩
  | .snap => if s.file * 10 < s.lw * 9 then s else ⟨s.file, s.lw, s.taken + 1⟩

def runP (s : PState) : List Ev → PState
  | [] => s
  | e :: es => runP (stepP s e) es

/-- **Fixed code (P2):** whatever PLUR wrote last — including any legitimate
shrink — the next daily check snapshots it. Backups can no longer stop for good
after a deliberate removal. -/
theorem write_then_snap (s : PState) (n : Nat) :
    (stepP (stepP s (.write n)) .snap).taken = s.taken + 1 := by
  have h : ¬ (n * 10 < n * 9) := by omega
  simp [stepP, h]

/-- **Fixed code (P2):** a file that shrank below 90% of what PLUR last wrote,
without PLUR writing it, is still refused — the state is unchanged. -/
theorem truncation_refused (s : PState) (m : Nat) (h : m * 10 < s.lw * 9) :
    stepP (stepP s (.ext m)) .snap = ⟨m, s.lw, s.taken⟩ := by
  simp [stepP, h]

/-- The replayed sequence (100 on day 1, a legitimate forget to 70, then days
2–4) now snapshots every day; with the old gate `backups_stop` it never did. -/
theorem replay_rebaselines :
    (runP ⟨0, 0, 0⟩ [.write 100, .snap, .write 70, .snap, .snap, .snap]).taken = 4 := by decide

/-- …and an external truncation after the legitimate shrink is still refused. -/
theorem replay_truncation_refused :
    (runP ⟨0, 0, 0⟩ [.write 100, .snap, .write 70, .ext 50, .snap]).taken = 1 := by decide

/-! ### Decision P3 (engram_created only), post-fix `idsCreatedAfter`. -/

inductive Kind | created | retired | other
  deriving DecidableEq

/-- Events after the snapshot instant, as (kind, id). Reported: ids with a
`created` event, minus ids with a `retired` event, minus ids in the backup. -/
def unrecoverableP3 (inBackup : String → Bool) (evs : List (Kind × String)) : List String :=
  let created := (evs.filter (fun e => e.1 == .created)).map Prod.snd
  let retired := (evs.filter (fun e => e.1 == .retired)).map Prod.snd
  (created.filter (fun i => !retired.contains i)).filter (fun i => !inBackup i)

/-- **Fixed code (P3):** every reported id was created after the snapshot, was
not retired since, and is not in the backup — for every event log. -/
theorem unrecoverableP3_sound (inBackup : String → Bool) (evs : List (Kind × String))
    (i : String) (hi : i ∈ unrecoverableP3 inBackup evs) :
    (Kind.created, i) ∈ evs ∧ (Kind.retired, i) ∉ evs ∧ inBackup i = false := by
  simp only [unrecoverableP3, List.mem_filter, List.mem_map] at hi
  obtain ⟨⟨⟨⟨k, j⟩, ⟨hmem, hk⟩, rfl⟩, hr⟩, hb⟩ := hi
  simp only [beq_iff_eq] at hk
  subst hk
  refine ⟨hmem, ?_, by simpa using hb⟩
  intro hret
  have hm : j ∈ (evs.filter (fun e => e.1 == Kind.retired)).map Prod.snd :=
    List.mem_map.mpr ⟨(Kind.retired, j), List.mem_filter.mpr ⟨hret, rfl⟩, rfl⟩
  simp [hm] at hr

/-- Non-vacuity: a created, unretired id absent from the backup is reported;
feedback on an older engram is not. -/
theorem unrecoverableP3_reports :
    unrecoverableP3 (fun _ => false) [(.created, "ENG-050"), (.other, "ENG-007"),
      (.created, "ENG-060"), (.retired, "ENG-060")] = ["ENG-050"] := by decide

end Backup

/-! ## 6. Outbox flush order (outbox-order.ts `orderBySupersedes`)

Modelled: the permutation property (nothing vanishes, nothing doubles). Left out: the
edge-order and stability properties of the Kahn loop — covered by the randomized
property test `formal-persistence-outbox-order.test.ts` (300 random DAGs), not proved. -/
namespace Outbox

/-- Old shape, keyed by id: the emitted ids are looked up in a last-wins map. -/
def lastWins (rows : List (Nat × Nat)) (id : Nat) : Option (Nat × Nat) :=
  rows.foldl (fun acc r => if r.1 = id then some r else acc) none

/-- With no edges every row is ready; the ready list holds each row's id. -/
def oldNoEdges (rows : List (Nat × Nat)) : List (Option (Nat × Nat)) :=
  rows.map (fun r => lastWins rows r.1)

/-- **Counterexample (confirmed by replay):** rows `(id, tag)` = `(7,1),(7,2)` come out
as the second copy twice; the first vanishes. -/
theorem old_duplicate_drops :
    oldNoEdges [(7, 1), (7, 2)] = [some (7, 2), some (7, 2)] := by decide

/-- Fixed shape, keyed by position: the Kahn loop emits positions `o` (each at most
once — `placed` guards it — and all `< n`), then every unplaced position in order. -/
def fixedOrder (n : Nat) (o : List Nat) : List Nat :=
  o ++ (List.range n).filter (fun i => !o.contains i)

theorem fixed_is_permutation (n : Nat) (o : List Nat) (hnd : o.Nodup)
    (hlt : ∀ i, i ∈ o → i < n) : (fixedOrder n o).Perm (List.range n) := by
  rw [List.perm_iff_count]
  intro a
  have hr : (List.range n).count a = if a ∈ List.range n then 1 else 0 :=
    List.nodup_range.count
  simp only [fixedOrder, List.count_append, hnd.count, hr]
  by_cases ho : a ∈ o
  · have hin : a ∈ List.range n := List.mem_range.mpr (hlt a ho)
    have h0 : List.count a ((List.range n).filter (fun i => !decide (i ∈ o))) = 0 :=
      List.count_eq_zero.mpr (by simp [ho])
    simp [ho, hin]
    exact h0
  · have hf : List.count a ((List.range n).filter (fun i => !o.contains i)) =
        List.count a (List.range n) := List.count_filter (by simp [ho])
    rw [hf, hr]; simp [ho]

/-- Non-vacuity: with no edges the order is the identity (stability). -/
theorem fixed_no_edges_identity (n : Nat) (o : List Nat) (ho : o = List.range n) :
    fixedOrder n o = List.range n := by
  subst ho; simp [fixedOrder]

end Outbox

/-! ## 7. Dedup UPDATE/MERGE vs `commitment: locked` (learn-async.ts `executeDedupDecision`)

`pre` is the snapshot read before the store lock (`getById`), `cur` the row re-read
under it. A write is allowed only on an unlocked row. -/
namespace LearnAsync

structure Row where
  locked : Bool
  stmt : Nat

/-- Before: checks `pre`, writes onto `cur`. `none` = falls back to ADD. -/
def writeOld (pre cur : Row) (new : Nat) : Option Row :=
  if pre.locked then none else some { cur with stmt := new }

/-- Fixed: checks `cur` too, under the lock. -/
def writeFixed (pre cur : Row) (new : Nat) : Option Row :=
  if pre.locked || cur.locked then none else some { cur with stmt := new }

/-- **Counterexample (confirmed by replay):** locked between the check and the lock ⇒
the locked row is rewritten. -/
theorem old_overwrites_locked :
    writeOld ⟨false, 1⟩ ⟨true, 1⟩ 2 = some ⟨true, 2⟩ := rfl

/-- Fixed: a row that is locked under the lock is never written. -/
theorem fixed_never_writes_locked (pre cur : Row) (new : Nat) (r : Row)
    (h : writeFixed pre cur new = some r) : cur.locked = false := by
  unfold writeFixed at h
  cases hp : pre.locked <;> cases hc : cur.locked <;> simp [hp, hc] at h ⊢

/-- Non-vacuity: an unlocked row is still updated. -/
theorem fixed_updates_unlocked : writeFixed ⟨false, 1⟩ ⟨false, 1⟩ 2 = some ⟨false, 2⟩ := rfl

end LearnAsync

/-! ## 8. Packs (packs.ts `computePackHash`, registry `addToRegistry`/`uninstallPack`)

The hash is `H(SKILL.md ‖ engrams.yaml)` for ANY hash oracle `H` — so it can only be
as injective as the unframed concatenation, which is not. A missing file hashes as an
empty one. The registry is keyed by manifest name; pack directories by source
basename. -/
namespace Packs

/-- `computePackHash` for an arbitrary hash oracle; `none` = file absent. -/
def packHash {δ : Type} (H : List UInt8 → δ) (skill eng : Option (List UInt8)) : δ :=
  H (skill.getD [] ++ eng.getD [])

/-- **Confirmed (replayed; NEEDS-OWNER — spec §5.5 defines this hash):** moving bytes
across the file boundary preserves the hash, for every oracle. -/
theorem hash_boundary_collision {δ : Type} (H : List UInt8 → δ) :
    packHash H (some [1, 2]) (some [3]) = packHash H (some [1]) (some [2, 3]) := rfl

theorem hash_missing_eq_empty {δ : Type} (H : List UInt8 → δ) (e : Option (List UInt8)) :
    packHash H none e = packHash H (some []) e := rfl

/-- Registry rows `(manifestName, integrity)`; `addToRegistry` replaces by name. -/
def addRow (reg : List (String × Nat)) (row : String × Nat) : List (String × Nat) :=
  if reg.any (fun r => r.1 == row.1) then reg.map (fun r => if r.1 == row.1 then row else r)
  else reg ++ [row]

def lookup (reg : List (String × Nat)) (name : String) : Option Nat :=
  (reg.find? (fun r => r.1 == name)).map (·.2)

/-- **Confirmed (replayed; NEEDS-OWNER):** two directories whose manifests share a
name share one row — the first pack's baseline is the second's hash, so the untouched
first pack reads `modified`. -/
theorem registry_shared_row :
    lookup (addRow (addRow [] ("shared-name", 1)) ("shared-name", 2)) "shared-name" = some 2 := by
  decide

end Packs

end PlurSpec.Persistence
