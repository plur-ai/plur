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

-- Replayed counterexamples for the pre-integration behavior.
example : writeScope none none .absent 7 ≠ writeScope none none .local 7 := by decide
example : mayDial none none .absent ≠ mayDial none none .local := by decide
example : capturedWrite (.project 7) .local 0 ≠ writeScope none none .local 0 := by decide

end PlurSpec.GitFolder
