/-! Workspace destination choice (2026-10-19).
The adapter resolves current roots once at write admission. A disagreement
refuses unscoped writes before the core can apply a session or local default.
The legacy single-scope wrapper remains unchanged. Recall context affects
organization affinity only; authorization and explicit scope still bound it. -/
namespace PlurSpec.WorkspaceChoice

inductive Decision | none | agreed (scope : Nat) | disagree deriving DecidableEq

def admitWrite (decision : Decision) (explicit : Option Nat) : Bool :=
  match decision, explicit with
  | .disagree, none => false
  | _, _ => true

/-- Over every decision and every call: a write is refused exactly when the
roots disagree and the call names no scope. -/
theorem ambiguous_write_refused (d : Decision) (explicit : Option Nat) :
    admitWrite d explicit = false ↔ (d = .disagree ∧ explicit = none) := by
  cases d <;> cases explicit <;> simp [admitWrite]
theorem explicit_choice_allowed (d : Decision) (scope : Nat) : admitWrite d (some scope) = true := by
  cases d <;> rfl

def admitBatch (d : Decision) (scopes : List (Option Nat)) : Bool :=
  scopes.all (fun s => admitWrite d s)

/-- `plur_learn_batch` admits the whole call once (`_writeSession` with
`explicitDestinations` = every item names a scope) before any item is written. -/
def batchWrites (d : Decision) (items : List (Option Nat)) : List (Option Nat) :=
  if admitBatch d items then items else []

/-- For every batch: with disagreeing roots it is refused exactly when some item
names no scope, and then nothing in it is written, not even the items that
name one. -/
theorem partial_batch_refused (items : List (Option Nat)) :
    (admitBatch .disagree items = false ↔ none ∈ items) ∧
    (none ∈ items → batchWrites .disagree items = []) := by
  have key : admitBatch .disagree items = false ↔ none ∈ items := by
    induction items with
    | nil => simp [admitBatch]
    | cons x xs ih =>
      cases x <;> simp_all [admitBatch, admitWrite]
  exact ⟨key, fun h => by simp [batchWrites, key.mpr h]⟩
theorem explicit_batch_allowed (a b : Nat) : admitBatch .disagree [some a, some b] = true := rfl

-- Unknown outer batch fields never choose destinations for individual items.
def admitBatchRequest (d : Decision) (_outerScope : Option Nat) (items : List (Option Nat)) : Bool :=
  admitBatch d items
theorem outer_scope_cannot_bypass (outer : Option Nat) :
    admitBatchRequest .disagree outer [none] = false := rfl

-- A conflicting Git workspace cannot inherit the first root's default.
def gitDefault (agreed : Bool) (first : Option Nat) : Option Nat :=
  if agreed then first else none
theorem conflicting_git_has_no_default (first : Option Nat) : gitDefault false first = none := rfl

-- Nonempty root context survives the aggregate Git-local fallback. A lone
-- unmatched root has no context and retains its local privacy boundary.
def localFallback (gitLocal : Bool) (contexts : List Nat) : Bool := gitLocal && contexts.isEmpty
theorem context_survives (org : Nat) (rest : List Nat) : localFallback true (org :: rest) = false := rfl
/-- The Git default `_startRemoteRecall` reads when nothing else chooses. -/
inductive GitScope | none | local | scope (s : Nat)

/-- `_startRemoteRecall`'s privacy gate: `none` = no remote dial; otherwise the
dial scope. A local/unknown Git default suppresses the dial only when no
explicit scope, no root context, no session scope and no remote-only binding
chose otherwise. -/
def recallGate (remoteOnly : Bool) (scope : Option Nat) (contexts : List Nat)
    (session : Option Nat) (git : GitScope) : Option (Option Nat) :=
  if !remoteOnly && scope.isNone && contexts.isEmpty && session.isNone then
    match git with
    | .local => Option.none
    | .scope s => some (some s)
    | .none => some scope
  else some scope

/-- The root context MCP passes (`_readContextScopes`): the scopes of the roots. -/
def rootContexts (roots : List (Option Nat)) : List Nat := roots.filterMap id

/-- Over every input: recall is kept on this machine exactly when the Git
default is local and nothing else chose a destination; so a workspace whose
roots all map to no scope (a lone unmatched root) stays local. -/
theorem unmatched_stays_local (remoteOnly : Bool) (scope : Option Nat) (roots : List (Option Nat))
    (session : Option Nat) (git : GitScope) :
    (recallGate remoteOnly scope (rootContexts roots) session git = Option.none ↔
      (remoteOnly = false ∧ scope = Option.none ∧ rootContexts roots = [] ∧
        session = Option.none ∧ git = .local)) ∧
    ((∀ r ∈ roots, r = Option.none) → rootContexts roots = []) := by
  constructor
  · cases remoteOnly <;> cases scope <;> cases session <;> cases git <;>
      cases h : rootContexts roots <;> simp [recallGate, h]
  · intro h
    simp only [rootContexts, List.filterMap_eq_nil_iff]
    intro a ha; simp [h a ha]

def context (explicit : Option Nat) (rootOrgs : List Nat) : List Nat :=
  match explicit with
  | some org => [org]
  | none => rootOrgs

def dial (authorized : Bool) (explicit : Option Nat) (rootOrgs : List Nat) (org : Nat) : Bool :=
  authorized && (context explicit rootOrgs).contains org

theorem unauthorized_never_dialed (explicit : Option Nat) (roots : List Nat) (org : Nat) :
    dial false explicit roots org = false := by simp [dial]
theorem unscoped_uses_root_orgs (roots : List Nat) (org : Nat) :
    dial true none roots org = roots.contains org := rfl
theorem explicit_overrides_roots (roots : List Nat) : dial true (some 1) roots 2 = false := rfl
example : dial true none [1, 2] 1 = true ∧ dial true none [1, 2] 2 = true ∧ dial true none [1, 2] 3 = false := by decide

-- The old fallback saved locally despite two different destinations.
example : admitWrite .none none = true ∧ admitWrite .disagree none = false := by decide

end PlurSpec.WorkspaceChoice

/-! 2026-10-19: Core re-exports the existing server-entry schema so legacy
project cleanup can validate a raw explicit enterprise registration without
inventing authorization through normalization. No engine behavior changes. -/

/-! 2026-10-19: Explicit primary upload reuses the locked queue and guarded
flush with a selected-id filter. Existing route, sensitivity, binding and
retirement invariants remain in force. UploadLocal models the new admission,
selection, dry-run and receipt rules. Held receipts are never cached as live. -/

/- 2026-10-20: Workspace agreement, explicit-scope precedence and remote-read admission are unchanged; the patch changes queued-write acknowledgment and refusal retry only. -/
