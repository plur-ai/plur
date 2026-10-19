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

/-! Session adapters (2026-10-19): the admitted workspace policy is supplied
to the cached reader. No adapter falls back to process cwd after admission.
The only override is an explicit session default, which also controls writes.
This model assumes the existing gate and resolver supplied that policy. -/
namespace PlurSpec.SessionStatusAdapter

def target (admitted : Nat) (explicit : Option Nat) : Nat :=
  explicit.getD admitted

theorem admitted_without_override (admitted : Nat) : target admitted none = admitted := rfl
theorem explicit_wins (admitted selected : Nat) : target admitted (some selected) = selected := rfl

def showLine (initial rehydration : Bool) : Bool := initial && !rehydration

theorem no_ordinary_prompt : showLine false false = false := rfl
theorem no_rehydration (initial : Bool) : showLine initial true = false := by cases initial <;> rfl
theorem initial_shown : showLine true false = true := rfl

-- The former process-cwd choice could report a remote target (1) for a
-- local editor root (0). The admitted-policy projection rejects that claim.
example : target 0 none ≠ 1 := by decide

def afterRefresh (_previous : Option Nat) (resolved : Option Nat) : Option Nat :=
  match resolved with
  | none => none
  | some destination => some destination

theorem failed_refresh_clears (previous : Option Nat) : afterRefresh previous none = none := rfl

def memoryAfterStatus (memory : List Nat) (_statusAvailable : Bool) : List Nat := memory

theorem status_failure_keeps_memory (memory : List Nat) : memoryAfterStatus memory false = memory := rfl

def statusScope (restricted : Option Nat) (explicit : Option Nat) (admitted : Nat) : Nat :=
  restricted.getD (target admitted explicit)

theorem restriction_wins (scope admitted : Nat) (explicit : Option Nat) :
    statusScope (some scope) explicit admitted = scope := rfl

end PlurSpec.SessionStatusAdapter

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

/-! Checked 2026-10-19: explicit map scopes, like Git defaults, must agree
across all editor roots before status can advertise a shared destination.
The adapter preserves remote-only precedence and caller-explicit defaults.
The conflicting-map-roots stdio regression exercises this boundary. -/

/-! Checked 2026-10-19 for credential-change retry: Outbox section 8c models
known-key backoff bypass and the local-path takeover hold. Other write guards,
claims, idempotency and merge-back remain unchanged; the extra queue field is
an attempted credential fingerprint only. Enterprise recovery text changes no
recall, authorization or adapter admission rule. -/

/- 2026-10-19: Read-only server diagnostics add bounded /me and write-check
requests, strict permission evidence, and explicit missing-evidence failures.
They do not change grants, memory, queue delivery or file permissions. Existing
write/routing invariants hold; ServerDiagnostics models report aggregation.
The discovery clock-skew constant is exported without changing its value. -/
/- 2026-10-19: Hook-run timestamps now respect off and unreadable-map refusal.
The cached server line and admitted workspace scope selection are unchanged;
the timestamp is diagnostic only and is never written on those refused paths. -/
