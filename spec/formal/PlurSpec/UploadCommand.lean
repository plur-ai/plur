/-! Explicit upload CLI (2026-10-19). A preview opens a readonly engine with
auto-discovery disabled. Sending requires affirmative consent, an active
primary candidate, its exact configured writable scope, and selection.
Core rechecks the route and sensitivity under lock before delivery. -/
namespace PlurSpec.UploadCommand
def send (consent candidate authorized selected : Bool) : Bool :=
  consent && candidate && authorized && selected
theorem preview_never_sends (c a s : Bool) : send false c a s = false := by simp [send]
theorem unselected_stays (y c a : Bool) : send y c a false = false := by simp [send]
theorem unauthorized_stays (y c s : Bool) : send y c false s = false := by simp [send]
theorem unknown_stays (y a s : Bool) : send y false a s = false := by simp [send]
example : send true true true true = true ∧ send false true true true = false := by decide

inductive Outcome | sent | duplicate | queued | held | sensitive | failed deriving DecidableEq
def delivered : Outcome → Bool | .sent | .duplicate => true | _ => false
theorem held_not_delivered : delivered .held = false := rfl
theorem queued_not_delivered : delivered .queued = false := rfl
theorem sensitive_not_delivered : delivered .sensitive = false := rfl
theorem failed_not_delivered : delivered .failed = false := rfl
end PlurSpec.UploadCommand

/-! 2026-10-19: the initializer's candidate count now resolves each advertised
scope through the same unambiguous writable-remote filter as the upload command.
This only narrows the preview count; no send or consent rule changes. -/
