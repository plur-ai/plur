/-!
# WritePath — the Plur write path (packages/core/src/index.ts)

Models, branch for branch, the parts of the write path the WritePath cluster
covers. Each section names the code it mirrors. Payloads (statements, ids,
content scanners, config) are abstracted: theorems quantify over them.

Findings and replays: spec/formal/findings/writepath.md.

Checked against #1349 (merged into #1228 on 2026-09-30): still holds. index.ts's
only change is a re-export of `pendingStoreLockOps`, and no write-path branch changed.

Checked against #1631 (epic/1797 first install, 2026-10-18): updated. index.ts
routes through the one resolver `resolveScopeTarget` (store-resolver.ts):
`_resolveRemoteStoreForScope`, `_isRemoteBackedScope`, `_isRemoteWriteScope`,
`readIdFor` and the delivery report all read it, a scope two servers claim is
refused before anything is saved, and the flush holds a queued row whose
target scope is conflicted. New: §2c (the conflict hold; §2's theorems carry
over off conflicts) and §3c (the resolver, branch for branch: what the router
sends is remote-backed for the guard, so P2 holds over the real routing rule;
a conflicted scope is refused). §1's merge-back, §4's private-stays-local tests,
§5 and §6 are unchanged (rescope resolves its route before touching a row, so
a conflict throws first). remote-store.ts changed only `me()` (the C1 /me
fields), which no section reads.
Checked against #1632 (git default scope, 2026-10-18): still holds. `remote-store.ts` only
exports `isSafeHost` (unchanged) so `git-origin.ts` reuses the one host grammar; no code path
this model covers changed.
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
nothing about two processes flushing one store; across processes the
per-entry claim and its re-read do (decision C3, §1c,
`claimed_at_most_once_across_processes`).

Pushers: `L` = learn()'s fire-and-forget push (in flight from the moment the
row is written), `F` = a flushOutbox() that snapshots while L may be active.
`guarded` = the fix: F selects only rows not in `_outboxInFlight`, and claims
what it selects. A finished push that succeeds is one delivery to the remote
(the POST was on the wire whatever the local state) and hands the row off.

Checked against round 2 (2026-09-27): still holds because the `_outboxInFlight` claim
is unchanged (learn() adds before its push and deletes in `finally`; the flush selects
only unclaimed rows and claims them). Across processes see §1c (claims, C3). -/

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

/-! ### 1c. Decision C3: per-entry claims plus a re-read — at most once ACROSS processes

Replaces #1228's on-disk row lease (decision D2), removed by decision C3
(2026-09-29): #1277's per-entry claims, as merged on main, are the one
duplicate-push guard.

Code (`_claimOutboxEntry`, `_releaseOutboxClaim`, `_outboxRowStillQueued`,
`_flushOutbox` / `_flushOutboxClaimed`, learn()'s remote branch):
- `snap p k` — a pusher's snapshot shows the row queued under key `k` (a
  flush's store load; learn() writes the row itself).
- `claim p` — the claim file is created with O_EXCL (`link(2)`, or `wx`):
  it succeeds only when no claim exists. A lapsed claim is taken over under a
  takeover marker that also has one winner (`spec/formal/PlurSpec/Outbox.lean`
  §5), so "at most one holder" is the step modelled here.
- `reread p` — under the claim, the row is read again (`_outboxRowStillQueued`)
  and pushed only while it is still queued under the same key. Otherwise the
  pusher lets go.
- `post p ok` — the POST. Accepted: the row is handed off (deleted) BEFORE the
  claim is released. Refused: the failure is recorded, the row stays, the
  claim is let go.
- `release p` — only the holder's own claim is removed (the token check).

Crashes are not modelled here: a pusher that dies after the remote accepted
but before the hand-off leaves the row queued, and the next pusher posts it
again with the SAME key (decision C4). A key-honouring server collapses that
retry, a key-ignoring one stores one more row (Outbox §3). Without crashes,
every interleaving of any number of pushers POSTs the write at most once. -/

inductive CPh where
  | idle
  | snap (k : Nat)
  | claimed (k : Nat)
  | pushing (k : Nat)
  | handed
  deriving DecidableEq, Repr

structure CState (P : Type) where
  /-- The queued row's key, or `none` once it was handed off. -/
  row       : Option Nat
  claim     : Option P
  phase     : P → CPh
  delivered : Nat

inductive CEv (P : Type) where
  | snap (p : P)
  | claim (p : P)
  | reread (p : P)
  | post (p : P) (ok : Bool)
  | release (p : P)

section Claims
variable {P : Type} [DecidableEq P]

def cupd (f : P → CPh) (p : P) (v : CPh) : P → CPh := fun q => if q = p then v else f q

/-- `reread = false` is a claim with no re-read of the row (the counterexample). -/
def cstep (reread : Bool) (s : CState P) : CEv P → CState P
  | .snap p =>
    match s.phase p, s.row with
    | .idle, some k => { s with phase := cupd s.phase p (.snap k) }
    | _, _ => s
  | .claim p =>
    match s.phase p, s.claim with
    | .snap k, none => { s with claim := some p, phase := cupd s.phase p (.claimed k) }
    | _, _ => s
  | .reread p =>
    match s.phase p with
    | .claimed k =>
      if !reread || s.row = some k then { s with phase := cupd s.phase p (.pushing k) }
      else { s with claim := none, phase := cupd s.phase p .idle }
    | _ => s
  | .post p ok =>
    match s.phase p with
    | .pushing _ =>
      if ok then { s with row := none, delivered := s.delivered + 1, phase := cupd s.phase p .handed }
      else { s with claim := none, phase := cupd s.phase p .idle }
    | _ => s
  | .release p =>
    match s.phase p with
    | .handed => { s with claim := if s.claim = some p then none else s.claim, phase := cupd s.phase p .idle }
    | _ => s

def crun (reread : Bool) (s : CState P) (es : List (CEv P)) : CState P := es.foldl (cstep reread) s

/-- The row is queued under key `k`; nobody has touched it. -/
def cinit (k : Nat) : CState P := { row := some k, claim := none, phase := fun _ => .idle, delivered := 0 }

def holds : CPh → Bool
  | .claimed _ | .pushing _ | .handed => true
  | _ => false

def CInv (s : CState P) : Prop :=
  (∀ p, holds (s.phase p) = true → s.claim = some p) ∧
  (∀ p k, s.phase p = .pushing k → s.row = some k ∧ s.delivered = 0) ∧
  (∀ p, s.phase p = .handed → s.row = none) ∧
  s.delivered ≤ 1 ∧ (s.delivered = 1 → s.row = none)

theorem cinv_init (k : Nat) : CInv (cinit k : CState P) := by
  simp [CInv, cinit, holds]

/-- One pusher `p` changes phase to `v`; the claim, row and count become
`c'`, `r'`, `d'`. The invariant holds after it when these side conditions do. -/
theorem cinv_update (s : CState P) (p : P) (v : CPh) (r' : Option Nat) (c' : Option P) (d' : Nat)
    (ha : holds v = true → c' = some p)
    (hb : ∀ q, q ≠ p → holds (s.phase q) = true → c' = some q)
    (hc : ∀ k, v = .pushing k → r' = some k ∧ d' = 0)
    (hd : ∀ q, q ≠ p → ∀ k, s.phase q = .pushing k → r' = some k ∧ d' = 0)
    (he : v = .handed → r' = none)
    (hf : ∀ q, q ≠ p → s.phase q = .handed → r' = none)
    (hg : d' ≤ 1 ∧ (d' = 1 → r' = none)) :
    CInv ({ row := r', claim := c', phase := cupd s.phase p v, delivered := d' } : CState P) := by
  refine ⟨?_, ?_, ?_, hg.1, hg.2⟩
  · intro q hq
    by_cases hqp : q = p
    · subst hqp; exact ha (by simpa [cupd] using hq)
    · exact hb q hqp (by simpa [cupd, hqp] using hq)
  · intro q k hq
    by_cases hqp : q = p
    · subst hqp; exact hc k (by simpa [cupd] using hq)
    · exact hd q hqp k (by simpa [cupd, hqp] using hq)
  · intro q hq
    by_cases hqp : q = p
    · subst hqp; exact he (by simpa [cupd] using hq)
    · exact hf q hqp (by simpa [cupd, hqp] using hq)

/-- The claim names the only pusher in a holding phase. -/
theorem only_holder (s : CState P) (h : CInv s) (p : P) (hcp : s.claim = some p) :
    ∀ q, q ≠ p → holds (s.phase q) = false := by
  intro q hqp
  cases hq : holds (s.phase q)
  · rfl
  · have := h.1 q hq
    rw [hcp] at this
    exact absurd (Option.some.inj this).symm hqp

theorem not_holding_phase (s : CState P) (q : P) (hq : holds (s.phase q) = false) :
    (∀ k, s.phase q ≠ .pushing k) ∧ s.phase q ≠ .handed := by
  constructor
  · intro k hk; rw [hk] at hq; simp [holds] at hq
  · intro hk; rw [hk] at hq; simp [holds] at hq

theorem cinv_step (s : CState P) (e : CEv P) (h : CInv s) : CInv (cstep true s e) := by
  have hI := h
  obtain ⟨hh, hp, hd, hle, h1⟩ := h
  cases e with
  | snap p =>
    cases hph : s.phase p with
    | idle =>
      cases hrow : s.row with
      | none => simpa [cstep, hph, hrow] using hI
      | some k =>
        have key := cinv_update s p (.snap k) s.row s.claim s.delivered
          (by simp [holds]) (fun q _ hq => hh q hq) (by simp)
          (fun q _ k' hq => hp q k' hq) (by simp) (fun q _ hq => hd q hq) ⟨hle, h1⟩
        rw [hrow] at key
        simpa [cstep, hph, hrow] using key
    | _ => simpa [cstep, hph] using hI
  | claim p =>
    cases hph : s.phase p with
    | snap k =>
      cases hcl : s.claim with
      | some _ => simpa [cstep, hph, hcl] using hI
      | none =>
        have hfree : ∀ q, holds (s.phase q) = false := by
          intro q; cases hq : holds (s.phase q)
          · rfl
          · have := hh q hq; rw [hcl] at this; exact absurd this (by simp)
        simp only [cstep, hph, hcl]
        exact cinv_update s p (.claimed k) s.row (some p) s.delivered
          (fun _ => rfl)
          (fun q _ hq => by rw [hfree q] at hq; exact absurd hq (by simp))
          (by simp)
          (fun q _ k' hq => absurd hq ((not_holding_phase s q (hfree q)).1 k'))
          (by simp)
          (fun q _ hq => absurd hq (not_holding_phase s q (hfree q)).2)
          ⟨hle, h1⟩
    | _ => simpa [cstep, hph] using hI
  | reread p =>
    cases hph : s.phase p with
    | claimed k =>
      have hcp : s.claim = some p := hh p (by rw [hph]; rfl)
      have honly := only_holder s hI p hcp
      by_cases hrow : s.row = some k
      · have hd0 : s.delivered = 0 := by
          rcases Nat.lt_or_ge s.delivered 1 with hlt | hge
          · omega
          · have := h1 (by omega); rw [this] at hrow; exact absurd hrow (by simp)
        have key := cinv_update s p (.pushing k) s.row s.claim s.delivered
          (fun _ => hcp) (fun q _ hq => hh q hq)
          (fun k' hk => by cases hk; exact ⟨hrow, hd0⟩)
          (fun q _ k' hq => hp q k' hq) (by simp) (fun q _ hq => hd q hq) ⟨hle, h1⟩
        rw [hrow] at key
        simpa [cstep, hph, hrow] using key
      · simp only [cstep, hph, hrow, Bool.not_true, Bool.false_or, decide_false, Bool.false_eq_true, ↓reduceIte]
        exact cinv_update s p .idle s.row none s.delivered
          (by simp [holds])
          (fun q hqp hq => by rw [honly q hqp] at hq; exact absurd hq (by simp))
          (by simp)
          (fun q hqp k' hq => absurd hq ((not_holding_phase s q (honly q hqp)).1 k'))
          (by simp)
          (fun q hqp hq => absurd hq (not_holding_phase s q (honly q hqp)).2)
          ⟨hle, h1⟩
    | _ => simpa [cstep, hph] using hI
  | post p ok =>
    cases hph : s.phase p with
    | pushing k =>
      have hcp : s.claim = some p := hh p (by rw [hph]; rfl)
      have honly := only_holder s hI p hcp
      obtain ⟨_, hd0⟩ := hp p k hph
      cases ok
      · simp only [cstep, hph, Bool.false_eq_true, ↓reduceIte]
        exact cinv_update s p .idle s.row none s.delivered
          (by simp [holds])
          (fun q hqp hq => by rw [honly q hqp] at hq; exact absurd hq (by simp))
          (by simp)
          (fun q hqp k' hq => absurd hq ((not_holding_phase s q (honly q hqp)).1 k'))
          (by simp)
          (fun q hqp hq => absurd hq (not_holding_phase s q (honly q hqp)).2)
          ⟨hle, h1⟩
      · simp only [cstep, hph, ↓reduceIte]
        exact cinv_update s p .handed none s.claim (s.delivered + 1)
          (fun _ => hcp)
          (fun q hqp hq => by rw [honly q hqp] at hq; exact absurd hq (by simp))
          (by simp)
          (fun q hqp k' hq => absurd hq ((not_holding_phase s q (honly q hqp)).1 k'))
          (fun _ => rfl)
          (fun _ _ _ => rfl)
          ⟨by omega, fun _ => rfl⟩
    | _ => simpa [cstep, hph] using hI
  | release p =>
    cases hph : s.phase p with
    | handed =>
      have hcp : s.claim = some p := hh p (by rw [hph]; rfl)
      have honly := only_holder s hI p hcp
      simp only [cstep, hph, hcp, ↓reduceIte]
      exact cinv_update s p .idle s.row none s.delivered
        (by simp [holds])
        (fun q hqp hq => by rw [honly q hqp] at hq; exact absurd hq (by simp))
        (by simp)
        (fun q hqp k' hq => absurd hq ((not_holding_phase s q (honly q hqp)).1 k'))
        (by simp)
        (fun q hqp hq => absurd hq (not_holding_phase s q (honly q hqp)).2)
        ⟨hle, h1⟩
    | _ => simpa [cstep, hph] using hI

theorem cinv_run (es : List (CEv P)) : ∀ s : CState P, CInv s → CInv (crun true s es) := by
  induction es with
  | nil => intro s h; simpa [crun] using h
  | cons e es ih =>
    intro s h
    simp only [crun, List.foldl_cons]
    exact ih _ (cinv_step s e h)

/-- **Decision C3.** With per-entry claims and the re-read under the claim, for
any number of pushers (flushes in any process, learn()'s own push) and every
interleaving without a crash, the remote receives the write at most once. -/
theorem claimed_at_most_once_across_processes (k : Nat) (es : List (CEv P)) :
    (crun true (cinit k) es).delivered ≤ 1 :=
  (cinv_run es _ (cinv_init k)).2.2.2.1

end Claims

/-- Non-vacuity: a pusher does deliver, and a refused first push is retried by
another pusher that then delivers. -/
theorem claimed_delivers :
    (crun true (cinit 7 : CState Bool) [.snap true, .claim true, .reread true, .post true true]).delivered = 1 ∧
    (crun true (cinit 7 : CState Bool)
      [.snap true, .claim true, .reread true, .post true false,
       .snap false, .claim false, .reread false, .post false true]).delivered = 1 := by
  decide

/-- Counterexample (review of #1277; replayed in `outbox-claim-races.test.ts`):
without the re-read, a pusher whose snapshot predates another's delivery takes
the claim after it was released and posts the write a second time. -/
theorem claim_without_reread_double_delivery :
    (crun false (cinit 7 : CState Bool)
      [.snap true, .snap false, .claim true, .reread true, .post true true, .release true,
       .claim false, .reread false, .post false true]).delivered = 2 := by
  decide

/-- The same schedule with the re-read: the late pusher finds the row gone and
lets go. -/
theorem reread_blocks_late_pusher :
    (crun true (cinit 7 : CState Bool)
      [.snap true, .snap false, .claim true, .reread true, .post true true, .release true,
       .claim false, .reread false, .post false true]).delivered = 1 := by
  decide

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

/-! ### 2c. The conflict hold (#1631; reviewed 2026-10-18)

`routeFor` in `_flushOutboxClaimed`, after the scope/target check above, now
holds a row whose `_outbox.target_scope` two servers claim
(`resolveScopeTarget(target, stores).kind === 'conflict'`): `skip: 'failed'`,
nothing written, the row stays queued. The check is in `routeFor`, which runs
at selection and again right before the push, so the forced flush is held too.
`conflict` is the resolver's verdict on the current config, an oracle. -/

def flushDeliverC {Scope : Type} [DecidableEq Scope] (conflict : Scope → Bool)
    (r : QRow Scope) : Option (Scope × Scope) :=
  match r.target with
  | none => none
  | some t => if r.scope = t then (if conflict t then none else some (t, r.scope)) else none

/-- The §2 property survives the new branch: every delivery carries the scope of
the store it is sent to, whatever scope writes happened since queue time. -/
theorem deliverC_scope_matches_store {Scope : Type} [DecidableEq Scope] (conflict : Scope → Bool)
    (r0 : QRow Scope) (ops : List (ScopeOp Scope)) (t b : Scope) :
    flushDeliverC conflict (ops.foldl (fun r o => applyScopeOp o r) r0) = some (t, b) → b = t := by
  generalize ops.foldl (fun r o => applyScopeOp o r) r0 = r
  intro h
  obtain ⟨sc, tg⟩ := r
  cases tg with
  | none => simp [flushDeliverC] at h
  | some t' =>
    by_cases hs : sc = t' <;> by_cases hc : conflict t' = true <;> simp_all [flushDeliverC]
    obtain ⟨h1, h2⟩ := h
    exact h2 ▸ h1

/-- #1631: no row is ever delivered to a scope two servers claim. -/
theorem deliverC_never_conflicted {Scope : Type} [DecidableEq Scope] (conflict : Scope → Bool)
    (r : QRow Scope) (t b : Scope) (h : flushDeliverC conflict r = some (t, b)) : conflict t = false := by
  obtain ⟨sc, tg⟩ := r
  cases tg with
  | none => simp [flushDeliverC] at h
  | some t' =>
    by_cases hs : sc = t' <;> by_cases hc : conflict t' = true <;> simp_all [flushDeliverC]

/-- Off conflicts the flush is exactly the §2 flush, so `holdback_is_defence`
and the §2b theorems carry over unchanged. -/
theorem deliverC_agrees_off_conflict {Scope : Type} [DecidableEq Scope] (conflict : Scope → Bool)
    (r : QRow Scope) (h : ∀ t, r.target = some t → conflict t = false) :
    flushDeliverC conflict r = flushDeliverNew r := by
  obtain ⟨sc, tg⟩ := r
  cases tg with
  | none => rfl
  | some t => have := h t rfl; simp [flushDeliverC, flushDeliverNew, this]

/-- Non-vacuity: an unconflicted queued row is still delivered. -/
theorem deliverC_good_case :
    flushDeliverC (fun s => s == "group:acme/ops")
      ({ scope := "group:acme/team", target := some "group:acme/team" } : QRow String)
      = some ("group:acme/team", "group:acme/team") := by decide

/-- The pre-#1631 flush delivered a conflicted row (to whichever server was
listed first); the new one holds it. Replayed by routing-shared-resolver.test.ts
"a queued save whose scope a second server now claims is not flushed to either"
(force flush, 0 POSTs, row still queued). -/
theorem old_flush_delivers_conflicted :
    let r : QRow String := { scope := "group:acme/team", target := some "group:acme/team" }
    flushDeliverNew r = some ("group:acme/team", "group:acme/team") ∧
    flushDeliverC (fun _ => true) r = none := by decide

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

/-! ### 3c. One resolver for routing and the leak guard (#1631; reviewed 2026-10-18)

store-resolver.ts `resolveScopeTarget` now answers, from the expanded stores,
for the router (`_resolveRemoteStoreForScope`: `conflict` → throw
`ScopeConflictError`, `remote ∧ writable` → driver, else none), the guard's
`remoteBacked` (`_isRemoteBackedScope` = kind ≠ local), `_isRemoteWriteScope`
(= remote ∧ writable) and `readIdFor` (= remote). learn() and learnRouted() call
`_refuseScopeConflict` right after `_guardSensitiveScope`, before dedup.

Branch for branch for a non-personal scope: the url entries with exactly this
scope, grouped by normalized url (`server`); two servers → conflict; one →
remote, writable iff some entry of it is not readonly; none, but an enterprise
entry whose `discovery.org_id` is the scope's org → unauthorized; else local.
The personal `user:` branch (`personalStoreEntry`, #1515, unchanged) is an
oracle `pers`: it answers `remote w` or `local`. `scopeOrg` is an oracle. -/

structure SEntry where
  server   : Option Nat   -- normalizeEndpointUrl(url); none = a path store
  scope    : Nat
  readonly : Bool
  org      : Option Nat   -- `discovery.org_id` of an entry with an `enterprise` block
  deriving DecidableEq, Repr

inductive Target where
  | remote (writable : Bool) | conflict | unauthorized | local_
  deriving DecidableEq, Repr

def claims (s : Nat) (e : SEntry) : Bool := e.server.isSome && e.scope == s

def resolveNP (scopeOrg : Nat → Option Nat) (es : List SEntry) (s : Nat) : Target :=
  match es.filter (claims s) with
  | e :: rest =>
    if rest.any (fun x => x.server != e.server) then .conflict
    else .remote ((e :: rest).any (fun x => !x.readonly))
  | [] =>
    match scopeOrg s with
    | some o => if es.any (fun x => x.server.isSome && x.org == some o) then .unauthorized else .local_
    | none => .local_

def resolveT (pers : Nat → Option Target) (scopeOrg : Nat → Option Nat) (es : List SEntry) (s : Nat) : Target :=
  match pers s with
  | some t => t
  | none => resolveNP scopeOrg es s

inductive Route where
  | send | stay | refuse
  deriving DecidableEq, Repr

/-- `_resolveRemoteStoreForScope` (and `_refuseScopeConflict`). -/
def routeOf : Target → Route
  | .conflict => .refuse
  | .remote true => .send
  | _ => .stay

/-- `_isRemoteBackedScope`: kind ≠ local. -/
def backed : Target → Bool
  | .local_ => false
  | _ => true

/-- `_isRemoteWriteScope`. -/
def writeScope : Target → Bool
  | .remote true => true
  | _ => false

/-- Whatever leaves through the router is remote-backed for the guard. -/
theorem send_is_backed (t : Target) (h : routeOf t = .send) : backed t = true := by
  cases t with
  | remote w => cases w <;> simp_all [routeOf, backed]
  | _ => simp_all [routeOf]

/-- `_isRemoteWriteScope` is exactly the router's sending rule. -/
theorem send_iff_writeScope (t : Target) : routeOf t = .send ↔ writeScope t = true := by
  cases t with
  | remote w => cases w <;> simp [routeOf, writeScope]
  | _ => simp [routeOf, writeScope]

/-- Two url entries on different servers with exactly this scope: the router
refuses (non-personal scope), whatever else is configured. -/
theorem conflict_refused (scopeOrg : Nat → Option Nat) (es : List SEntry) (s : Nat)
    (e1 e2 : SEntry) (h1 : e1 ∈ es) (h2 : e2 ∈ es) (c1 : claims s e1 = true) (c2 : claims s e2 = true)
    (hd : e1.server ≠ e2.server) : routeOf (resolveNP scopeOrg es s) = .refuse := by
  have m1 : e1 ∈ es.filter (claims s) := List.mem_filter.mpr ⟨h1, c1⟩
  have m2 : e2 ∈ es.filter (claims s) := List.mem_filter.mpr ⟨h2, c2⟩
  unfold resolveNP
  generalize es.filter (claims s) = cl at m1 m2
  cases cl with
  | nil => cases m1
  | cons e rest =>
    have hany : rest.any (fun x => x.server != e.server) = true := by
      rcases List.mem_cons.mp m1 with r1 | r1 <;> rcases List.mem_cons.mp m2 with r2 | r2
      · subst r1; subst r2; exact absurd rfl hd
      · subst r1; exact List.any_eq_true.mpr ⟨e2, r2, by simp [Ne.symm hd]⟩
      · subst r2; exact List.any_eq_true.mpr ⟨e1, r1, by simp [hd]⟩
      · by_cases he : e1.server = e.server
        · exact List.any_eq_true.mpr ⟨e2, r2, by simp; intro h; exact hd (he.trans h.symm)⟩
        · exact List.any_eq_true.mpr ⟨e1, r1, by simp [he]⟩
    simp [hany, routeOf]

/-- The leak guard reads the same resolver: with `remoteBacked := backed ∘
resolveT`, the final scope of every write, if the router sends it, carries no
offending hit (P2 instantiated). -/
theorem sent_never_offending (pers : Nat → Option Target) (scopeOrg : Nat → Option Nat)
    (es : List SEntry) (env : Env Nat) (hwf : WF env)
    (hrb : ∀ s, env.remoteBacked s = backed (resolveT pers scopeOrg es s))
    (explicit session : Option Nat) (cands : List (Cand Nat)) :
    let s := (pipeline env explicit session cands).1
    routeOf (resolveT pers scopeOrg es s) = .send → env.offending s = false := by
  intro s hs
  have hb := send_is_backed _ hs
  apply no_offending_egress env hwf explicit session cands
  show (env.isShared s || env.remoteBacked s) = true
  rw [hrb s, hb]
  simp

/-- Non-vacuity: one writable server for the scope → sent. -/
theorem single_server_sends :
    routeOf (resolveNP (fun _ => none) [⟨some 1, 7, false, none⟩, ⟨some 1, 7, true, none⟩] 7) = .send := by
  decide

/-- An ungranted scope under a company server's org is backed (the guard
treats it as leaving) but never sent. -/
theorem unauthorized_backed_not_sent :
    let t := resolveNP (fun s => if s == 9 then some 3 else none) [⟨some 1, 7, false, some 3⟩] 9
    t = .unauthorized ∧ backed t = true ∧ routeOf t = .stay := by decide

/-- The pre-#1631 router: the first writable url entry with exactly this
scope, whichever server it is on. -/
def routeOld (es : List SEntry) (s : Nat) : Option Nat :=
  (es.find? (fun e => claims s e && !e.readonly)).bind (·.server)

/-- Counterexample on the old router (= routing-shared-resolver.test.ts "learn
is refused, nothing sent, nothing saved"): two servers claim scope 7; the old
router sent to server 1, the new one refuses. -/
theorem old_router_sends_conflicted :
    let es := [(⟨some 1, 7, false, none⟩ : SEntry), ⟨some 2, 7, false, none⟩]
    routeOld es 7 = some 1 ∧ routeOf (resolveNP (fun _ => none) es 7) = .refuse := by decide

/-! ### 3d. Remote-only folders: the bound instance's write gate (#1521; merged onto development 2026-10-18)

A Plur instance bound to a `remote-only` folder (`bindFolderPolicy`) runs
index.ts `_remoteOnlyContext` before every write (`_guardSensitiveScope`,
`learnAsync`, `learnBatch`):
  - blocked (the folder map could not be read, or the folder not resolved) → refuse;
  - `visibility: private` → refuse;
  - target := the explicit scope, else the folder's scope; none → refuse;
  - `_refuseScopeConflict(target)`: a scope two servers claim → refuse (#1631);
  - target not deliverable → refuse (an explicit scope other than the folder's
    is first checked for `isSharedScope`, which `deliverable` includes);
  - then `_guardSensitiveScope` refuses an offending hit for the target
    instead of demoting it to local.
`_isDeliverableTeamScope` (one rule, re-audit 3 of #1521, R3-1): shared, not
local-only, not `user:`, and the shared resolver says `remote` and writable
(`writeScope`). It used "some writable url entry has exactly this scope" before
the merge onto development; `old_deliverable_accepts_conflict` is why that changed.
The grammar predicates are oracles.

Review of #1521, (d): an update never retargets a save queued from a remote-only
folder (any scope change is refused, §2's invariant is untouched), and the
retarget branch refuses it unless the new scope is a deliverable team scope
(a personal url store can be the resolver's writable target, #1515/#1528).
Messages name folders and scopes only as escaped data; that is not modelled. -/

structure ROBind where
  blocked     : Bool
  folderScope : Option Nat
  deriving DecidableEq, Repr

inductive RODecision where
  | write (s : Nat) | refuse
  deriving DecidableEq, Repr

/-- `_isDeliverableTeamScope`, given the resolver's target for the scope. -/
def deliverable (shared localOnly personal : Bool) (t : Target) : Bool :=
  shared && !localOnly && !personal && writeScope t

/-- The checks on a chosen target: conflict, deliverable, offending hit. -/
def roCheck (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (t : Nat) : RODecision :=
  if res t = .conflict then .refuse
  else if deliverable (shared t) (localOnly t) (personal t) (res t) = false then .refuse
  else if offending t = true then .refuse
  else .write t

/-- `_remoteOnlyContext` followed by the offending-hit refusal. -/
def roGate (b : ROBind) (priv : Bool) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) : RODecision :=
  if b.blocked = true then .refuse
  else if priv = true then .refuse
  else match explicit.orElse (fun _ => b.folderScope) with
    | none => .refuse
    | some t => roCheck shared localOnly personal offending res t

theorem roCheck_write (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (t' t : Nat)
    (h : roCheck shared localOnly personal offending res t' = .write t) :
    t' = t ∧ deliverable (shared t') (localOnly t') (personal t') (res t') = true ∧ offending t' = false := by
  unfold roCheck at h
  by_cases h1 : res t' = .conflict
  · simp [h1] at h
  · by_cases h2 : deliverable (shared t') (localOnly t') (personal t') (res t') = true
    · by_cases h3 : offending t' = true
      · simp [h1, h2, h3] at h
      · simp [h1, h2, h3] at h
        exact ⟨h, h2, by simpa using h3⟩
    · simp [h1, h2] at h

theorem roGate_write (b : ROBind) (priv : Bool) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (t : Nat)
    (h : roGate b priv explicit shared localOnly personal offending res = .write t) :
    b.blocked = false ∧ priv = false ∧ explicit.orElse (fun _ => b.folderScope) = some t ∧
      deliverable (shared t) (localOnly t) (personal t) (res t) = true ∧ offending t = false := by
  unfold roGate at h
  by_cases hb : b.blocked = true
  · simp [hb] at h
  · by_cases hp : priv = true
    · simp [hb, hp] at h
    · simp only [hb, hp, if_false, Bool.false_eq_true] at h
      cases ho : explicit.orElse (fun _ => b.folderScope) with
      | none => rw [ho] at h; cases h
      | some t' =>
        rw [ho] at h
        obtain ⟨rfl, hd, hof⟩ := roCheck_write shared localOnly personal offending res t' t h
        exact ⟨by simpa using hb, by simpa using hp, rfl, hd, hof⟩

/-- Every write a remote-only folder accepts leaves through the router to one
writable server: it never stays on this machine. -/
theorem ro_write_is_sent (b : ROBind) (priv : Bool) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (t : Nat)
    (h : roGate b priv explicit shared localOnly personal offending res = .write t) :
    routeOf (res t) = .send := by
  obtain ⟨_, _, _, hd, _⟩ := roGate_write b priv explicit shared localOnly personal offending res t h
  apply (send_iff_writeScope _).mpr
  simp [deliverable] at hd
  exact hd.2

/-- …and it is a shared, non-local-only, non-personal scope with no offending hit. -/
theorem ro_write_is_team (b : ROBind) (priv : Bool) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (t : Nat)
    (h : roGate b priv explicit shared localOnly personal offending res = .write t) :
    shared t = true ∧ localOnly t = false ∧ personal t = false ∧ offending t = false := by
  obtain ⟨_, _, _, hd, hof⟩ := roGate_write b priv explicit shared localOnly personal offending res t h
  simp [deliverable] at hd
  exact ⟨hd.1.1.1, hd.1.1.2, hd.1.2, hof⟩

/-- An unreadable map or an unresolved folder writes nothing, an explicit team
scope included (re-audit of #1521, S-1). -/
theorem ro_blocked_refuses (b : ROBind) (hb : b.blocked = true) (priv : Bool) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) :
    roGate b priv explicit shared localOnly personal offending res = .refuse := by
  simp [roGate, hb]

/-- A private write is refused, never kept locally. -/
theorem ro_private_refuses (b : ROBind) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) :
    roGate b true explicit shared localOnly personal offending res = .refuse := by
  simp [roGate]

/-- A scope two servers claim is refused here too. -/
theorem ro_conflict_refuses (b : ROBind) (priv : Bool) (t : Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (hc : res t = .conflict) :
    roGate b priv (some t) shared localOnly personal offending res = .refuse := by
  simp [roGate, roCheck, Option.orElse, hc]

/-- With no explicit scope, the write goes to the folder's scope. -/
theorem ro_default_is_folder (b : ROBind) (priv : Bool)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) (t : Nat)
    (h : roGate b priv none shared localOnly personal offending res = .write t) :
    b.folderScope = some t := by
  obtain ⟨_, _, ho, _, _⟩ := roGate_write b priv none shared localOnly personal offending res t h
  simpa [Option.orElse] using ho

/-- Non-vacuity: the folder's team scope, served by one writable server, is written. -/
theorem ro_team_write :
    roGate ⟨false, some 7⟩ false none (fun _ => true) (fun _ => false) (fun _ => false) (fun _ => false)
      (fun _ => .remote true) = .write 7 := by decide

/-- Mutant (the S-1 bug): the blocked check dropped. An unreadable map then
writes an explicit team scope. Removing the first branch of `roGate` makes
`ro_blocked_refuses` fail to build. -/
def roGateNoBlock (b : ROBind) (priv : Bool) (explicit : Option Nat)
    (shared localOnly personal offending : Nat → Bool) (res : Nat → Target) : RODecision :=
  roGate { b with blocked := false } priv explicit shared localOnly personal offending res

theorem no_block_writes_when_blocked :
    roGateNoBlock ⟨true, none⟩ false (some 7) (fun _ => true) (fun _ => false) (fun _ => false) (fun _ => false)
      (fun _ => .remote true) = .write 7 := by decide

/-- The pre-merge rule: some writable url entry with exactly this scope. -/
def deliverableOld (es : List SEntry) (s : Nat) : Bool :=
  es.any (fun e => claims s e && !e.readonly)

/-- Counterexample on the pre-merge rule: two servers claim scope 7; the old
rule called it deliverable (the write would have been sent to whichever entry
the router met first), the resolver-based rule does not, and the gate refuses. -/
theorem old_deliverable_accepts_conflict :
    let es := [(⟨some 1, 7, false, none⟩ : SEntry), ⟨some 2, 7, false, none⟩]
    deliverableOld es 7 = true ∧
      deliverable true false false (resolveNP (fun _ => none) es 7) = false ∧
      roGate ⟨false, some 7⟩ false none (fun _ => true) (fun _ => false) (fun _ => false) (fun _ => false)
        (resolveNP (fun _ => none) es) = .refuse := by decide

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
