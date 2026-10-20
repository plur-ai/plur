/-!
# Save destination evidence (2026-10-19)

The presentation consumes actual delivery evidence from the returned object,
not the existence of a configured server. Folder and warning context can add
reasons to a local result but cannot turn it into a confirmed server save.
Core's existing delivery classifier and write protocol remain authoritative.
-/
namespace PlurSpec.SaveDestination

inductive Delivery where
  | remote | outbox | local
  deriving DecidableEq, Repr

inductive Message where
  | server | queued | laptop (hasReason : Bool)
  deriving DecidableEq, Repr

def render (delivery : Delivery) (localReason : Bool) : Message :=
  match delivery with
  | .remote => .server
  | .outbox => .queued
  | .local => .laptop localReason

theorem confirmed_only (d : Delivery) (r : Bool) :
    render d r = .server ↔ d = .remote := by cases d <;> simp [render]

theorem queued_never_confirmed (r : Bool) : render .outbox r ≠ .server := by simp [render]

theorem local_never_confirmed (r : Bool) : render .local r ≠ .server := by cases r <;> decide

def shown (quiet : Bool) (m : Message) : Bool :=
  match m with
  | .queued | .laptop true => true
  | _ => !quiet

theorem queued_visible_when_quiet : shown true (render .outbox false) = true := rfl
theorem local_reason_visible_when_quiet : shown true (render .local true) = true := rfl

def sessionResults (successful : List Delivery) : List Message :=
  successful.map (fun d => render d false)

theorem every_success_reported (successful : List Delivery) :
    (sessionResults successful).length = successful.length := by simp [sessionResults]

end PlurSpec.SaveDestination

/-! Cached session status (2026-10-19): presentation never probes the server.
The queue comes from the existing primary outbox reader; only pending pushes
are counted as waiting saves. A write warning supersedes a mapped target. -/
namespace PlurSpec.ServerSession

inductive Target where
  | mapped | localOnly | unknown
  deriving DecidableEq
inductive Status where
  | ready | notSynced | authFailed
  deriving DecidableEq
inductive Line where
  | savingToServer | localOnly | warning
  deriving DecidableEq

def line (status : Status) (target : Target) (writeWarning : Bool) : Line :=
  match status with
  | .notSynced | .authFailed => .warning
  | .ready => if writeWarning then .warning else
    match target with
    | .mapped => .savingToServer
    | .localOnly => .localOnly
    | .unknown => .warning

theorem not_synced_never_claims_server (t : Target) (w : Bool) :
    line .notSynced t w ≠ .savingToServer := by simp [line]
theorem write_warning_never_claims_server (s : Status) (t : Target) :
    line s t true ≠ .savingToServer := by cases s <;> simp [line]
theorem local_never_claims_server (s : Status) (w : Bool) :
    line s .localOnly w ≠ .savingToServer := by cases s <;> cases w <;> simp [line]

def waitingSaves (pendingPushes retirements : Nat) : Nat := pendingPushes
theorem retirements_not_counted (pushes before after : Nat) :
    waitingSaves pushes before = waitingSaves pushes after := rfl

end PlurSpec.ServerSession
