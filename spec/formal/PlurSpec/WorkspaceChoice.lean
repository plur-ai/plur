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

theorem ambiguous_write_refused : admitWrite .disagree none = false := rfl
theorem explicit_choice_allowed (d : Decision) (scope : Nat) : admitWrite d (some scope) = true := by
  cases d <;> rfl

def admitBatch (d : Decision) (scopes : List (Option Nat)) : Bool :=
  scopes.all (fun s => admitWrite d s)

theorem partial_batch_refused (scope : Nat) : admitBatch .disagree [some scope, none] = false := rfl
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
theorem unmatched_stays_local : localFallback true [] = true := rfl

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
