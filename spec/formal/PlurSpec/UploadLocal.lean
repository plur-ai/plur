/-! Explicit primary-store upload (2026-10-19).
The caller selects ids; preparation rechecks active primary rows and the
current writable route under lock. Durable retries preserve their write key.
The shared outbox applies its route and sensitivity gates again. Upload's
selection restricts pushes and retirements, never the authorization rules. -/
namespace PlurSpec.UploadLocal

def prepare (primary active writable personalAllowed : Bool) : Bool :=
  primary && active && writable && personalAllowed
theorem secondary_excluded (a w p : Bool) : prepare false a w p = false := by simp [prepare]
theorem readonly_excluded (p a b : Bool) : prepare p a false b = false := by simp [prepare]
theorem remote_only_excluded (p a w : Bool) : prepare p a w false = false := by simp [prepare]

def attempt (selected routeAllowed sensitive : Bool) : Bool := selected && routeAllowed && !sensitive
theorem unselected_never_sent (r s : Bool) : attempt false r s = false := by simp [attempt]
theorem secrets_never_sent (s r : Bool) : attempt s r true = false := by simp [attempt]
theorem no_route_never_sent (s c : Bool) : attempt s false c = false := by simp [attempt]

def retryKey (old : Option Nat) (fresh : Nat) : Nat := old.getD fresh
theorem retries_keep_key (old fresh : Nat) : retryKey (some old) fresh = old := rfl

def mutate (dryRun : Bool) : Bool := !dryRun
theorem dry_run_no_mutation : mutate true = false := rfl

inductive Receipt | sent | duplicate | reviewHeld deriving DecidableEq
def receipt (review duplicate : Bool) : Receipt :=
  if review then .reviewHeld else if duplicate then .duplicate else .sent
theorem review_never_live (duplicate : Bool) : receipt true duplicate = .reviewHeld := rfl
theorem dedup_named : receipt false true = .duplicate := rfl

def confirmed (accepted localRowChanged : Bool) : Bool := accepted && !localRowChanged
theorem cancellation_not_success (accepted : Bool) : confirmed accepted true = false := by simp [confirmed]
def resolvedSupersedes (serverIdKnown targetQueued : Bool) : Bool := serverIdKnown || !targetQueued
theorem unselected_queued_target_waits : resolvedSupersedes false true = false := rfl

def discover (explicit : Option Bool) (env : Option Bool) (enterprise : Bool) : Bool :=
  explicit.getD (env.getD (!enterprise))
theorem enterprise_default_off : discover none none true = false := rfl
theorem caller_choice_wins (env : Option Bool) (enterprise choice : Bool) : discover (some choice) env enterprise = choice := rfl
example : attempt true true false = true ∧ attempt false true false = false := by decide
end PlurSpec.UploadLocal
