/-!
# WritePath — the Plur write path (packages/core/src/index.ts)

Models, branch for branch, the parts of the write path the WritePath cluster
covers. Each section names the code it mirrors. Payloads (statements, ids,
content scanners, config) are abstracted: theorems quantify over them.

Findings and replays: spec/formal/findings/writepath.md.
-/

namespace PlurSpec.WritePath

/-! ## 1. Outbox delivery protocol (core-index#1)

Code: `learn()` remote branch (fire-and-forget push, hand-off on success),
`flushOutbox()` / `_flushOutboxClaimed()` (snapshot, push, merge-back),
`forget()` (#766: strips `_outbox` on retirement), `rescope()` local route
(#848: drops `_outbox`).

### 1a. The merge-back of one queued row

A row is abstracted to the two facts the protocol reads: does it carry
`_outbox`, and is it retired. `stillQueued` is exactly flushOutbox's
selection predicate (`_outbox && status !== 'retired'`).

Checked against round 2 (2026-09-27): still holds because the merge-back (learn()'s
hand-off and the flush's fresh-row re-check through `Plur._stillQueued`), forget()'s
`_outbox` strip and rescope's local route are not in the round-2 diff of index.ts.
Round 2 touched the flush only to reload the config first (core-index#9) and made
`outboxCount` count `listOutbox()` (push AND retire entries); neither changes a merge.
Audit of #1228 (finding 1): the merge-back now checks `Plur._stillQueuedFor` (same
target store) — §1a'' models it; on the cancellations modelled here it coincides with
`stillQueued` (`retarget_agrees_on_cancel`), so these theorems are unchanged. -/

structure Row where
  queued  : Bool   -- carries structured_data._outbox
  retired : Bool
  deriving DecidableEq, Repr

def stillQueued (r : Row) : Bool := r.queued && !r.retired

/-- What may land on the row while the flush's POST is on the wire. -/
inductive Concurrent where
  | none
  | forget        -- forget(): status retired, `_outbox` stripped (#766)
  | rescopeLocal  -- rescope() local route: `_outbox` dropped (#848); retired rows refused
  deriving DecidableEq, Repr

def applyConc : Concurrent → Row → Row
  | .none, r => r
  | .forget, _ => { queued := false, retired := true }
  | .rescopeLocal, r => if r.retired then r else { r with queued := false }

/-- Merge-back BEFORE the fix (origin/main 6200dbf6).
`none` = the row is dropped from the store.
Success arm: `filter(e => !(considered && !survivor))` drops unconditionally.
Failure arm: copies the snapshot's `_outbox` (present) over the fresh row. -/
def mergeOld (snap fresh : Row) (pushOk : Bool) : Option Row :=
  if pushOk then none else some { fresh with queued := snap.queued }

/-- Merge-back AFTER the fix: both arms first re-check `stillQueued` on the
FRESH row; a cancelled delivery leaves the fresh row untouched. -/
def mergeNew (snap fresh : Row) (pushOk : Bool) : Option Row :=
  if stillQueued fresh then
    (if pushOk then none else some { fresh with queued := snap.queued })
  else some fresh

/-- One flush of a selected row, with a concurrent operation during the push. -/
def flushOne (merge : Row → Row → Bool → Option Row) (snap : Row) (c : Concurrent) (ok : Bool) :
    Option Row :=
  merge snap (applyConc c snap) ok

/-- The fixed merge honours every cancellation that lands during the push:
the resulting row is exactly what forget/rescope wrote (never erased, never
re-queued), whatever the push outcome. -/
theorem merge_honours_cancellation (snap : Row) (c : Concurrent) (ok : Bool)
    (hsel : stillQueued snap = true) (hc : c ≠ .none) :
    flushOne mergeNew snap c ok = some (applyConc c snap) := by
  cases snap with
  | mk q r =>
    simp [stillQueued] at hsel
    obtain ⟨hq, hr⟩ := hsel
    subst hq; subst hr
    cases c <;> cases ok <;> simp_all [flushOne, mergeNew, applyConc, stillQueued]

/-- A cancelled row never comes out queued (the #848 property). -/
theorem cancelled_never_requeued (snap : Row) (c : Concurrent) (ok : Bool)
    (hsel : stillQueued snap = true) (hc : c ≠ .none) :
    ∀ r, flushOne mergeNew snap c ok = some r → stillQueued r = false := by
  intro r h
  rw [merge_honours_cancellation snap c ok hsel hc] at h
  cases h
  cases snap with
  | mk q rt =>
    simp [stillQueued] at hsel
    obtain ⟨hq, hr⟩ := hsel
    subst hq; subst hr
    cases c <;> simp_all [applyConc, stillQueued]

/-- Non-vacuity: with no interference the fixed merge still hands off on
success and keeps the row queued on failure. -/
theorem merge_good_case :
    flushOne mergeNew ⟨true, false⟩ .none true = none ∧
    flushOne mergeNew ⟨true, false⟩ .none false = some ⟨true, false⟩ := by
  decide

/-- Counterexample (#766, replayed as test B): forget during a successful
push — the old merge DROPS the retirement record. -/
theorem old_success_erases_forget :
    flushOne mergeOld ⟨true, false⟩ .forget true = none := by decide

/-- Counterexample (#848, replayed as tests C and C2): a failed push
re-queues a row that a rescope or forget cancelled meanwhile. -/
theorem old_failure_requeues_cancelled :
    flushOne mergeOld ⟨true, false⟩ .rescopeLocal false = some ⟨true, false⟩ ∧
    flushOne mergeOld ⟨true, false⟩ .forget false = some ⟨true, true⟩ := by
  decide

/-! ### 1a'. Decision D1 "queue-retire" (2026-09-26)

When the push LANDED and the fresh row is no longer queued (forget/rescope
cancelled it during the push), the kept row now also carries a durable
"retire on remote" entry (`structured_data._retireRemote`, server id + target):
the second component below. Same code sites as `mergeNew` (learn()'s hand-off
and the flush merge-back filter).

Checked against round 2 (2026-09-27): still holds because `_queueRetireRemote` and the
flush's retire loop (DELETE; 2xx/404-410 finish, failure keeps the entry with one more
attempt) are unchanged; round 2 only made `listOutbox`/`outboxCount` (and MCP
plur_outbox) show these entries as `kind: 'retire'` (R2Integrations §3
`pending_counts_every_listed`). -/

def mergeD1 (snap fresh : Row) (pushOk : Bool) : Option (Row × Bool) :=
  if stillQueued fresh then
    (if pushOk then none else some ({ fresh with queued := snap.queued }, false))
  else some (fresh, pushOk)

def flushOneD1 (snap : Row) (c : Concurrent) (ok : Bool) : Option (Row × Bool) :=
  mergeD1 snap (applyConc c snap) ok

/-- D1: a cancellation during a push the remote accepted always leaves the
cancelled row AND a queued retirement; one the remote refused queues none. The
row part is exactly `mergeNew`'s (so `merge_honours_cancellation` carries over). -/
theorem cancel_during_landed_push_queues_retire (snap : Row) (c : Concurrent) (ok : Bool)
    (hsel : stillQueued snap = true) (hc : c ≠ .none) :
    flushOneD1 snap c ok = some (applyConc c snap, ok) := by
  cases snap with
  | mk q r =>
    simp [stillQueued] at hsel
    obtain ⟨hq, hr⟩ := hsel
    subst hq; subst hr
    cases c <;> cases ok <;> simp_all [flushOneD1, mergeD1, applyConc, stillQueued]

/-- D1 never queues a retirement for a delivery nobody cancelled (non-vacuity of
the good case: hand-off on success, still queued on failure, no retire). -/
theorem no_retire_without_cancel :
    flushOneD1 ⟨true, false⟩ .none true = none ∧
    flushOneD1 ⟨true, false⟩ .none false = some (⟨true, false⟩, false) := by decide

/-- The queued retirement, processed by flushOutbox: each attempt is a DELETE;
`removed`/`absent` (2xx / 404-410) finish it, `fail` keeps it with one more
attempt. State `none` = no entry (done). It never POSTs, so it cannot
resurrect the engram. -/
inductive DelOutcome where
  | removed | absent | fail
  deriving DecidableEq, Repr

/-- One flush: (entry after, DELETEs issued). -/
def retireStep : Option Nat → DelOutcome → Option Nat × Nat
  | none, _ => (none, 0)
  | some _, .removed => (none, 1)
  | some _, .absent => (none, 1)
  | some n, .fail => (some (n + 1), 1)

def retireRun : Option Nat → List DelOutcome → Option Nat × Nat
  | st, [] => (st, 0)
  | st, o :: os =>
    let (st', d) := retireStep st o
    let (st'', d') := retireRun st' os
    (st'', d + d')

/-- Idempotent: once done, no further flush issues a DELETE, whatever it would get. -/
theorem retire_done_is_final (os : List DelOutcome) : retireRun none os = (none, 0) := by
  induction os with
  | nil => rfl
  | cons o os ih => simp [retireRun, retireStep, ih]

/-- Retried until it lands: an entry facing failures then one success is done,
and every DELETE after that success is zero (at most one success counts). -/
theorem retire_retries_then_done (n k : Nat) (os : List DelOutcome) :
    (retireRun (some n) (List.replicate k .fail ++ .removed :: os)).1 = none := by
  induction k generalizing n with
  | zero => simp [retireRun, retireStep, retire_done_is_final]
  | succ k ih => simp [List.replicate_succ, retireRun, retireStep, ih]

/-! ### 1a''. Retarget during the push (audit of #1228, finding 1)

§1a abstracts `_outbox` to a Bool, so a D4 update (or a rescope to another
store) that RETARGETS the queue entry while the POST to the old store is on the
wire is invisible to it: the fresh row is still "queued". Here the entry carries
its target store (`Nat` = url + scope). Code: `Plur._stillQueuedFor` in learn()'s
hand-off and the flush merge-back filter, the survivor copy-back that no longer
re-points a retargeted row, and the flush gate that delivers a row owing a
`_retireRemote` only after that retire is done. -/

structure TRow where
  target  : Option Nat  -- `_outbox.target_url/target_scope`; none = not queued
  retired : Bool
  retire  : Bool        -- carries `_retireRemote` for a copy a remote accepted
  deriving DecidableEq, Repr

def tStillQueued (r : TRow) : Bool := r.target.isSome && !r.retired
def tStillQueuedFor (r : TRow) (t : Nat) : Bool := r.target == some t && !r.retired

inductive TConc where
  | none | forget | rescopeLocal
  | retarget (t : Nat)  -- D4 update / rescope to a scope with a writable url store
  deriving DecidableEq, Repr

def tApply : TConc → TRow → TRow
  | .none, r => r
  | .forget, r => { r with target := none, retired := true }
  | .rescopeLocal, r => if r.retired then r else { r with target := none }
  | .retarget t, r => if r.retired || r.target.isNone then r else { r with target := some t }

/-- Merge-back BEFORE (the #1228 branch): "still queued" without the target;
the failure arm copies the snapshot's entry back. -/
def tMergeOld (_t : Nat) (snap fresh : TRow) (ok : Bool) : Option TRow :=
  if tStillQueued fresh then
    (if ok then none else some { fresh with target := snap.target })
  else if ok then some { fresh with retire := true } else some fresh

/-- Merge-back AFTER: hand off / copy back only while the fresh entry still
names the store `t` the push went to; otherwise keep the fresh row and, when
the push landed, queue the retire of the accepted copy. -/
def tMergeNew (t : Nat) (snap fresh : TRow) (ok : Bool) : Option TRow :=
  if tStillQueuedFor fresh t then
    (if ok then none else some { fresh with target := snap.target })
  else if ok then some { fresh with retire := true } else some fresh

def tFlushOne (merge : Nat → TRow → TRow → Bool → Option TRow) (t : Nat) (snap : TRow)
    (c : TConc) (ok : Bool) : Option TRow :=
  merge t snap (tApply c snap) ok

/-- No loss: a row queued for `t` is dropped only if the push to `t` landed AND
the fresh row still wanted `t`; a kept row is exactly the fresh row (never
re-pointed at the old store), plus a queued retire iff the push landed. -/
theorem retarget_never_lost (t : Nat) (snap : TRow) (c : TConc) (ok : Bool)
    (hsel : tStillQueuedFor snap t = true) (hr : snap.retire = false) :
    (tFlushOne tMergeNew t snap c ok = none ↔ (ok = true ∧ (tApply c snap).target = some t)) ∧
    (∀ r, tFlushOne tMergeNew t snap c ok = some r →
      r.target = (tApply c snap).target ∧ r.retire = (ok && !tStillQueuedFor (tApply c snap) t)) := by
  obtain ⟨tg, rt, re⟩ := snap
  simp [tStillQueuedFor] at hsel hr
  obtain ⟨hq, hrt⟩ := hsel
  subst hq; subst hrt; subst hr
  cases c with
  | retarget t' =>
    by_cases h : t' = t
    · subst h; cases ok <;> simp [tFlushOne, tMergeNew, tApply, tStillQueuedFor]
    · cases ok <;> simp [tFlushOne, tMergeNew, tApply, tStillQueuedFor, h]
  | _ => cases ok <;> simp [tFlushOne, tMergeNew, tApply, tStillQueuedFor]

/-- The target-free cancellations of §1a behave exactly as before. -/
theorem retarget_agrees_on_cancel (t : Nat) (c : TConc) (ok : Bool)
    (hc : c = .forget ∨ c = .rescopeLocal ∨ c = .none) :
    tFlushOne tMergeNew t ⟨some t, false, false⟩ c ok = tFlushOne tMergeOld t ⟨some t, false, false⟩ c ok := by
  rcases hc with h | h | h <;> subst h <;> cases ok <;> simp [tFlushOne, tMergeNew, tMergeOld, tApply, tStillQueued, tStillQueuedFor]

/-- Counterexamples on the branch (replayed in formal-audit-core-retarget-inflight):
a landed push to store 0 after a retarget to store 1 DROPS the row (store 1
never receives it, no retire); a failed push re-points it at store 0. -/
theorem old_retarget_loses :
    tFlushOne tMergeOld 0 ⟨some 0, false, false⟩ (.retarget 1) true = none ∧
    tFlushOne tMergeOld 0 ⟨some 0, false, false⟩ (.retarget 1) false = some ⟨some 0, false, false⟩ := by
  decide

/-- Non-vacuity of the fix on the same interleavings. -/
theorem new_retarget_kept :
    tFlushOne tMergeNew 0 ⟨some 0, false, false⟩ (.retarget 1) true = some ⟨some 1, false, true⟩ ∧
    tFlushOne tMergeNew 0 ⟨some 0, false, false⟩ (.retarget 1) false = some ⟨some 1, false, false⟩ ∧
    tFlushOne tMergeNew 0 ⟨some 0, false, false⟩ .none true = none := by
  decide

/-- The flush gate: a row owing a retire is pushed only once that retire is
done in the same flush, so a hand-off (row dropped) never drops an owed retire. -/
def tFlushGated (t : Nat) (snap : TRow) (c : TConc) (retireDone ok : Bool) : Option TRow :=
  if snap.retire && !retireDone then some (tApply c snap)
  else tFlushOne tMergeNew t { snap with retire := false } c ok

theorem handoff_never_drops_owed_retire (t : Nat) (snap : TRow) (c : TConc) (retireDone ok : Bool)
    (h : tFlushGated t snap c retireDone ok = none) : snap.retire = false ∨ retireDone = true := by
  cases hs : snap.retire <;> cases retireDone <;> simp_all [tFlushGated]

/-! ### 1b. Two pushers, one row: at most one successful delivery (per process)

Scope: ONE process. `_outboxInFlight` is in-memory, so this section says
nothing about two processes flushing one store; that gap was a real
counterexample before decision D2 (`pre_lease_cross_process_double_delivery`)
and is closed by the on-disk lease, §1c (`leased_at_most_once_across_processes`).

Pushers: `L` = learn()'s fire-and-forget push (in flight from the moment the
row is written), `F` = a flushOutbox() that snapshots while L may be active.
`guarded` = the fix: F selects only rows not in `_outboxInFlight`, and claims
what it selects. A finished push that succeeds is one delivery to the remote
(the POST was on the wire whatever the local state) and hands the row off.

Checked against round 2 (2026-09-27): still holds because the `_outboxInFlight` claim
is unchanged (learn() adds before its push and deletes in `finally`; the flush selects
only unclaimed rows and claims them). The cross-process outbox lease (D2/F3) is NOT on
this branch, so the in-process scope of this theorem is still the whole guarantee. -/

inductive Pusher where
  | L | F
  deriving DecidableEq, Repr

structure PState where
  queued    : Bool
  activeL   : Bool
  activeF   : Bool
  delivered : Nat
  deriving DecidableEq, Repr

inductive Ev where
  | startF
  | finish (p : Pusher) (ok : Bool)
  deriving DecidableEq, Repr

def active (s : PState) : Pusher → Bool
  | .L => s.activeL
  | .F => s.activeF

def deactivate (s : PState) : Pusher → PState
  | .L => { s with activeL := false }
  | .F => { s with activeF := false }

def step (guarded : Bool) (s : PState) : Ev → PState
  | .startF =>
      if s.queued && !s.activeF && (!guarded || !s.activeL) then { s with activeF := true } else s
  | .finish p ok =>
      if active s p then
        let s' := deactivate s p
        if ok then { s' with queued := false, delivered := s.delivered + 1 } else s'
      else s

def run (guarded : Bool) (s : PState) (evs : List Ev) : PState := evs.foldl (step guarded) s

/-- learn() has just written the queued row and started its push. -/
def init : PState := { queued := true, activeL := true, activeF := false, delivered := 0 }

def Inv (s : PState) : Prop :=
  (s.activeL && s.activeF) = false ∧
  (s.queued = true → s.delivered = 0) ∧
  (s.queued = false → s.delivered = 1 ∧ s.activeL = false ∧ s.activeF = false)

theorem inv_init : Inv init := by simp [Inv, init]

theorem inv_step (s : PState) (e : Ev) (h : Inv s) : Inv (step true s e) := by
  obtain ⟨h1, h2, h3⟩ := h
  cases s with
  | mk q aL aF d =>
    cases e with
    | startF =>
      cases q <;> cases aL <;> cases aF <;> simp_all [step, Inv]
    | finish p ok =>
      cases p <;> cases ok <;> cases q <;> cases aL <;> cases aF <;>
        simp_all [step, Inv, active, deactivate]

theorem inv_run (s : PState) (evs : List Ev) (h : Inv s) : Inv (run true s evs) := by
  induction evs generalizing s with
  | nil => simpa [run] using h
  | cons e es ih =>
    simp only [run, List.foldl_cons]
    exact ih _ (inv_step s e h)

/-- With the in-flight claim, every interleaving of learn()'s push and a
flush IN ONE PROCESS delivers the engram to the remote at most once. Across
processes see §1c. -/
theorem guarded_at_most_once (evs : List Ev) : (run true init evs).delivered ≤ 1 := by
  have h := inv_run init evs inv_init
  obtain ⟨_, h2, h3⟩ := h
  cases hq : (run true init evs).queued
  · have := (h3 hq).1; omega
  · have := h2 hq; omega

/-- Non-vacuity: the guarded protocol does deliver, and a failed first push is
still retried by the flush. -/
theorem guarded_delivers :
    (run true init [.finish .L true]).delivered = 1 ∧
    (run true init [.finish .L false, .startF, .finish .F true]).delivered = 1 := by
  decide

/-- Counterexample (replayed as test A): without the claim, a flush started
while learn()'s push is in flight POSTs the engram a second time. -/
theorem unguarded_double_delivery :
    (run false init [.startF, .finish .L true, .finish .F true]).delivered = 2 := by
  decide

/-! ### 1c. Decision D2: an on-disk lease — at most once ACROSS processes

`guarded_at_most_once` (§1b) is per process: `_outboxInFlight` is an in-memory
set. Two processes flushing one store (an MCP server and a CLI hook) share only
the store file, so before the lease both selected the same queued row and both
POSTed it (`pre_lease_cross_process_double_delivery`, replayed in
`formal-outbox-lease.test.ts`).

Code (`outbox-lease.ts`, `_flushOutboxClaimed`, learn()'s remote branch):
- `take p lag` — under the store lock, p reads the clock and selects the row
  only when it is queued and `leaseFree`: unleased, its own lease, an expired
  one, or one further out than `T + M` (no live holder with a sane clock can
  have written it — the far-future clause), and records
  `_outboxLease = (p, reading + T)`. learn() writes the row born leased.
  `fresh` is the code after the audit of #1231 (finding 1): the clock is read
  INSIDE the lock, after the load, so the reading is `now`. Without it the
  reading was taken before waiting for the lock, `lag` earlier.
- `start p` — the network call, only while `now + M ≤ until` (`canStartPush`).
- `respond p ok` — the remote answers. Accepted: one delivery, and p now owes
  the hand-off. Failed: p holds its lease again, to retry or release.
- `merge p` — the merge-back, under the store lock: the accepted row is handed
  off and p's own lease dropped (`dropLease`). A step of its own since the
  audit of #1231 (finding 2): the merge-back waits for the store lock after the
  POST, once per batch, and before that audit the model made the two one atomic
  `finish`, which the code never was.
- `abandon p` — a held row not pushed after all (lease ran short, breaker
  opened mid-batch, a failed push): its lease is released in the merge-back.
- `crash p` — the process dies; its lease stays on disk until it expires. A
  holder that dies owing a hand-off is `lost`.
- `tick d` — time passes. A push unanswered `R` after it started has failed
  (requests are bounded: 30 s). A hand-off not merged back `R + W` after its
  push started has failed too — `W` bounds the wait for the store lock (the file
  lock's acquire timeout, 180 s: the waiter gives up) plus the write — and that
  holder is `lost`.

The code picks `M = R + W + skew` (30 + 180 + 30 + 60 s). The guarantee
(`leased_at_most_once_across_processes`): with fresh clock readings and
`R + W ≤ M`, for any number of processes and every interleaving, the remote
receives the engram at most once in every run in which no holder is lost. The
three hypotheses are each necessary: `stale_clock_double_delivery` (finding 1),
`short_margin_double_delivery` (finding 2: the pre-audit margin, 2 min, did not
cover the lock wait), and `lost_handoff_double_delivery` — a holder killed, or
timed out on the store lock, after the remote accepted and before its
merge-back re-delivers once the lease expires: the documented at-least-once
edge the single-process path always had. Retire DELETEs (`_retireRemote`) use
the same lease and selection, so `delivered` stands for either network effect.
Assumption: one clock (skew within the margin, see `outbox-lease.ts`).

What `P` stands for (review of #1231, 2026-09-28): `P` ranges over PUSHES, one
lease each, not over `Plur` instances. One instance can run two pushes of the
same row one after the other (`learn()`'s immediate push, then a flush's
retry), and the code tells their leases apart by a per-lease `nonce`:
`dropLease` removes a lease only when holder, nonce and expiry all match the
lease that push wrote. That is `dropOwn` below with `p` a push. Matching by
holder id alone, as the code did before that review, is `dropOwn` with `p` an
instance, and it let a failed push release the lease of a later push by the
same instance, so another process delivered the row twice. In the code,
`leaseFree` still treats the instance's own lease as free. Two pushes by one
instance are kept apart by the in-process claim (`_outboxInFlight`), which a
push now holds from writing its lease until it has released it. Together, the
claim and the per-lease release give the per-push `leaseFree` this model
checks. The model text changed with that review, and no definition or proof
did; `lake build` was not re-run for the change. -/

inductive Phase where
  | idle
  | leased (expiry : Nat)
  | pushing (start expiry : Nat)
  | handing (start expiry : Nat)
  | lost
  deriving DecidableEq, Repr

structure LState (P : Type) where
  now       : Nat
  queued    : Bool
  lease     : Option (P × Nat)
  phase     : P → Phase
  delivered : Nat

inductive LEv (P : Type) where
  | take (p : P) (lag : Nat)
  | start (p : P)
  | respond (p : P) (ok : Bool)
  | merge (p : P)
  | abandon (p : P)
  | crash (p : P)
  | tick (d : Nat)

/-- `leased = false`: the pre-lease code. `fresh = false`: the clock read before
the lock wait (pre-#1231-audit). `T` TTL, `M` margin, `R` request bound, `W`
merge-back bound (store-lock wait + write). -/
structure LCfg where
  leased : Bool
  fresh  : Bool
  T : Nat
  M : Nat
  R : Nat
  W : Nat
  deriving DecidableEq, Repr

section Lease
variable {P : Type} [DecidableEq P]

def upd (f : P → Phase) (p : P) (v : Phase) : P → Phase := fun q => if q = p then v else f q

/-- `leaseFree` in `outbox-lease.ts`, far-future clause included. -/
def leaseFree (c : LCfg) (l : Option (P × Nat)) (p : P) (now : Nat) : Bool :=
  !c.leased || match l with
    | none => true
    | some (q, e) => decide (q = p) || decide (e ≤ now) || decide (now + c.T + c.M < e)

/-- `dropLease`: only the push's own lease is released (`p` is a push — see §1c). -/
def dropOwn (l : Option (P × Nat)) (p : P) : Option (P × Nat) :=
  match l with
  | some (q, e) => if q = p then none else some (q, e)
  | none => none

/-- The clock reading `take` works from. -/
def reading (c : LCfg) (now lag : Nat) : Nat := if c.fresh then now else now - lag

def lstep (c : LCfg) (s : LState P) : LEv P → LState P
  | .take p lag =>
      if s.phase p = .idle ∧ s.queued = true ∧ leaseFree c s.lease p (reading c s.now lag) = true then
        { s with lease := some (p, reading c s.now lag + c.T),
                 phase := upd s.phase p (.leased (reading c s.now lag + c.T)) }
      else s
  | .start p =>
      match s.phase p with
      | .leased u => if s.now + c.M ≤ u then { s with phase := upd s.phase p (.pushing s.now u) } else s
      | _ => s
  | .respond p ok =>
      match s.phase p with
      | .pushing st u =>
          if ok then { s with phase := upd s.phase p (.handing st u), delivered := s.delivered + 1 }
          else { s with phase := upd s.phase p (.leased u) }
      | _ => s
  | .merge p =>
      match s.phase p with
      | .handing _ _ => { s with phase := upd s.phase p .idle, lease := dropOwn s.lease p, queued := false }
      | _ => s
  | .abandon p =>
      match s.phase p with
      | .leased _ => { s with phase := upd s.phase p .idle, lease := dropOwn s.lease p }
      | _ => s
  | .crash p =>
      match s.phase p with
      | .handing _ _ => { s with phase := upd s.phase p .lost }
      | .lost => s
      | _ => { s with phase := upd s.phase p .idle }
  | .tick d =>
      { s with now := s.now + d,
               phase := fun q => match s.phase q with
                 | .pushing st u => if s.now + d < st + c.R then .pushing st u else .leased u
                 | .handing st u => if s.now + d < st + c.R + c.W then .handing st u else .lost
                 | ph => ph }

def lrun (c : LCfg) (s : LState P) (evs : List (LEv P)) : LState P :=
  evs.foldl (lstep c) s

/-- A queued row, nobody holding it, at time 0. -/
def linit : LState P := { now := 0, queued := true, lease := none, phase := fun _ => .idle, delivered := 0 }

/-- No holder has lost a hand-off (died, or gave up on the store lock, owing one). -/
def NoLost (s : LState P) : Prop := ∀ p, s.phase p ≠ .lost

omit [DecidableEq P] in
theorem nolost_init : NoLost (linit : LState P) := by
  intro p; simp [linit]

/-- Lost is final: a lost holder never acts again. -/
theorem lost_persists (c : LCfg) (s : LState P) (e : LEv P) (q : P) (h : s.phase q = .lost) :
    (lstep c s e).phase q = .lost := by
  cases e with
  | take p lag =>
    simp only [lstep]; split
    · rename_i hg; simp only [upd]; by_cases hqp : q = p
      · subst hqp; rw [h] at hg; simp at hg
      · simp [hqp, h]
    · exact h
  | start p =>
    simp only [lstep]; split
    · split
      · simp only [upd]; by_cases hqp : q = p
        · subst hqp; simp_all
        · simp [hqp, h]
      · exact h
    · exact h
  | respond p ok =>
    simp only [lstep]; split
    · split
      · simp only [upd]; by_cases hqp : q = p
        · subst hqp; simp_all
        · simp [hqp, h]
      · simp only [upd]; by_cases hqp : q = p
        · subst hqp; simp_all
        · simp [hqp, h]
    · exact h
  | merge p =>
    simp only [lstep]; split
    · simp only [upd]; by_cases hqp : q = p
      · subst hqp; simp_all
      · simp [hqp, h]
    · exact h
  | abandon p =>
    simp only [lstep]; split
    · simp only [upd]; by_cases hqp : q = p
      · subst hqp; simp_all
      · simp [hqp, h]
    · exact h
  | crash p =>
    simp only [lstep]; split
    · simp only [upd]; by_cases hqp : q = p
      · subst hqp; simp_all
      · simp [hqp, h]
    · exact h
    · simp only [upd]; by_cases hqp : q = p
      · subst hqp; simp_all
      · simp [hqp, h]
  | tick d => simp [lstep, h]

theorem nolost_back (c : LCfg) (s : LState P) (e : LEv P) (h : NoLost (lstep c s e)) : NoLost s :=
  fun q hq => h q (lost_persists c s e q hq)

/-- The invariant, on every run in which no hand-off was lost. -/
def LCore (c : LCfg) (s : LState P) : Prop :=
  (s.lease.isSome = true → s.queued = true) ∧
  (s.queued = false → s.delivered = 1) ∧
  (s.delivered ≤ 1) ∧
  (s.queued = true → s.delivered = 1 → ∃ q st u, s.phase q = .handing st u) ∧
  (∀ p u, s.phase p = .leased u → s.lease = some (p, u) ∨ u ≤ s.now) ∧
  (∀ p st u, s.phase p = .pushing st u →
      s.lease = some (p, u) ∧ st + c.M ≤ u ∧ s.now < st + c.R ∧ s.delivered = 0) ∧
  (∀ p st u, s.phase p = .handing st u →
      s.lease = some (p, u) ∧ st + c.M ≤ u ∧ s.now < st + c.R + c.W ∧ s.delivered = 1 ∧ s.queued = true) ∧
  (∀ q e, s.lease = some (q, e) → e ≤ s.now + c.T)

def LInv (c : LCfg) (s : LState P) : Prop := NoLost s → LCore c s

omit [DecidableEq P] in
theorem linv_init (c : LCfg) : LInv c (linit : LState P) := by
  intro _
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp [linit]

omit [DecidableEq P] in
/-- Nobody else holds a live push or hand-off: the one lease names its holder. -/
theorem holder_unique {s : LState P} {p q : P} {u v : Nat}
    (hp : s.lease = some (p, u)) (hq : s.lease = some (q, v)) : p = q := by
  rw [hp] at hq; cases hq; rfl

/-- Under the protocol's hypotheses — the lease is honoured, clocks are read in
the lock, and the margin covers a request plus the merge-back — the invariant
is preserved by every step. -/
theorem linv_step (c : LCfg) (hL : c.leased = true) (hF : c.fresh = true)
    (hR : 0 < c.R) (hRW : c.R + c.W ≤ c.M) (s : LState P) (e : LEv P) (h : LInv c s) :
    LInv c (lstep c s e) := by
  intro hNL'
  have hNL := nolost_back c s e hNL'
  obtain ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩ := h hNL
  cases e with
  | take p lag =>
    simp only [lstep]
    split
    · rename_i hg
      obtain ⟨hidle, hq, hfree⟩ := hg
      simp only [reading, hF, ite_true] at hfree ⊢
      -- the lease blocks unless it is ours (impossible: p idle), expired, or bogus
      have hblk : ∀ q e, s.lease = some (q, e) → q ≠ p → e ≤ s.now := by
        intro q e hl hqp
        rw [hl] at hfree
        simp [leaseFree, hL, hqp] at hfree
        have := hT q e hl
        omega
      -- nobody is pushing or handing: they would hold a live lease
      have hnoH : ∀ q st u, s.phase q ≠ .handing st u := by
        intro q st u hqa
        obtain ⟨h1, h2, h3, _⟩ := hHa q st u hqa
        have hqp : q ≠ p := by intro hh; subst hh; rw [hidle] at hqa; cases hqa
        have := hblk q u h1 hqp; omega
      have hnoP : ∀ q st u, s.phase q ≠ .pushing st u := by
        intro q st u hqa
        obtain ⟨h1, h2, h3, _⟩ := hPu q st u hqa
        have hqp : q ≠ p := by intro hh; subst hh; rw [hidle] at hqa; cases hqa
        have := hblk q u h1 hqp; omega
      have hd0 : s.delivered = 0 := by
        rcases Nat.lt_or_ge s.delivered 1 with h1 | h1
        · omega
        · obtain ⟨q, st, u, hqa⟩ := hH hq (by omega); exact absurd hqa (hnoH q st u)
      refine ⟨fun _ => hq, fun h => by simp_all, by simp [hd0], fun _ h1 => by simp [hd0] at h1, ?_, ?_, ?_, ?_⟩
      · intro q u hqu
        simp only [upd] at hqu
        by_cases hqp : q = p
        · subst hqp; simp at hqu; subst hqu; left; rfl
        · simp [hqp] at hqu
          rcases hLe q u hqu with h1 | h1
          · right; exact hblk q u h1 hqp
          · right; exact h1
      · intro q st u hqu
        simp only [upd] at hqu
        by_cases hqp : q = p
        · subst hqp; simp at hqu
        · simp [hqp] at hqu; exact absurd hqu (hnoP q st u)
      · intro q st u hqu
        simp only [upd] at hqu
        by_cases hqp : q = p
        · subst hqp; simp at hqu
        · simp [hqp] at hqu; exact absurd hqu (hnoH q st u)
      · intro q e hl
        simp at hl; obtain ⟨_, h2⟩ := hl; subst h2; simp
    · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
  | start p =>
    simp only [lstep]
    split
    · rename_i u hpu
      split
      · rename_i hle
        have hlp : s.lease = some (p, u) := by
          rcases hLe p u hpu with h1 | h1
          · exact h1
          · omega
        have hq : s.queued = true := hLq (by simp [hlp])
        have hd0 : s.delivered = 0 := by
          rcases Nat.lt_or_ge s.delivered 1 with h1 | h1
          · omega
          · obtain ⟨q, st, v, hqa⟩ := hH hq (by omega)
            have := holder_unique hlp (hHa q st v hqa).1
            subst this; rw [hpu] at hqa; cases hqa
        refine ⟨hLq, hQ, hD, ?_, ?_, ?_, ?_, hT⟩
        · intro _ h1; dsimp only at h1; omega
        · intro q v hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv
          · simp [hqp] at hqv; exact hLe q v hqv
        · intro q st v hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv; obtain ⟨h1, h2⟩ := hqv; subst h1; subst h2
            exact ⟨hlp, hle, by dsimp only; omega, hd0⟩
          · simp [hqp] at hqv; exact hPu q st v hqv
        · intro q st v hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv
          · simp [hqp] at hqv; exact hHa q st v hqv
      · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
    · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
  | respond p ok =>
    simp only [lstep]
    split
    · rename_i st u hpu
      obtain ⟨hlp, hm, hn, hd0⟩ := hPu p st u hpu
      have hq : s.queued = true := hLq (by simp [hlp])
      -- another pusher or hander would hold the same lease
      have hothers : ∀ q, q ≠ p → (∀ a b, s.phase q ≠ .pushing a b) ∧ (∀ a b, s.phase q ≠ .handing a b) := by
        intro q hqp
        refine ⟨fun a b hqa => hqp ?_, fun a b hqa => hqp ?_⟩
        · exact (holder_unique (hPu q a b hqa).1 hlp)
        · exact (holder_unique (hHa q a b hqa).1 hlp)
      cases ok
      · simp only [Bool.false_eq_true, ite_false]
        refine ⟨hLq, hQ, hD, ?_, ?_, ?_, ?_, hT⟩
        · intro _ h1; dsimp only at h1; omega
        · intro q v hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv; subst hqv; left; exact hlp
          · simp [hqp] at hqv; exact hLe q v hqv
        · intro q a b hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv
          · simp [hqp] at hqv; exact absurd hqv ((hothers q hqp).1 a b)
        · intro q a b hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv
          · simp [hqp] at hqv; exact absurd hqv ((hothers q hqp).2 a b)
      · simp only [ite_true]
        refine ⟨hLq, fun h1 => by simp [hq] at h1, by simp; omega, ?_, ?_, ?_, ?_, hT⟩
        · intro _ _; exact ⟨p, st, u, by simp [upd]⟩
        · intro q v hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv
          · simp [hqp] at hqv; exact hLe q v hqv
        · intro q a b hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv
          · simp [hqp] at hqv; exact absurd hqv ((hothers q hqp).1 a b)
        · intro q a b hqv
          simp only [upd] at hqv
          by_cases hqp : q = p
          · subst hqp; simp at hqv; obtain ⟨h1, h2⟩ := hqv; subst h1; subst h2
            exact ⟨hlp, hm, by dsimp only; omega, by simp [hd0], hq⟩
          · simp [hqp] at hqv; exact absurd hqv ((hothers q hqp).2 a b)
    · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
  | merge p =>
    simp only [lstep]
    split
    · rename_i st u hpu
      obtain ⟨hlp, _, _, hd1, hq⟩ := hHa p st u hpu
      have hdrop : dropOwn s.lease p = none := by simp [hlp, dropOwn]
      have hothers : ∀ q, q ≠ p → (∀ a b, s.phase q ≠ .pushing a b) ∧ (∀ a b, s.phase q ≠ .handing a b) := by
        intro q hqp
        refine ⟨fun a b hqa => hqp ?_, fun a b hqa => hqp ?_⟩
        · exact (holder_unique (hPu q a b hqa).1 hlp)
        · exact (holder_unique (hHa q a b hqa).1 hlp)
      refine ⟨by simp [hdrop], fun _ => hd1, hD, fun h1 => by simp at h1, ?_, ?_, ?_, by simp [hdrop]⟩
      · intro q v hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv
          rcases hLe q v hqv with h1 | h1
          · rw [hlp] at h1; cases h1; exact absurd rfl hqp
          · right; exact h1
      · intro q a b hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv; exact absurd hqv ((hothers q hqp).1 a b)
      · intro q a b hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv; exact absurd hqv ((hothers q hqp).2 a b)
    · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
  | abandon p =>
    simp only [lstep]
    split
    · rename_i u hpu
      have hkeep : ∀ q v, q ≠ p → s.lease = some (q, v) → dropOwn s.lease p = some (q, v) := by
        intro q v hqp hl; simp [hl, dropOwn, hqp]
      refine ⟨?_, hQ, hD, ?_, ?_, ?_, ?_, ?_⟩
      · intro hs; apply hLq
        cases hl : s.lease with
        | none => simp [hl, dropOwn] at hs
        | some x => rfl
      · intro hq h1
        obtain ⟨q, st, v, hqa⟩ := hH hq h1
        refine ⟨q, st, v, ?_⟩
        have hqp : q ≠ p := by intro hh; subst hh; rw [hpu] at hqa; cases hqa
        simp [upd, hqp, hqa]
      · intro q v hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv
          rcases hLe q v hqv with h1 | h1
          · left; exact hkeep q v hqp h1
          · right; exact h1
      · intro q a b hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv
          obtain ⟨h1, h2, h3, h4⟩ := hPu q a b hqv
          exact ⟨hkeep q b hqp h1, h2, h3, h4⟩
      · intro q a b hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv
          obtain ⟨h1, h2, h3, h4, h5⟩ := hHa q a b hqv
          exact ⟨hkeep q b hqp h1, h2, h3, h4, h5⟩
      · intro q v hl
        cases hl0 : s.lease with
        | none => simp [hl0, dropOwn] at hl
        | some x =>
          obtain ⟨r, w⟩ := x
          rw [hl0] at hl
          simp only [dropOwn] at hl
          split at hl
          · simp at hl
          · exact hT q v (by rw [hl0]; exact hl)
    · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
  | crash p =>
    simp only [lstep]
    split
    · -- crashed owing a hand-off: lost, excluded by `hNL'`
      rename_i st u hpu
      exact absurd (by simp [lstep, hpu, upd]) (hNL' p)
    · exact ⟨hLq, hQ, hD, hH, hLe, hPu, hHa, hT⟩
    · rename_i hnh hnl
      refine ⟨hLq, hQ, hD, ?_, ?_, ?_, ?_, hT⟩
      · intro hq h1
        obtain ⟨q, st, v, hqa⟩ := hH hq h1
        have hqp : q ≠ p := by intro hh; subst hh; exact hnh st v hqa
        exact ⟨q, st, v, by simp [upd, hqp, hqa]⟩
      · intro q v hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv; exact hLe q v hqv
      · intro q a b hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv; exact hPu q a b hqv
      · intro q a b hqv
        simp only [upd] at hqv
        by_cases hqp : q = p
        · subst hqp; simp at hqv
        · simp [hqp] at hqv; exact hHa q a b hqv
  | tick d =>
    simp only [lstep]
    refine ⟨hLq, hQ, hD, ?_, ?_, ?_, ?_, ?_⟩
    · intro hq h1
      obtain ⟨q, st, v, hqa⟩ := hH hq h1
      refine ⟨q, st, v, ?_⟩
      by_cases hlt : s.now + d < st + c.R + c.W
      · simp [hqa, hlt]
      · exact absurd (by simp [lstep, hqa, hlt]) (hNL' q)
    · intro q v hqv
      simp only at hqv
      split at hqv
      · rename_i st u hpu
        split at hqv
        · simp at hqv
        · simp at hqv; subst hqv
          left; exact (hPu q st u hpu).1
      · rename_i st u hpu
        split at hqv <;> simp at hqv
      · rename_i hnp hnh
        rcases hLe q v hqv with h1 | h1
        · left; exact h1
        · right; simp; omega
    · intro q st v hqv
      simp only at hqv
      split at hqv
      · rename_i st' u hpu
        split at hqv
        · rename_i hlt
          simp at hqv; obtain ⟨h1, h2⟩ := hqv; subst h1; subst h2
          obtain ⟨h1, h2, _, h4⟩ := hPu q st' u hpu
          exact ⟨h1, h2, by simp; omega, h4⟩
        · simp at hqv
      · rename_i st' u hpu
        split at hqv <;> simp at hqv
      · simp_all
    · intro q st v hqv
      simp only at hqv
      split at hqv
      · rename_i st' u hpu
        split at hqv <;> simp at hqv
      · rename_i st' u hpu
        split at hqv
        · rename_i hlt
          simp at hqv; obtain ⟨h1, h2⟩ := hqv; subst h1; subst h2
          obtain ⟨h1, h2, _, h4, h5⟩ := hHa q st' u hpu
          exact ⟨h1, h2, by simp; omega, h4, h5⟩
        · simp at hqv
      · simp_all
    · intro q v hl
      have := hT q v hl; simp; omega

theorem linv_run (c : LCfg) (hL : c.leased = true) (hF : c.fresh = true)
    (hR : 0 < c.R) (hRW : c.R + c.W ≤ c.M) (s : LState P) (evs : List (LEv P)) (h : LInv c s) :
    LInv c (lrun c s evs) := by
  induction evs generalizing s with
  | nil => simpa [lrun] using h
  | cons e es ih =>
    simp only [lrun, List.foldl_cons]
    exact ih _ (linv_step c hL hF hR hRW s e h)

/-- Decision D2 with the audit of #1231 applied: the lease honoured, the clock
read inside the store lock, and a margin covering a request plus the merge-back
(`R + W ≤ M`). Then for ANY number of processes, any lease length `T`, and
EVERY interleaving of takes, pushes, answers, merge-backs, abandons, crashes and
clock ticks in which no holder lost a hand-off, the remote receives the engram
at most once. -/
theorem leased_at_most_once_across_processes (c : LCfg) (hL : c.leased = true) (hF : c.fresh = true)
    (hR : 0 < c.R) (hRW : c.R + c.W ≤ c.M) (evs : List (LEv P))
    (hNL : NoLost (lrun c (linit : LState P) evs)) :
    (lrun c (linit : LState P) evs).delivered ≤ 1 :=
  (linv_run c hL hF hR hRW linit evs (linv_init c) hNL).2.2.1

/-- A live foreign lease is honoured: while `q` holds an unexpired lease no
further out than a live holder can write, `take` by anyone else changes nothing. -/
theorem live_foreign_lease_blocks (c : LCfg) (hL : c.leased = true) (hF : c.fresh = true)
    (s : LState P) (p q : P) (e lag : Nat)
    (hpq : p ≠ q) (hl : s.lease = some (q, e)) (hlive : s.now < e) (hsane : e ≤ s.now + c.T + c.M) :
    lstep c s (.take p lag) = s := by
  have : leaseFree c s.lease p (reading c s.now lag) = false := by
    simp [leaseFree, reading, hL, hF, hl, Ne.symm hpq]; omega
  simp [lstep, this]

/-- The far-future clause: a lease further out than any live holder with a sane
clock can write does not park the row. -/
theorem far_future_lease_ignored (c : LCfg) (hF : c.fresh = true) (s : LState P) (p q : P) (e lag : Nat)
    (hq : s.queued = true) (hidle : s.phase p = .idle) (hl : s.lease = some (q, e))
    (hfar : s.now + c.T + c.M < e) :
    (lstep c s (.take p lag)).lease = some (p, s.now + c.T) := by
  have : leaseFree c s.lease p s.now = true := by
    simp [leaseFree, hl]; omega
  simp [lstep, hidle, hq, this, reading, hF]

/-- A crashed holder does not block forever: once its lease has expired, an
idle process takes the queued row. -/
theorem expired_lease_taken_over (c : LCfg) (hF : c.fresh = true) (s : LState P) (p q : P) (e lag : Nat)
    (hq : s.queued = true) (hidle : s.phase p = .idle) (hl : s.lease = some (q, e)) (hexp : e ≤ s.now) :
    (lstep c s (.take p lag)).lease = some (p, s.now + c.T) ∧
    (lstep c s (.take p lag)).phase p = .leased (s.now + c.T) := by
  have : leaseFree c s.lease p s.now = true := by simp [leaseFree, hl, hexp]
  simp [lstep, hidle, hq, this, upd, reading, hF]

/-- The lease is released on merge-back: after `merge` (success) or `abandon`
(not pushed, or a failed push), the holder holds no lease on the row. -/
theorem merge_releases_lease (c : LCfg) (s : LState P) (h : LCore c s) (p : P)
    (a b : Nat) (hpu : s.phase p = .handing a b) :
    (lstep c s (.merge p)).lease = none := by
  have hlp := (h.2.2.2.2.2.2.1 p a b hpu).1
  simp [lstep, hpu, hlp, dropOwn]

theorem abandon_releases_lease (c : LCfg) (s : LState P) (p : P) (u : Nat)
    (hpu : s.phase p = .leased u) (hlp : s.lease = some (p, u)) :
    (lstep c s (.abandon p)).lease = none := by
  simp [lstep, hpu, hlp, dropOwn]

/-- The protocol as shipped after the audit of #1231, in small numbers
(`T = 10`, `M = 4`, `R = 1`, `W = 2`). -/
def cfgFixed : LCfg := { leased := true, fresh := true, T := 10, M := 4, R := 1, W := 2 }

/-- Non-vacuity: the leased protocol delivers; a holder that crashed before
pushing is taken over after its lease expires and the row is delivered once; a
failed push is retried by another process after its lease is released. -/
theorem leased_delivers :
    (lrun cfgFixed (linit : LState Bool) [.take true 0, .start true, .respond true true, .merge true]).delivered = 1 ∧
    (lrun cfgFixed (linit : LState Bool)
      [.take true 0, .crash true, .take false 0, .tick 10, .take false 0, .start false,
       .respond false true, .merge false]).delivered = 1 ∧
    (lrun cfgFixed (linit : LState Bool)
      [.take true 0, .start true, .respond true false, .abandon true, .take false 0, .start false,
       .respond false true, .merge false]).delivered = 1 := by
  decide

/-- Counterexample on the PRE-LEASE code (the cross-process gap left open by
`guarded_at_most_once`, replayed as the first test of
`formal-outbox-lease.test.ts`): two processes each select the row and each POST it. -/
theorem pre_lease_cross_process_double_delivery :
    (lrun { cfgFixed with leased := false } (linit : LState Bool)
      [.take true 0, .take false 0, .start true, .start false, .respond true true,
       .respond false true]).delivered = 2 := by
  decide

/-- Audit of #1231, finding 1 (replayed in `formal-outbox-lease.test.ts`): a
clock read BEFORE waiting for the store lock. `false` read the clock at 0 and
waited; meanwhile `true` took the row at 5 and is pushing it. To the stale
reading, `true`'s live lease looks more than `T + M` away — the far-future
clause frees it — and both deliver. No holder is lost. -/
theorem stale_clock_double_delivery :
    let s := lrun { cfgFixed with fresh := false } (linit : LState Bool)
      [.tick 5, .take true 0, .start true, .take false 5, .start false,
       .respond true true, .respond false true]
    s.delivered = 2 ∧ s.phase true ≠ .lost ∧ s.phase false ≠ .lost := by
  decide

/-- Audit of #1231, finding 2 (replayed in `formal-outbox-lease.test.ts`): the
pre-audit margin (2 min) covered the request but not the wait for the store
lock (`M < R + W`). The last push starts as late as the margin allows, the
remote accepts, the merge-back waits for the lock past the lease's end, and
another process takes the row and delivers it again — though nobody crashed
and no wait exceeded its bound. -/
theorem short_margin_double_delivery :
    let s := lrun { cfgFixed with M := 2, R := 1, W := 3 } (linit : LState Bool)
      [.take true 0, .tick 8, .start true, .respond true true, .tick 2,
       .take false 0, .start false, .respond false true]
    s.delivered = 2 ∧ s.phase true ≠ .lost ∧ s.phase false ≠ .lost := by
  decide

/-- The documented at-least-once edge, which `NoLost` excludes: the remote
accepted, then the holder died (or gave up on the store lock) before its
merge-back. Its lease expires and another process delivers the row again. -/
theorem lost_handoff_double_delivery :
    let s := lrun cfgFixed (linit : LState Bool)
      [.take true 0, .start true, .respond true true, .crash true, .tick 10,
       .take false 0, .start false, .respond false true]
    s.delivered = 2 ∧ s.phase true = .lost := by
  decide

end Lease

/-! ## 2. Invariant `_outbox ⇒ scope = _outbox.target_scope` (core-index#3)

Code: `updateEngram()` local branch (writes the caller's row, `scope`
included, leaves `_outbox`), `applyMutation` in cross-scope recurrence
(`isSharedScope(e.scope) ⇒ e.scope := 'global'`), `rescope()` local route
(drops `_outbox`), and the flush push (POST body `scope: engram.scope` to the
store of `_outbox.target_scope`). Scopes are an abstract type.

Checked against round 2 (2026-09-27): still holds because the flush's scope/target
hold-back (`engram.scope !== outbox.target_scope` → NOT pushed) is unchanged. -/

structure QRow (Scope : Type) where
  scope  : Scope
  target : Option Scope   -- `_outbox.target_scope`, none = not queued

inductive ScopeOp (Scope : Type) where
  | update (s : Scope)          -- updateEngram with a caller-chosen scope
  | broaden (g : Scope)         -- cross-scope recurrence: scope := 'global'
  | rescopeLocal (s : Scope)    -- rescope local route: scope := s, `_outbox` dropped

def applyScopeOp {Scope : Type} : ScopeOp Scope → QRow Scope → QRow Scope
  | .update s, r => { r with scope := s }
  | .broaden g, r => { r with scope := g }
  | .rescopeLocal s, _ => { scope := s, target := none }

/-- A delivery: (store scope it is sent to, scope field in the POST body). -/
def flushDeliverOld {Scope : Type} (r : QRow Scope) : Option (Scope × Scope) :=
  r.target.map fun t => (t, r.scope)

/-- Fixed flush: hold back a row whose scope differs from its target. -/
def flushDeliverNew {Scope : Type} [DecidableEq Scope] (r : QRow Scope) : Option (Scope × Scope) :=
  match r.target with
  | none => none
  | some t => if r.scope = t then some (t, r.scope) else none

/-- Every delivery the fixed flush makes carries the scope of the store it is
sent to — whatever sequence of scope writes happened since queue-time. -/
theorem deliver_scope_matches_store {Scope : Type} [DecidableEq Scope]
    (r0 : QRow Scope) (ops : List (ScopeOp Scope)) (t b : Scope) :
    flushDeliverNew (ops.foldl (fun r o => applyScopeOp o r) r0) = some (t, b) → b = t := by
  generalize ops.foldl (fun r o => applyScopeOp o r) r0 = r
  intro h
  cases r with
  | mk sc tg =>
    cases tg with
    | none => simp [flushDeliverNew] at h
    | some t' =>
      by_cases hs : sc = t'
      · simp [flushDeliverNew, hs] at h
        obtain ⟨h1, h2⟩ := h
        subst h1; subst h2; rfl
      · simp [flushDeliverNew, hs] at h

/-- Non-vacuity: an untouched queued row is delivered under its own scope. -/
theorem deliver_good_case {Scope : Type} [DecidableEq Scope] (t : Scope) :
    flushDeliverNew ({ scope := t, target := some t } : QRow Scope) = some (t, t) := by
  simp [flushDeliverNew]

/-- Counterexample (replayed): a queued team row broadened to 'global' by
recurrence, or moved by updateEngram, is POSTed to the team store with the
wrong scope by the old flush. Scopes instantiated as strings. -/
theorem old_delivers_wrong_scope :
    flushDeliverOld (applyScopeOp (.broaden "global")
      ({ scope := "group:acme/team", target := some "group:acme/team" } : QRow String))
      = some ("group:acme/team", "global") ∧
    flushDeliverOld (applyScopeOp (.update "local")
      ({ scope := "group:acme/team", target := some "group:acme/team" } : QRow String))
      = some ("group:acme/team", "local") := by
  decide

/-! ### 2b. Decisions D3 "no-widen" and D4 "like-rescope" (2026-09-26)

The writers now keep the invariant themselves. `updateEngram` on a queued row
whose scope changes (`_reconcileQueuedScope`): local-family new scope → cancel;
a writable url store for it → retarget; otherwise → cancel (the leak guard has
already run; a demotion lands on `local`, a local-family scope). Cross-scope
recurrence leaves a queued row's scope alone. `localFam`/`writable` are config
oracles.

Checked against round 2 (2026-09-27): still holds because `_reconcileQueuedScope` and
`_recordCrossScopeRecurrence`'s D3 skip for queued rows are unchanged. Round 2's new
scope-adjacent writes do not change a queued row's scope: Decision A only decides
WHICH hit may absorb a write (and none into a writable-remote scope,
`_crossScopeRecurrenceApplies`, R2CoreA §5b), and the secondary-store duplicate
persistence (core-index#8) writes `write_count`/`sources` only. -/

def applyScopeOpD {Scope : Type} [DecidableEq Scope] (localFam writable : Scope → Bool) :
    ScopeOp Scope → QRow Scope → QRow Scope
  | .update s, r =>
    match r.target with
    | none => { r with scope := s }
    | some _ =>
      if s = r.scope then r
      else if localFam s then { scope := s, target := none }
      else if writable s then { scope := s, target := some s }
      else { scope := s, target := none }
  | .broaden g, r =>
    match r.target with
    | none => { r with scope := g }
    | some _ => r
  | .rescopeLocal s, _ => { scope := s, target := none }

/-- The invariant `_outbox ⇒ scope = _outbox.target_scope`. -/
def QInv {Scope : Type} (r : QRow Scope) : Prop := ∀ t, r.target = some t → r.scope = t

theorem applyScopeOpD_inv {Scope : Type} [DecidableEq Scope] (localFam writable : Scope → Bool)
    (o : ScopeOp Scope) (r : QRow Scope) (h : QInv r) : QInv (applyScopeOpD localFam writable o r) := by
  intro t ht
  obtain ⟨sc, tg⟩ := r
  cases o with
  | update s =>
    cases tg with
    | none => simp [applyScopeOpD] at ht
    | some t0 =>
      by_cases h1 : s = sc <;> by_cases h2 : localFam s = true <;> by_cases h3 : writable s = true <;>
        simp_all [applyScopeOpD, QInv]
  | broaden g => cases tg <;> simp_all [applyScopeOpD, QInv]
  | rescopeLocal s => simp [applyScopeOpD] at ht

/-- D3/D4: from a well-formed queue entry, EVERY sequence of scope writes keeps
the invariant. -/
theorem ops_preserve_inv {Scope : Type} [DecidableEq Scope] (localFam writable : Scope → Bool)
    (ops : List (ScopeOp Scope)) : ∀ r0 : QRow Scope, QInv r0 →
    QInv (ops.foldl (fun r o => applyScopeOpD localFam writable o r) r0) := by
  induction ops with
  | nil => intro r0 h; exact h
  | cons o os ih => intro r0 h; exact ih _ (applyScopeOpD_inv localFam writable o r0 h)

/-- Hence the flush hold-back is DEFENCE only for in-process writers: on an
invariant row the fixed flush delivers exactly what the unguarded one would.
It stays for writers outside the model (hand edits, older clients). -/
theorem holdback_is_defence {Scope : Type} [DecidableEq Scope] (r : QRow Scope) (h : QInv r) :
    flushDeliverNew r = flushDeliverOld r := by
  cases r with
  | mk sc tg =>
    cases tg with
    | none => rfl
    | some t => have := h t rfl; simp at this; subst this; simp [flushDeliverNew, flushDeliverOld]

/-- Non-vacuity: a retargeted row IS delivered, to its new store under its new
scope; recurrence on a queued row keeps it deliverable to the team. -/
theorem retarget_delivers :
    let lf : String → Bool := fun s => s == "local"
    let wr : String → Bool := fun s => s == "group:acme/ops"
    let r0 : QRow String := { scope := "group:acme/team", target := some "group:acme/team" }
    flushDeliverNew (applyScopeOpD lf wr (.update "group:acme/ops") r0) = some ("group:acme/ops", "group:acme/ops") ∧
    flushDeliverNew (applyScopeOpD lf wr (.update "local") r0) = none ∧
    flushDeliverNew (applyScopeOpD lf wr (.broaden "global") r0) = some ("group:acme/team", "group:acme/team") := by
  decide

/-! ## 3. Auto-route + leak-guard pipeline (core-index#6, core-policy#2, #11)

Code: `_guardSensitiveScope` (explicit → session → `_resolveUnscopedScope`),
`decideAutoRoute` (scope-routing.ts; first eligible candidate, a SHARED one
skipped unless `allow_shared_auto_route`; decision E1 "me-only": a non-shared
REMOTE-backed one skipped unless it is the user's own `/me` namespace —
`refuseScope` = `_refuseRemotePersonalAutoRoute`), `previewAutoRoute` (same ranker +
same `decideAutoRoute`), then the guard: a scope that leaves the machine
(`isSharedScope ∨ _isRemoteBackedScope`) with an offending hit → `local`.
`unscoped_default` is `z.enum(['local','global'])` (schemas/config.ts).
Classification predicates and the scanner are oracles.

Checked against round 2 (2026-09-27): still holds because scope-routing.ts has no
round-2 change and `_guardSensitiveScope`'s resolve → route → guard order,
`_refuseRemotePersonalAutoRoute` (E1 me-only, already modelled here) and
`_isRemoteBackedScope` (= `leaves` for URL stores; readonly ones included, which can
only demote more) are unchanged. Round 2 made the function reload the config at its
top on EVERY path (core-index#9), so one `Env` snapshot now really governs resolve
and guard for explicit writes too — the model's assumption; the current-config
property itself is R2CoreA §4 `egress_current_policy`. -/

inductive Src where
  | explicit | session | default | routed
  deriving DecidableEq, Repr

structure Cand (Scope : Type) where
  scope    : Scope
  eligible : Bool   -- coverContainsDomain ∨ confidence ≥ threshold
  deriving Repr

structure Env (Scope : Type) where
  isShared      : Scope → Bool
  remoteBacked  : Scope → Bool
  offending     : Scope → Bool       -- `_offendingHitsForScope(text, s) ≠ []`
  allowShared   : Bool
  own           : Scope → Bool       -- `_isOwnRemoteNamespace`: /me says it is the user's own
                                     -- (false when the identity is unknown — fail closed)
  fallback      : Scope              -- unscoped_default ∈ {local, global}
  local_        : Scope              -- 'local'

def leaves {Scope : Type} (env : Env Scope) (s : Scope) : Bool :=
  env.isShared s || env.remoteBacked s

/-- `decideAutoRoute`: the scope routed to, if any. -/
def decideRoute {Scope : Type} (env : Env Scope) : List (Cand Scope) → Option Scope
  | [] => none
  | c :: cs =>
    if !c.eligible then decideRoute env cs
    else if !env.allowShared && env.isShared c.scope then decideRoute env cs
    else if !env.isShared c.scope && env.remoteBacked c.scope && !env.own c.scope then decideRoute env cs
    else some c.scope

/-- `previewAutoRoute` = the same decision (auto_route_scope enabled). -/
def preview {Scope : Type} (env : Env Scope) (cands : List (Cand Scope)) : Option Scope :=
  decideRoute env cands

def resolve {Scope : Type} (env : Env Scope) (explicit session : Option Scope)
    (cands : List (Cand Scope)) : Scope × Src :=
  match explicit, session with
  | some s, _ => (s, .explicit)
  | none, some s => (s, .session)
  | none, none =>
    match decideRoute env cands with
    | some s => (s, .routed)
    | none => (env.fallback, .default)

def guard {Scope : Type} (env : Env Scope) (s : Scope) : Scope :=
  if leaves env s && env.offending s then env.local_ else s

def pipeline {Scope : Type} (env : Env Scope) (explicit session : Option Scope)
    (cands : List (Cand Scope)) : Scope × Src :=
  let r := resolve env explicit session cands
  (guard env r.1, r.2)

/-- Well-formed environment: the fallback and `local` are local-family and
`local` never leaves the machine. -/
structure WF {Scope : Type} (env : Env Scope) : Prop where
  fallback_not_shared : env.isShared env.fallback = false
  local_stays         : leaves env env.local_ = false

theorem decideRoute_not_shared {Scope : Type} (env : Env Scope) (cands : List (Cand Scope)) (s : Scope)
    (h : decideRoute env cands = some s) (hno : env.allowShared = false) : env.isShared s = false := by
  induction cands with
  | nil => simp [decideRoute] at h
  | cons c cs ih =>
    simp only [decideRoute] at h
    by_cases he : c.eligible = true
    · by_cases hs : env.isShared c.scope = true
      · simp_all
      · simp only [he, hs, hno] at h; simp at h
        split at h
        · exact ih h
        · cases h; simpa using hs
    · simp_all

theorem guard_shared_of {Scope : Type} (env : Env Scope) (hwf : WF env) (s : Scope) :
    env.isShared (guard env s) = true → env.isShared s = true := by
  intro h
  unfold guard at h
  split at h
  · have hl := hwf.local_stays
    simp [leaves] at hl
    rw [hl.1] at h; cases h
  · exact h

theorem resolve_unscoped_not_shared {Scope : Type} (env : Env Scope) (hwf : WF env)
    (cands : List (Cand Scope)) (hno : env.allowShared = false) :
    env.isShared (resolve env none none cands).1 = false := by
  simp only [resolve]
  cases hd : decideRoute env cands with
  | some s => exact decideRoute_not_shared env cands s hd hno
  | none => exact hwf.fallback_not_shared

/-- P1: the final scope is shared only if a human chose it (explicit/session)
or the install opted in to shared auto-routing. -/
theorem final_shared_needs_human {Scope : Type} (env : Env Scope) (hwf : WF env)
    (explicit session : Option Scope) (cands : List (Cand Scope)) :
    env.isShared (pipeline env explicit session cands).1 = true →
    (pipeline env explicit session cands).2 = .explicit ∨
    (pipeline env explicit session cands).2 = .session ∨ env.allowShared = true := by
  intro h
  cases explicit with
  | some s => left; simp [pipeline, resolve]
  | none =>
    cases session with
    | some s => right; left; simp [pipeline, resolve]
    | none =>
      right; right
      cases hA : env.allowShared
      · have h1 : env.isShared (resolve env none none cands).1 = true := guard_shared_of env hwf _ h
        have h2 := resolve_unscoped_not_shared env hwf cands hA
        rw [h2] at h1
        cases h1
      · rfl

/-- P2: nothing offending leaves the machine — whatever the source. -/
theorem no_offending_egress {Scope : Type} (env : Env Scope) (hwf : WF env)
    (explicit session : Option Scope) (cands : List (Cand Scope)) :
    let s := (pipeline env explicit session cands).1
    leaves env s = true → env.offending s = false := by
  intro s hl
  simp only [s, pipeline, guard] at hl ⊢
  generalize (resolve env explicit session cands).1 = r at hl ⊢
  by_cases hg : (leaves env r && env.offending r) = true
  · simp [hg] at hl; simp [hwf.local_stays] at hl
  · simp [hg] at hl ⊢
    simp [hl] at hg
    exact hg

/-- P3: for a genuinely unscoped write the resolved scope is what the preview
reported (or the default when the preview routes nowhere). The leak guard may
still demote it afterwards; the preview does not claim otherwise. -/
theorem preview_is_write_decision {Scope : Type} (env : Env Scope) (cands : List (Cand Scope)) :
    (resolve env none none cands).1 = (preview env cands).getD env.fallback := by
  simp only [resolve, preview]
  cases decideRoute env cands <;> rfl

/-- Non-vacuity: with a clean statement an eligible personal candidate is routed. -/
def envClean : Env String :=
  { isShared := fun s => s == "group:t", remoteBacked := fun _ => false,
    offending := fun _ => false, allowShared := false, own := fun _ => false,
    fallback := "global", local_ := "local" }

/-- A url-backed `user:me` whose `/me` identity is unknown (or names someone else). -/
def envRemotePersonal : Env String :=
  { isShared := fun s => s == "group:t", remoteBacked := fun s => s == "user:me",
    offending := fun _ => false, allowShared := false, own := fun _ => false,
    fallback := "global", local_ := "local" }

/-- The same store after `/me` named `user:me` the user's own namespace. -/
def envOwnRemote : Env String := { envRemotePersonal with own := fun s => s == "user:me" }

theorem route_good_case :
    pipeline envClean none none [⟨"group:t", true⟩, ⟨"user:me", true⟩] = ("user:me", .routed) := by
  decide

/-- Decision E1 "me-only" (P4): an auto-routed destination that is remote-backed
and personal is ALWAYS the user's own `/me` namespace — for every candidate list
and every oracle. With `allowShared` off, a routed scope that leaves the machine
is therefore the user's own personal remote store. -/
theorem decideRoute_remote_personal_is_own {Scope : Type} (env : Env Scope)
    (cands : List (Cand Scope)) (s : Scope) (h : decideRoute env cands = some s)
    (hr : env.remoteBacked s = true) (hs : env.isShared s = false) : env.own s = true := by
  induction cands with
  | nil => simp [decideRoute] at h
  | cons c cs ih =>
    simp only [decideRoute] at h
    by_cases he : c.eligible = true
    · by_cases h1 : (!env.allowShared && env.isShared c.scope) = true
      · simp only [he, h1] at h; simp at h; exact ih h
      · by_cases h2 : (!env.isShared c.scope && env.remoteBacked c.scope && !env.own c.scope) = true
        · simp only [he, h1, h2] at h; simp at h; exact ih h
        · simp only [he, h1, h2] at h; simp at h
          subst h
          simp [hr, hs] at h2
          exact h2
    · simp only [he] at h; simp at h; exact ih h

theorem routed_leaves_only_own {Scope : Type} (env : Env Scope) (hwf : WF env)
    (cands : List (Cand Scope)) (hno : env.allowShared = false) :
    (pipeline env none none cands).2 = .routed →
    leaves env (pipeline env none none cands).1 = true →
    env.own (pipeline env none none cands).1 = true := by
  simp only [pipeline, resolve]
  cases hd : decideRoute env cands with
  | none => simp
  | some r =>
    intro _ hl
    have hs : env.isShared r = false := decideRoute_not_shared env cands r hd hno
    simp only [guard] at hl ⊢
    by_cases hg : (leaves env r && env.offending r) = true
    · simp [hg] at hl; simp [hwf.local_stays] at hl
    · simp only [hg] at hl ⊢
      simp [Bool.false_eq_true, leaves, hs] at hl
      exact decideRoute_remote_personal_is_own env cands r hd hl hs

/-- Decision E1: a url-backed personal scope that is not (known to be) the
user's own is refused — the unscoped write falls to the default. Replayed in
formal-apply-core-me-only.test.ts and formal-writepath-route.test.ts. -/
theorem refused_foreign_remote_personal :
    pipeline envRemotePersonal none none [⟨"user:me", true⟩] = ("global", .default) := by
  decide

/-- Non-vacuity: once `/me` names it the user's own, it routes and leaves the machine. -/
theorem routed_into_own_remote_personal :
    leaves envOwnRemote (pipeline envOwnRemote none none [⟨"user:me", true⟩]).1 = true ∧
    (pipeline envOwnRemote none none [⟨"user:me", true⟩]).2 = .routed := by
  decide

/-- Pre-E1 router (shared-only refusal): the core-policy#2 witness, kept as the
counterexample the decision closes. -/
def decideRouteOld {Scope : Type} (env : Env Scope) : List (Cand Scope) → Option Scope
  | [] => none
  | c :: cs =>
    if !c.eligible then decideRouteOld env cs
    else if !env.allowShared && env.isShared c.scope then decideRouteOld env cs
    else some c.scope

theorem old_routed_into_remote_personal :
    decideRouteOld envRemotePersonal [⟨"user:me", true⟩] = some "user:me" ∧
    envRemotePersonal.own "user:me" = false := by decide

/-! ### 3b. `scope_source` on the wire (core-policy#11)

store/remote-store.ts `appendAndGetServerId`: the body carries `scope_source`
from `structured_data._scopeSource`, which `updateEngram` lets a caller set.

Checked against round 2 (2026-09-27): still holds because the round-2 diff of
remote-store.ts (loader-marker strip in `salvageRemoteRow`, load-page error handling)
does not touch `appendAndGetServerId`'s `SCOPE_SOURCES` filter. -/

def validSources : List String := ["explicit", "session", "default", "routed"]

def wireScopeSourceOld (raw : Option String) : Option String := raw

def wireScopeSourceNew (raw : Option String) : Option String :=
  match raw with
  | some v => if v ∈ validSources then some v else none
  | none => none

theorem wire_scope_source_valid (raw : Option String) (v : String) :
    wireScopeSourceNew raw = some v → v ∈ validSources := by
  cases raw with
  | none => simp [wireScopeSourceNew]
  | some w =>
    by_cases h : w ∈ validSources
    · simp [wireScopeSourceNew, h]; intro e; subst e; exact h
    · simp [wireScopeSourceNew, h]

theorem wire_scope_source_good : wireScopeSourceNew (some "routed") = some "routed" := by decide

theorem wire_scope_source_old_forged :
    wireScopeSourceOld (some "approved-by-admin") = some "approved-by-admin" := rfl

/-! ## 4. "Private stays local" — three predicates (core-index#2)

Code: learn() remote branch (`remoteDriver && context?.visibility === 'private'`
→ local, #90); learnRouted() remote route (no visibility check on main;
fixed: `!remoteDriver || context?.visibility === 'private'` → local route);
sync.ts `pushKeep('shared')` (`isSharedScope ∧ (visibility ?? 'private') ≠ 'private'`).
Resolved visibility defaults to private (#401, schema default).

Checked against round 2 (2026-09-27): still holds because learn()'s
`remoteDriver && context?.visibility === 'private'` and learnRouted()'s
`!remoteDriver || context?.visibility === 'private'` local-route tests and sync.ts
`pushKeep('shared')` are unchanged. -/

inductive Vis where
  | priv | pub | template
  deriving DecidableEq, Repr

def resolvedVis (explicit : Option Vis) : Vis := explicit.getD .priv

def learnEgress (remoteBacked : Bool) (explicit : Option Vis) : Bool :=
  remoteBacked && explicit != some .priv

def learnRoutedEgressOld (remoteBacked : Bool) (_explicit : Option Vis) : Bool := remoteBacked

def learnRoutedEgressNew (remoteBacked : Bool) (explicit : Option Vis) : Bool :=
  remoteBacked && !(explicit == some .priv)

def syncSharedEgress (isShared : Bool) (explicit : Option Vis) : Bool :=
  isShared && resolvedVis explicit != .priv

/-- The two write paths now agree on every input. -/
theorem write_paths_agree (rb : Bool) (v : Option Vis) :
    learnRoutedEgressNew rb v = learnEgress rb v := by
  cases rb <;> cases v <;> try rfl
  all_goals rename_i x; cases x <;> rfl

/-- An explicitly private engram leaves the machine on none of the three paths. -/
theorem explicit_private_stays_local (rb sh : Bool) :
    learnEgress rb (some .priv) = false ∧ learnRoutedEgressNew rb (some .priv) = false ∧
    syncSharedEgress sh (some .priv) = false := by
  cases rb <;> cases sh <;> decide

/-- Non-vacuity: a team write that did not say private still leaves. -/
theorem team_write_still_pushed : learnRoutedEgressNew true none = true := by decide

/-- Counterexample on main (replayed): learnRouted pushed an explicitly private engram. -/
theorem old_learnRouted_pushes_private : learnRoutedEgressOld true (some .priv) = true := rfl

/-- Policy divergence (NEEDS-OWNER Q5, not changed): with the DEFAULT
visibility (private) a team-scope engram is pushed by the store write path but
excluded by shared git sync. -/
theorem default_private_diverges :
    learnEgress true none = true ∧ syncSharedEgress true none = false := by decide

/-! ## 5. Tension gate on lock escalation, readonly tension mutators (core-index#5, #4)

Code: `hasUnresolvedTension` (try `loadTensions` … catch), consumed by
`applyMutation`'s commitment ladder (`decided → locked` unless blocked);
`loadTensions` returns [] for a missing file and THROWS for an unreadable one
(#794 F1). Readonly: `_assertWritable()` at the top of each public mutator.

Checked against round 2 (2026-09-27): still holds because `hasUnresolvedTension`
still returns true from its catch (fail closed) and the tension mutators still start
with `_assertWritable()`. tensions.ts changed only `engramOrigin` /
`measuredUnderGateApplies` (R2CoreB §1), not `loadTensions`' missing-vs-unreadable
split. -/

inductive TRead where
  | missing
  | ok (unresolvedForThis : Bool)
  | unreadable
  deriving DecidableEq, Repr

def hasUnresolvedOld : TRead → Bool
  | .missing => false
  | .ok b => b
  | .unreadable => false   -- `catch { return false }`

def hasUnresolvedNew : TRead → Bool
  | .missing => false
  | .ok b => b
  | .unreadable => true    -- fail closed

inductive Commit where
  | exploring | leaning | decided | locked
  deriving DecidableEq, Repr

/-- applyMutation's forward-only ladder for a recurrence ≥ 2 hit. -/
def nextCommit (blocked : Bool) : Commit → Commit
  | .exploring => .leaning
  | .leaning => .decided
  | .decided => if blocked then .decided else .locked
  | .locked => .locked

/-- An engram escalates INTO locked only when the tension file was actually
read (or is absent) and shows no unresolved tension for it. -/
theorem lock_only_when_known_clean (c : Commit) (r : TRead) :
    c ≠ .locked → nextCommit (hasUnresolvedNew r) c = .locked → r = .missing ∨ r = .ok false := by
  intro hc h
  cases c <;> cases r <;> simp_all [nextCommit, hasUnresolvedNew]
  all_goals (rename_i b; cases b <;> simp_all)

/-- Non-vacuity: a clean or absent file still lets it lock. -/
theorem lock_good_case :
    nextCommit (hasUnresolvedNew .missing) .decided = .locked ∧
    nextCommit (hasUnresolvedNew (.ok false)) .decided = .locked := by decide

/-- Counterexample on main (replayed): an unreadable file let it lock. -/
theorem old_unreadable_locks : nextCommit (hasUnresolvedOld .unreadable) .decided = .locked := by decide

/-- Readonly gate: a guarded mutator never writes on a readonly instance. -/
def tensionMutate (guarded readonly : Bool) (_file newFile : Nat) : Except String Nat :=
  if guarded && readonly then .error "ReadonlyStoreError" else .ok newFile

theorem readonly_no_write (file newFile : Nat) :
    ∀ v, tensionMutate true true file newFile = .ok v → False := by
  intro v h; simp [tensionMutate] at h

theorem writable_still_writes (file newFile : Nat) :
    tensionMutate true false file newFile = .ok newFile := by simp [tensionMutate]

theorem old_readonly_writes (file newFile : Nat) :
    tensionMutate false true file newFile = .ok newFile := by simp [tensionMutate]

/-! ## 6. rescope() remote route — per-id atomic reporting (core-index#11)

Code: `rescope` loops `_rescopeOne` over the ids; the remote route pushes
(`appendAndGetServerId`), then `_retireRescopedSource` (unless keep_local).
Environment outcomes per id: the push fails or lands; the local retire
succeeds, throws (store unwritable), or finds the row gone/already retired.

Checked against round 2 (2026-09-27): still holds because `_rescopeOne`'s remote route
(per-id error result carrying the server id when the retire throws) and
`_retireRescopedSource` are unchanged; the only round-2 edit in `rescope` is a comment
on the case-sensitive local-family test. -/

inductive PushR where
  | fail | landed
  deriving DecidableEq, Repr

inductive RetireR where
  | ok | throws | vanished
  deriving DecidableEq, Repr

inductive RStatus where
  | rescoped | error
  deriving DecidableEq, Repr

structure ROut where
  status      : RStatus
  newIdShown  : Bool   -- result carries the server id
  histRetired : Bool   -- an engram_retired history event was appended
  deriving DecidableEq, Repr

/-- main: `none` = the exception escaped `rescope` (batch aborted). -/
def rescopeOneOld : PushR → RetireR → Option ROut
  | .fail, _ => some ⟨.error, false, false⟩
  | .landed, .ok => some ⟨.rescoped, true, true⟩
  | .landed, .throws => none
  | .landed, .vanished => some ⟨.rescoped, true, true⟩

def rescopeOneNew : PushR → RetireR → Option ROut
  | .fail, _ => some ⟨.error, false, false⟩
  | .landed, .ok => some ⟨.rescoped, true, true⟩
  | .landed, .throws => some ⟨.error, true, false⟩
  | .landed, .vanished => some ⟨.rescoped, true, false⟩

/-- The batch: results so far, or abort on the first escaped exception. -/
def batch (one : PushR → RetireR → Option ROut) : List (PushR × RetireR) → Option (List ROut)
  | [] => some []
  | (p, r) :: rest =>
    match one p r, batch one rest with
    | some o, some os => some (o :: os)
    | _, _ => none

theorem rescopeOneNew_total (p : PushR) (r : RetireR) : ∃ o, rescopeOneNew p r = some o := by
  cases p <;> cases r <;> simp [rescopeOneNew]

/-- Every id gets a result — the batch never aborts. -/
theorem batch_new_complete (xs : List (PushR × RetireR)) :
    ∃ os, batch rescopeOneNew xs = some os ∧ os.length = xs.length := by
  induction xs with
  | nil => exact ⟨[], rfl, rfl⟩
  | cons x rest ih =>
    obtain ⟨os, h, hl⟩ := ih
    obtain ⟨o, ho⟩ := rescopeOneNew_total x.1 x.2
    exact ⟨o :: os, by simp [batch, ho, h], by simp [hl]⟩

/-- A push that landed is always reported with its server id; a retirement is
recorded in history exactly when one happened; success means both halves. -/
theorem rescope_one_reports (p : PushR) (r : RetireR) (o : ROut) (h : rescopeOneNew p r = some o) :
    (p = .landed → o.newIdShown = true) ∧
    (o.histRetired = true ↔ (p = .landed ∧ r = .ok)) ∧
    (o.status = .rescoped → p = .landed ∧ r ≠ .throws) := by
  cases p <;> cases r <;> simp [rescopeOneNew] at h <;> subst h <;> simp

/-- Non-vacuity: the clean move is a success with history. -/
theorem rescope_good_case : rescopeOneNew .landed .ok = some ⟨.rescoped, true, true⟩ := rfl

/-- Counterexamples on main (both replayed): a failing retire after a landed
push aborts the batch; a vanished source still gets a retirement event. -/
theorem old_batch_aborts :
    batch rescopeOneOld [(.landed, .throws), (.landed, .ok)] = none := by decide

theorem old_vanished_history :
    rescopeOneOld .landed .vanished = some ⟨.rescoped, true, true⟩ := rfl

end PlurSpec.WritePath
