/-! Enterprise initialization (2026-10-19). Orchestration accepts success only
after current scope discovery, a complete write check, a confirmed server save
and per-tool proof. Rollback requires a new key, proof no learn was attempted,
and the exact post-registration configuration bytes still present under lock.
Unknown delivery retains the key. These are decision rules, not a proof of
the filesystem, HTTP transport or child process implementation. -/
namespace PlurSpec.EnterpriseInit

/- A write receipt supplies before/after bytes under the config lock. Once
another writer interrupted the chain, later owned writes cannot make it safe. -/
def interruptedAfter (alreadyInterrupted beforeMatches : Bool) : Bool :=
  alreadyInterrupted || !beforeMatches
theorem interruption_is_sticky (m : Bool) : interruptedAfter true m = true := by simp [interruptedAfter]
theorem mismatched_write_interrupts (i : Bool) : interruptedAfter i false = true := by simp [interruptedAfter]
example : interruptedAfter false false = true := by decide

def rollback (newKey notAttempted snapshotMatches : Bool) : Bool :=
  newKey && notAttempted && snapshotMatches
theorem unknown_delivery_keeps_key (n s : Bool) : rollback n false s = false := by simp [rollback]
theorem reused_key_kept (a s : Bool) : rollback false a s = false := by simp [rollback]
theorem concurrent_config_preserved (n a : Bool) : rollback n a false = false := by simp [rollback]
example : rollback true true true = true ∧ rollback true false true = false := by decide
example : rollback true true false = false := by decide

def proven (version save ownRecall : Bool) : Bool := version && save && ownRecall
def cleanup (toolProven : Bool) : Bool := toolProven
theorem no_cleanup_without_proof : cleanup false = false := rfl
theorem no_recall_no_proof (v s : Bool) : proven v s false = false := by simp [proven]
theorem wrong_version_not_proven (s r : Bool) : proven false s r = false := by simp [proven]

def success (discoveryKnown writeCheckComplete serverSaved someProven allLocalToolsProven : Bool) : Bool :=
  discoveryKnown && writeCheckComplete && serverSaved && someProven && allLocalToolsProven
theorem unknown_discovery_not_success (w s p a : Bool) : success false w s p a = false := by simp [success]
theorem incomplete_check_not_success (d s p a : Bool) : success d false s p a = false := by simp [success]
theorem failed_save_not_success (d w p a : Bool) : success d w false p a = false := by simp [success]
theorem no_vacuous_tool_success (d w s a : Bool) : success d w s false a = false := by simp [success]
example : success true true true true true = true ∧ success false true true true true = false := by decide

def mayContactServer (startupTrustMatches : Bool) : Bool := startupTrustMatches
theorem restart_before_network : mayContactServer false = false := rfl
end PlurSpec.EnterpriseInit

/-! 2026-10-19: Legacy personal-store migration is an explicit installer
transition. JWT syntax is a classifier, never authentication; verified identity
comes from the new key's /me. Exactly one eligible route and a matching protected
backup are required. Generic different-key folding remains unchanged. -/
namespace PlurSpec.EnterpriseInit.Legacy
structure Evidence where
  optedIn : Bool
  sameEndpoint : Bool
  exactPersonal : Bool
  inlineJwt : Bool
  writable : Bool
  noOverrides : Bool
  uniqueRoute : Bool
  backupMatches : Bool
deriving DecidableEq
def migrate (e : Evidence) : Bool :=
  e.optedIn && e.sameEndpoint && e.exactPersonal && e.inlineJwt && e.writable && e.noOverrides && e.uniqueRoute && e.backupMatches
theorem explicit_only (e : Evidence) (h : e.optedIn = false) : migrate e = false := by simp [migrate, h]
theorem endpoint_bound (e : Evidence) (h : e.sameEndpoint = false) : migrate e = false := by simp [migrate, h]
theorem identity_bound (e : Evidence) (h : e.exactPersonal = false) : migrate e = false := by simp [migrate, h]
theorem ambiguous_preserved (e : Evidence) (h : e.uniqueRoute = false) : migrate e = false := by simp [migrate, h]
theorem changed_backup_refused (e : Evidence) (h : e.backupMatches = false) : migrate e = false := by simp [migrate, h]
theorem overrides_preserved (e : Evidence) (h : e.noOverrides = false) : migrate e = false := by simp [migrate, h]
def rotate (e : Evidence) (oldKey newKey : Nat) : Nat := if migrate e then newKey else oldKey
theorem refused_keeps_old (e : Evidence) (o n : Nat) (h : migrate e = false) : rotate e o n = o := by simp [rotate, h]
-- A JWT-shaped record alone does not authorize replacing another route.
example : migrate ⟨true, true, false, true, true, true, true, true⟩ = false := by decide
example : migrate ⟨true, true, true, true, true, true, true, false⟩ = false := by decide
example : migrate ⟨true, true, true, true, true, true, true, true⟩ = true := by decide
end PlurSpec.EnterpriseInit.Legacy

/-! 2026-10-19: Keep the pre-provisioning stdin flag hidden in public help,
as the existing binary contract requires. Parsing and execution are unchanged. -/

/-! 2026-10-20: The rerun hello relation removes only the personal store's
current or legacy display namespace before sending the previous id. The
configuration/recall id remains unchanged; delivery and recall provenance
checks, trust admission, and the previous hello's active state are unchanged. -/
