/-! Read-only server diagnostics (2026-10-19).
The six checks require evidence independently. Missing configuration, a restricted
queue view, or incomplete permission evidence cannot become a healthy result.
HTTP 503 proves authentication only for the authenticated scope-lookup error. -/
namespace PlurSpec.ServerDiagnostics

inductive Result | ok | fail | unknown deriving DecidableEq

structure Checks where
  reachable : Result
  key : Result
  keyFile : Result
  scopes : Result
  writes : Result
  queue : Result

def healthy (c : Checks) : Prop :=
  c.reachable = .ok ∧ c.key = .ok ∧ c.keyFile = .ok ∧ c.scopes = .ok ∧ c.writes = .ok ∧ c.queue = .ok

theorem healthy_requires_queue (c : Checks) (h : healthy c) : c.queue = .ok := h.2.2.2.2.2
theorem healthy_requires_writes (c : Checks) (h : healthy c) : c.writes = .ok := h.2.2.2.2.1
theorem unknown_queue_not_healthy (c : Checks) (h : c.queue = .unknown) : ¬ healthy c := by
  intro all; have := healthy_requires_queue c all; simp_all

def queueResult (complete nonempty : Bool) : Result :=
  if !complete then .unknown else if nonempty then .fail else .ok

theorem restricted_queue_unknown (nonempty : Bool) : queueResult false nonempty = .unknown := rfl
theorem visible_empty_queue_ok : queueResult true false = .ok := rfl
theorem visible_waiting_queue_fails : queueResult true true = .fail := rfl

def permissionResult (requested returned : Nat) (ordered typed writable : Bool) : Result :=
  if requested = 0 ∨ requested ≠ returned ∨ !ordered ∨ !typed then .unknown
  else if writable then .ok else .fail

theorem empty_answer_not_evidence : permissionResult 1 0 true true true = .unknown := rfl
theorem string_boolean_not_evidence : permissionResult 1 1 true false true = .unknown := rfl
theorem reordered_not_evidence : permissionResult 2 2 false true true = .unknown := rfl
theorem complete_permissions_ok : permissionResult 1 1 true true true = .ok := rfl

def writePath (clientWritable : Bool) (server : Result) : Result :=
  if clientWritable then server else .fail
theorem local_refusal_cannot_pass (server : Result) : writePath false server = .fail := rfl
theorem permitted_route_passes : writePath true .ok = .ok := rfl
-- Server permission alone used to hide a read-only or conflicting local route.
example : writePath false .ok ≠ .ok := by decide

def keyOn503 (authenticatedScopeFailure : Bool) : Result :=
  if authenticatedScopeFailure then .ok else .unknown
theorem proxy_outage_not_authentication : keyOn503 false = .unknown := rfl
theorem scope_outage_authenticated : keyOn503 true = .ok := rfl

-- The old vacuous aggregate would pass an incomplete result list.
example : ([] : List Bool).all id = true ∧ permissionResult 1 0 true true true ≠ .ok := by decide
example : healthy ⟨.ok, .ok, .ok, .ok, .ok, .ok⟩ := by repeat constructor

end PlurSpec.ServerDiagnostics
