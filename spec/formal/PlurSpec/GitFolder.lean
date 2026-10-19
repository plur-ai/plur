/-!
# Git-origin folder integration (2026-10-19)

GitScope proves the pure mapping. This model covers its admission into folder
policy and the captured default used by writes and remote recall. `guarded`
represents off, remote-only, malformed/untrusted maps, explicit ask, or an
existing scope. Such policies never reach the git reader. Local/unknown means
local, never auto-routing. Explicit call and session choices still win.

Git execution, canonicalization and cache invalidation are integration-tested;
the model assumes their returned origin and mapping. Each public operation
captures its git default with the existing binding before any await.
-/
namespace PlurSpec.GitFolder

inductive Default where
  | absent | local | project (scope : Nat)
  deriving DecidableEq, Repr

def applyOrigin (guarded hasSources : Bool) (previous origin : Default) : Default :=
  if guarded || !hasSources then previous else
    match origin with
    | .absent => previous
    | other => other

theorem guarded_unchanged (sources : Bool) (previous origin : Default) :
    applyOrigin true sources previous origin = previous := by simp [applyOrigin]

theorem no_server_unchanged (guarded : Bool) (previous origin : Default) :
    applyOrigin guarded false previous origin = previous := by simp [applyOrigin]

theorem not_git_unchanged (guarded sources : Bool) (previous : Default) :
    applyOrigin guarded sources previous .absent = previous := by
  cases guarded <;> cases sources <;> simp [applyOrigin]

theorem local_stays_local : applyOrigin false true .absent .local = .local := rfl

def writeScope (explicit session : Option Nat) (git : Default) (automatic : Nat) : Nat :=
  match explicit, session, git with
  | some s, _, _ => s
  | none, some s, _ => s
  | none, none, .project s => s
  | none, none, .local => 0
  | none, none, .absent => automatic

theorem explicit_wins (s automatic : Nat) (session : Option Nat) (git : Default) :
    writeScope (some s) session git automatic = s := rfl

theorem local_blocks_automatic (automatic : Nat) :
    writeScope none none .local automatic = 0 := rfl

theorem mapped_default (s automatic : Nat) :
    writeScope none none (.project s) automatic = s := rfl

def mayDial (explicit session : Option Nat) (git : Default) : Bool :=
  match explicit, session, git with
  | none, none, .local => false
  | _, _, _ => true

theorem local_no_remote : mayDial none none .local = false := rfl

def capturedWrite (captured _current : Default) (automatic : Nat) : Nat :=
  writeScope none none captured automatic

theorem rebind_does_not_retarget (captured before after : Default) (automatic : Nat) :
    capturedWrite captured before automatic = capturedWrite captured after automatic := rfl

-- Adapter composition: restrictive decisions apply across all paths, but
-- ordinary defaults come from editor roots, not an unrelated startup cwd.
def workspaceDefault (restricted : Option Default) (editor startup : Default) : Default :=
  restricted.getD editor

theorem editor_local_survives_startup (startup : Default) :
    workspaceDefault none .local startup = .local := rfl

-- A refreshed workspace replaces the earlier snapshot before core admission.
-- None is a blocked lookup, not permission to reuse the previous default.
def refreshWrite (_previous : Default) (current : Option Default) (automatic : Nat) : Option Nat :=
  current.map (fun git => writeScope none none git automatic)

theorem refreshed_local_stays_local (previous : Default) (automatic : Nat) :
    refreshWrite previous (some .local) automatic = some 0 := rfl

theorem failed_refresh_blocks (previous : Default) (automatic : Nat) :
    refreshWrite previous none automatic = none := rfl

-- Replayed counterexamples for the pre-integration behavior.
example : writeScope none none .absent 7 ≠ writeScope none none .local 7 := by decide
example : mayDial none none .absent ≠ mayDial none none .local := by decide
example : capturedWrite (.project 7) .local 0 ≠ writeScope none none .local 0 := by decide

end PlurSpec.GitFolder

/- 2026-10-19: Save destination reporting is a projection of the existing delivery
evidence. It changes no routing, persistence, scope authorization or outbox rule;
the model remains valid. Presentation invariants live in SaveDestination.lean. -/

/- 2026-10-19: serverSessionLines reads cached configuration and the existing
primary outbox projection. It does not probe, route, deliver or mutate memory.
These transition invariants still hold; status precedence is in SaveDestination. -/

/-! Checked 2026-10-19: initial-session cached server status and hook-run timestamps
add presentation/diagnostic metadata only. Existing admission, persistence and
write rules are unchanged. SaveDestination.SessionStatusAdapter models workspace
status selection; real hook and stdio tests check adapter integration. -/

/-! Checked 2026-10-19 for credential-change retry: Outbox section 8c models
known-key backoff bypass and the local-path takeover hold. Other write guards,
claims, idempotency and merge-back remain unchanged; the extra queue field is
an attempted credential fingerprint only. Enterprise recovery text changes no
recall, authorization or adapter admission rule. -/
