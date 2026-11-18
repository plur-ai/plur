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

/-- `uploadLocal`'s per-id preparation, branch for branch: what the row is
under the lock decides the case. -/
inductive Case | missing | onServer | noDest | queuedElsewhere | secret | eligible
  deriving DecidableEq

inductive Outcome | failed | alreadyOnServer | demotedSecret | sent
  deriving DecidableEq

/-- One id: the reported outcome, whether the primary store is written, and
whether the id joins the flush selection. -/
def prepareId (dryRun : Bool) : Case → Outcome × Bool × Bool
  | .missing | .noDest | .queuedElsewhere => (.failed, false, false)
  | .onServer => (.alreadyOnServer, false, false)
  | .secret => (.demotedSecret, !dryRun, false)
  | .eligible => if dryRun then (.sent, false, false) else (.sent, true, true)

/-- The whole call: ids written, ids selected (the flush runs only when this
is nonempty), and the reported outcomes. -/
def uploadRun (dryRun : Bool) (caseOf : Nat → Case) : List Nat → List Nat × List Nat × List Outcome
  | [] => ([], [], [])
  | id :: ids =>
    let (o, w, sel) := prepareId dryRun (caseOf id)
    let (ws, sels, os) := uploadRun dryRun caseOf ids
    (if w then id :: ws else ws, if sel then id :: sels else sels, o :: os)

/-- For every id list and every state of every row: a dry run writes no row and
selects nothing, so no flush runs; and it reports, id for id, the outcome a
real run reports at preparation. -/
theorem dry_run_no_mutation (caseOf : Nat → Case) (ids : List Nat) :
    (uploadRun true caseOf ids).1 = [] ∧ (uploadRun true caseOf ids).2.1 = [] ∧
    (uploadRun true caseOf ids).2.2 = (uploadRun false caseOf ids).2.2 := by
  induction ids with
  | nil => exact ⟨rfl, rfl, rfl⟩
  | cons id ids ih =>
    obtain ⟨h1, h2, h3⟩ := ih
    cases hc : caseOf id <;> simp [uploadRun, prepareId, hc, h1, h2, h3]

/-- Non-vacuity: the real run writes and selects an eligible id, and demotes a secret one. -/
theorem real_run_writes :
    uploadRun false (fun i => if i = 1 then .eligible else .secret) [1, 2] = ([1, 2], [1], [.sent, .demotedSecret]) := by
  decide

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

/- 2026-10-20: Upload selection, consent, privacy admission and queue creation are unchanged; the new outbox delivery identity checks apply after this model admits the write. -/
