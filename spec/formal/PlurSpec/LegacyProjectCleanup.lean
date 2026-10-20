/-! Legacy project token cleanup (2026-10-19).
The helper edits only untracked regular files after a verified private backup
and an unchanged snapshot. Hooks require an enterprise registration and a
working folder. Tracking uncertainty, tracked files and symlinks never grant
permission. YAML equivalence checks protect unrelated settings. -/
namespace PlurSpec.LegacyProjectCleanup

structure Evidence where
  enterprise : Bool
  workingFolder : Bool
  regularFile : Bool
  untracked : Bool
  equivalentRemainder : Bool
  privateBackup : Bool
  unchanged : Bool

def mayEdit (e : Evidence) : Bool :=
  e.enterprise && e.workingFolder && e.regularFile && e.untracked &&
  e.equivalentRemainder && e.privateBackup && e.unchanged

theorem no_backup_no_edit (e : Evidence) (h : e.privateBackup = false) : mayEdit e = false := by simp [mayEdit, h]
theorem tracked_or_unknown_no_edit (e : Evidence) (h : e.untracked = false) : mayEdit e = false := by simp [mayEdit, h]
theorem changed_snapshot_no_edit (e : Evidence) (h : e.unchanged = false) : mayEdit e = false := by simp [mayEdit, h]
theorem symlink_no_edit (e : Evidence) (h : e.regularFile = false) : mayEdit e = false := by simp [mayEdit, h]
theorem disabled_no_edit (e : Evidence) (h : e.workingFolder = false) : mayEdit e = false := by simp [mayEdit, h]
theorem personal_install_unchanged (e : Evidence) (h : e.enterprise = false) : mayEdit e = false := by simp [mayEdit, h]
theorem unrelated_settings_preserved (e : Evidence) (h : e.equivalentRemainder = false) : mayEdit e = false := by simp [mayEdit, h]

-- Counterexample to deleting as soon as legacy fields are found.
example : mayEdit ⟨true, true, true, true, true, false, true⟩ = false := rfl
example : mayEdit ⟨true, true, true, true, true, true, true⟩ = true := rfl
end PlurSpec.LegacyProjectCleanup
