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
selection predicate (`_outbox && status !== 'retired'`). -/

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
and the flush merge-back filter). -/

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

/-! ### 1b. Two pushers, one row: at most one successful delivery

Pushers: `L` = learn()'s fire-and-forget push (in flight from the moment the
row is written), `F` = a flushOutbox() that snapshots while L may be active.
`guarded` = the fix: F selects only rows not in `_outboxInFlight`, and claims
what it selects. A finished push that succeeds is one delivery to the remote
(the POST was on the wire whatever the local state) and hands the row off. -/

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
flush delivers the engram to the remote at most once. -/
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

/-! ## 2. Invariant `_outbox ⇒ scope = _outbox.target_scope` (core-index#3)

Code: `updateEngram()` local branch (writes the caller's row, `scope`
included, leaves `_outbox`), `applyMutation` in cross-scope recurrence
(`isSharedScope(e.scope) ⇒ e.scope := 'global'`), `rescope()` local route
(drops `_outbox`), and the flush push (POST body `scope: engram.scope` to the
store of `_outbox.target_scope`). Scopes are an abstract type. -/

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
oracles. -/

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
Classification predicates and the scanner are oracles. -/

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
from `structured_data._scopeSource`, which `updateEngram` lets a caller set. -/

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
Resolved visibility defaults to private (#401, schema default). -/

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
(#794 F1). Readonly: `_assertWritable()` at the top of each public mutator. -/

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
succeeds, throws (store unwritable), or finds the row gone/already retired. -/

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
