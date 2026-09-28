/-!
# PlurSpec.Persistence — sync, migrations, locks, backups, outbox order, packs

Models of `packages/core/src/{sync.ts, migrations/runner.ts, store/async-lock.ts,
storage-postgres.ts, backup.ts, outbox-order.ts, learn-async.ts, packs.ts}`.
Findings, verdicts and replays: `spec/formal/findings/persistence.md`.

Payloads (engram records, YAML bytes, git merges) are abstract: every theorem holds
for every record type, keep-predicate and merge oracle satisfying the stated
hypotheses.
-/

namespace PlurSpec.Persistence

/-! ## 1. Git sync (sync.ts `sync` State 3, `pullRebase`, `holdWithheld`, `restoreWithheld`)

Three snapshots of `engrams.yaml`: the working tree `W`, `HEAD`, and the remote.
`commitChanges` makes `HEAD = strip W` (the push-set filter, #396/#640). `git pull`
refuses when a file it must update is dirty (`W ≠ HEAD`). The remote merge is an
oracle `merge : List α → List α` (HEAD ↦ new HEAD).

Checked against round 2 (2026-09-27): UPDATED (verdict c). `pullFixed` and its
theorems below are the ROUND-1 model of `restoreWithheld`, which appended the held
records verbatim. Round 2 re-keys held records whose id the pull brought (owner
decision P1b, `rekeyHeldAgainstPulled`) and restores the saved bytes when the pulled
file fails the loader's shape rule; the current code is `pullR2` at the end of this
section (`r2_pulls`, `r2_no_loss`, `r2_no_leak`, `r2_rekey_no_loss`,
`r2_rekey_no_leak`), and id-level reachability after a collision is
`R2Persist.Restore.restore_both_reachable`.

Checked against the #1228 audit fixes (2026-09-27): UPDATED again. `pullR2` is a single
step, so it cannot see a sync killed half-way; the held records were in memory only and a
signal during the pull deleted them. Round 3 (`phasesNew`, `crash_safe`, `recover_no_loss`)
models the durable recovery file, and `pullR3` replaces `pullR2`'s unloadable branch, which
put the pre-pull file back under a HEAD holding the pulled one (`old_unloadable_reverts`).
The round-2 theorems stay true of the loadable branches, which round 3 did not change. -/
namespace Sync

variable {α : Type} (keep : α → Bool)

/-- `stageStrippedEngrams`: the committed blob keeps only the push set. -/
def strip (w : List α) : List α := w.filter keep

/-- Records the push set withholds (scope:local, or personal/private on `shared`). -/
def held (w : List α) : List α := w.filter (fun x => !keep x)

structure Tree (α : Type) where
  work : List α
  head : List α

/-- Before the fix: `git pull` on a tree whose tracked file differs from HEAD refuses
(`none` = "NOT pulled — still N commit(s) behind"). -/
def pullOld [DecidableEq α] (merge : List α → List α) (t : Tree α) : Option (Tree α) :=
  if t.work = t.head then some ⟨merge t.head, merge t.head⟩ else none

/-- The round-1 fix (superseded by `pullR2`): hold the withheld records in memory, reset the file to HEAD (clean
tree), pull, then restore — verbatim when the pull left the file alone, otherwise
the pulled file with the held records appended. -/
def pullFixed [DecidableEq α] (merge : List α → List α) (w : List α) : Tree α :=
  if merge (strip keep w) = strip keep w then ⟨w, merge (strip keep w)⟩
  else ⟨merge (strip keep w) ++ held keep w, merge (strip keep w)⟩

/-- **Counterexample (confirmed by replay).** After any commit, one withheld record
makes every pull refuse — forever, since nothing changes between retries. -/
theorem old_never_pulls [DecidableEq α] (merge : List α → List α) (w : List α)
    (x : α) (hx : x ∈ w) (hk : keep x = false) :
    pullOld merge ⟨w, strip keep w⟩ = none := by
  unfold pullOld
  have hne : w ≠ strip keep w := by
    intro heq
    have : ∀ a, a ∈ w → keep a = true := List.filter_eq_self.mp heq.symm
    rw [this x hx] at hk
    exact Bool.noConfusion hk
  simp [hne]

/-- Non-vacuity: with no withheld record the old code does pull. -/
theorem old_pulls_when_nothing_withheld [DecidableEq α] (merge : List α → List α)
    (w : List α) (hall : ∀ a, a ∈ w → keep a = true) :
    pullOld merge ⟨w, strip keep w⟩ = some ⟨merge w, merge w⟩ := by
  have : strip keep w = w := List.filter_eq_self.mpr hall
  simp [pullOld, this]

/-- Round-1 code: the pull always happens (HEAD is the merged remote). Current code: `r2_pulls`. -/
theorem fixed_pulls [DecidableEq α] (merge : List α → List α) (w : List α) :
    (pullFixed keep merge w).head = merge (strip keep w) := by
  unfold pullFixed; split <;> rfl

/-- Round-1 code (current code: `r2_no_loss`): no record of the working tree is lost, provided the merge keeps what
HEAD had (a merge that deletes a committed record is the remote's decision). -/
theorem fixed_no_loss [DecidableEq α] (merge : List α → List α) (w : List α)
    (hm : ∀ y, y ∈ strip keep w → y ∈ merge (strip keep w)) :
    ∀ x, x ∈ w → x ∈ (pullFixed keep merge w).work := by
  intro x hx
  unfold pullFixed
  split
  · exact hx
  · simp only [List.mem_append]
    cases hk : keep x
    · right; exact List.mem_filter.mpr ⟨hx, by simp [hk]⟩
    · left; exact hm x (List.mem_filter.mpr ⟨hx, hk⟩)

/-- Round-1 code (current code: `r2_no_leak`): nothing withheld leaks — the next commit's stripped blob is exactly the
pulled HEAD (no spurious commit, no withheld record in it), provided the remote only
ever carries push-set records. -/
theorem fixed_no_leak [DecidableEq α] (merge : List α → List α) (w : List α)
    (hr : ∀ y, y ∈ merge (strip keep w) → keep y = true) :
    strip keep (pullFixed keep merge w).work = (pullFixed keep merge w).head := by
  unfold pullFixed
  split
  · rename_i h; simp only [strip] at h ⊢; exact h.symm
  · simp only [strip, held, List.filter_append, List.filter_filter]
    have h1 : List.filter keep (merge (List.filter keep w)) = merge (List.filter keep w) :=
      List.filter_eq_self.mpr hr
    have h2 : List.filter (fun a => keep a && !keep a) w = [] := by
      simp
    rw [h1, h2, List.append_nil]

/-! ### Round 2 — owner decision P1b (2026-09-27): held records re-keyed against the pull

Current `restoreWithheld` (sync.ts after round 2) differs from `pullFixed` in two ways:
(1) in the changed-file branch the held records first pass through
`rekeyHeldAgainstPulled` — a held record whose id the pull brought gets a fresh id, an
exact copy of a pulled record is not appended twice; (2) a pulled file the loader
refuses (`engramStoreEntries` throws) gets the saved bytes back ("not pulled"). `rk` is
the re-keying as an oracle (pulled, held ↦ records appended), `loadable` the loader's
verdict on the pulled file. `pullFixed` above is the special case `rk = id`,
`loadable = true` (`r2_generalises`). The id-level reachability of both records after a
collision is `R2Persist.Restore.restore_both_reachable`; this section keeps the
round-1 guarantees (pull happens, nothing lost, nothing leaks) true of the current code. -/

def pullR2 [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (w : List α) : Tree α :=
  if merge (strip keep w) = strip keep w then ⟨w, merge (strip keep w)⟩
  else if loadable (merge (strip keep w)) then
    ⟨merge (strip keep w) ++ rk (merge (strip keep w)) (held keep w), merge (strip keep w)⟩
  else ⟨w, merge (strip keep w)⟩

theorem r2_generalises [DecidableEq α] (merge : List α → List α) (w : List α) :
    pullR2 keep merge (fun _ => true) (fun _ h => h) w = pullFixed keep merge w := by
  unfold pullR2 pullFixed; split <;> rfl

/-- Current code: the pull always happens. -/
theorem r2_pulls [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (w : List α) :
    (pullR2 keep merge loadable rk w).head = merge (strip keep w) := by
  unfold pullR2; split
  · rfl
  · split <;> rfl

/-- Current code: no record of the working tree is lost — each is in the result, or
represented there by a record `same` as it (the re-keyed copy: same engram, new id),
provided the re-keying covers every held record the pull did not bring. -/
theorem r2_no_loss [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (same : α → α → Prop) (w : List α)
    (hm : ∀ y, y ∈ strip keep w → y ∈ merge (strip keep w))
    (hcover : ∀ x, x ∈ held keep w → x ∈ merge (strip keep w) ∨
      ∃ y, y ∈ rk (merge (strip keep w)) (held keep w) ∧ same x y) :
    ∀ x, x ∈ w → x ∈ (pullR2 keep merge loadable rk w).work ∨
      ∃ y, y ∈ (pullR2 keep merge loadable rk w).work ∧ same x y := by
  intro x hx
  unfold pullR2
  split
  · exact Or.inl hx
  · split
    · simp only [List.mem_append]
      cases hk : keep x
      · rcases hcover x (List.mem_filter.mpr ⟨hx, by simp [hk]⟩) with h | ⟨y, hy, hs⟩
        · exact Or.inl (Or.inl h)
        · exact Or.inr ⟨y, Or.inr hy, hs⟩
      · exact Or.inl (Or.inl (hm x (List.mem_filter.mpr ⟨hx, hk⟩)))
    · exact Or.inl hx

set_option linter.deprecated false in
/-- Current code: nothing withheld leaks, provided the remote carries only push-set
records and the re-keying keeps held records held (it changes ids, never scope or
visibility). -/
theorem r2_no_leak [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (w : List α)
    (hr : ∀ y, y ∈ merge (strip keep w) → keep y = true)
    (hrk : ∀ y, y ∈ rk (merge (strip keep w)) (held keep w) → keep y = false)
    (hl : loadable (merge (strip keep w)) = true) :
    strip keep (pullR2 keep merge loadable rk w).work = (pullR2 keep merge loadable rk w).head := by
  unfold pullR2
  by_cases h : merge (strip keep w) = strip keep w
  · rw [if_pos h]; exact h.symm
  · rw [if_neg h, if_pos hl]
    simp only [strip, List.filter_append]
    have h1 : List.filter keep (merge (List.filter keep w)) = merge (List.filter keep w) :=
      List.filter_eq_self.mpr hr
    have h2 : List.filter keep (rk (merge (List.filter keep w)) (held keep w)) = [] := by
      rw [List.filter_eq_nil_iff]; intro y hy; simp [hrk y hy]
    rw [h1, h2, List.append_nil]

/-- Round-2 code (superseded by `pullR3`): a pulled file the loader refuses left the working
tree as it was — which is the revert `old_unloadable_reverts` exhibits. -/
theorem r2_unloadable_keeps_work [DecidableEq α] (merge : List α → List α)
    (loadable : List α → Bool) (rk : List α → List α → List α) (w : List α)
    (hl : loadable (merge (strip keep w)) = false) :
    (pullR2 keep merge loadable rk w).work = w := by
  unfold pullR2; split
  · rfl
  · simp [hl]

/-- `rekeyHeldAgainstPulled` on records `(id, content)`: an exact copy of a pulled
record is dropped, a held record whose id the pull brought gets `fr r`, the rest are
kept. (`R2Persist.Restore.restoreNew` is `pulled ++ rekey`.) -/
def rekey (fr : Nat × Nat → Nat) (pulled held : List (Nat × Nat)) : List (Nat × Nat) :=
  held.filterMap (fun r =>
    if r ∈ pulled then none else if r.1 ∈ pulled.map (·.1) then some (fr r, r.2) else some r)

/-- The re-keying covers every held record the pull did not bring: same content. -/
theorem rekey_cover (fr : Nat × Nat → Nat) (pulled held : List (Nat × Nat)) :
    ∀ x, x ∈ held → x ∈ pulled ∨ ∃ y, y ∈ rekey fr pulled held ∧ y.2 = x.2 := by
  intro x hx
  by_cases hp : x ∈ pulled
  · exact Or.inl hp
  · right
    by_cases hi : x.1 ∈ pulled.map (·.1)
    · exact ⟨(fr x, x.2), List.mem_filterMap.mpr ⟨x, hx, by simp [hp, hi]⟩, rfl⟩
    · exact ⟨x, List.mem_filterMap.mpr ⟨x, hx, by simp [hp, hi]⟩, rfl⟩

/-- The re-keying keeps held records held, when the push-set predicate ignores ids. -/
theorem rekey_keep (kp : Nat × Nat → Bool) (hk : ∀ a b : Nat × Nat, a.2 = b.2 → kp a = kp b)
    (fr : Nat × Nat → Nat) (pulled held : List (Nat × Nat)) (hh : ∀ x, x ∈ held → kp x = false) :
    ∀ y, y ∈ rekey fr pulled held → kp y = false := by
  intro y hy
  obtain ⟨x, hx, hmap⟩ := List.mem_filterMap.mp hy
  by_cases hp : x ∈ pulled
  · simp [hp] at hmap
  · by_cases hi : x.1 ∈ pulled.map (·.1)
    · simp only [hp, hi, ↓reduceIte, Option.some.injEq] at hmap
      subst hmap; rw [hk (fr x, x.2) x rfl]; exact hh x hx
    · simp only [hp, hi, ↓reduceIte, Option.some.injEq] at hmap
      subst hmap; exact hh x hx

/-- **Current code (P1b), no loss:** with the real re-keying, every working-tree record
survives the pull, or a record with its content does (under a fresh id). -/
theorem r2_rekey_no_loss (kp : Nat × Nat → Bool) (merge : List (Nat × Nat) → List (Nat × Nat))
    (loadable : List (Nat × Nat) → Bool) (fr : Nat × Nat → Nat) (w : List (Nat × Nat))
    (hm : ∀ y, y ∈ strip kp w → y ∈ merge (strip kp w)) :
    ∀ x, x ∈ w → x ∈ (pullR2 kp merge loadable (rekey fr) w).work ∨
      ∃ y, y ∈ (pullR2 kp merge loadable (rekey fr) w).work ∧ y.2 = x.2 :=
  r2_no_loss kp merge loadable (rekey fr) (fun x y => y.2 = x.2) w hm
    (fun x hx => rekey_cover fr _ _ x hx)

/-- **Current code (P1b), no leak:** with the real re-keying, the next commit's stripped
blob is exactly the pulled HEAD. -/
theorem r2_rekey_no_leak (kp : Nat × Nat → Bool) (hk : ∀ a b : Nat × Nat, a.2 = b.2 → kp a = kp b)
    (merge : List (Nat × Nat) → List (Nat × Nat)) (loadable : List (Nat × Nat) → Bool)
    (fr : Nat × Nat → Nat) (w : List (Nat × Nat))
    (hr : ∀ y, y ∈ merge (strip kp w) → kp y = true)
    (hl : loadable (merge (strip kp w)) = true) :
    strip kp (pullR2 kp merge loadable (rekey fr) w).work = (pullR2 kp merge loadable (rekey fr) w).head :=
  r2_no_leak kp merge loadable (rekey fr) w hr
    (rekey_keep kp hk fr _ _ (fun x hx => by simpa [held] using (List.mem_filter.mp hx).2)) hl

/-- Non-vacuity: records `(id, content)`, content ≥ 10 withheld. Local held `(2, 17)`;
the pull brings a different `(2, 8)`. The held record comes back as `(102, 17)`. -/
theorem r2_rekey_example :
    (pullR2 (fun r : Nat × Nat => decide (r.2 < 10)) (fun _ => [(1, 5), (2, 8)]) (fun _ => true)
      (rekey (fun r => 100 + r.1)) [(1, 5), (2, 17)]).work = [(1, 5), (2, 8), (102, 17)] := by
  decide

/-! ### Round 3 — audit of #1228 (2026-09-27): crash safety, and no revert of an unloadable pull

`pullR2` is a function: it says nothing about a sync that stops half-way. The code runs
it as a sequence of durable steps, and a signal can end the process after any of them
(`finally` does not run on SIGINT/SIGTERM/SIGKILL). `D` is what survives a crash: the
working file, HEAD, and the recovery file `.git/plur-held.json` (`hf`). What every
reader sees (`loadEngrams`) is `view`: the file plus the held records `rk` adds to it
(`mergeHeldRecords`: nothing already there, re-keyed on an id clash).

Round 2 kept the held records in process memory (`hf` always `[]`), so a crash after
the reset lost them (`old_crash_loses`). Round 3 writes `hf` before the reset and
clears it only after the restore (`phasesNew`); every crash point keeps every record
visible (`crash_safe`), and the recovery run (`recover`, which is the same restore)
puts them back in the file (`recover_no_loss`).

Also, `pullR2`'s unloadable branch put the PRE-pull working tree back while HEAD held
the pulled file, so the next commit (`strip work`) reverted the remote's change
(`old_unloadable_reverts`). Round 3 keeps the pulled file and leaves the held records in
`hf` (`unloadable_no_revert`, `unloadable_keeps_held`). -/

structure D (α : Type) where
  work : List α
  head : List α
  hf   : List α

/-- What every reader sees: the file plus the held records not already in it. -/
def view (rk : List α → List α → List α) (s : D α) : List α := s.work ++ rk s.work s.hf

/-- Round 2: durable states after each step of `pullRebase` (start, reset, pull,
restore); the held records exist only in memory. -/
def phasesOld (merge : List α → List α) (rk : List α → List α → List α) (w : List α) : List (D α) :=
  [⟨w, strip keep w, []⟩,
   ⟨strip keep w, strip keep w, []⟩,
   ⟨merge (strip keep w), merge (strip keep w), []⟩,
   ⟨merge (strip keep w) ++ rk (merge (strip keep w)) (held keep w), merge (strip keep w), []⟩]

/-- Round 3: the recovery file is written BEFORE the reset and deleted LAST. -/
def phasesNew (merge : List α → List α) (rk : List α → List α → List α) (w : List α) : List (D α) :=
  [⟨w, strip keep w, []⟩,
   ⟨w, strip keep w, held keep w⟩,
   ⟨strip keep w, strip keep w, held keep w⟩,
   ⟨merge (strip keep w), merge (strip keep w), held keep w⟩,
   ⟨merge (strip keep w) ++ rk (merge (strip keep w)) (held keep w), merge (strip keep w), held keep w⟩,
   ⟨merge (strip keep w) ++ rk (merge (strip keep w)) (held keep w), merge (strip keep w), []⟩]

/-- `recoverHeld` (next sync) and the next store write: the restore, then an empty `hf`. -/
def recover (rk : List α → List α → List α) (s : D α) : D α :=
  ⟨s.work ++ rk s.work s.hf, s.head, []⟩

/-- `x` is in `l`, or represented there by a record `same` as it. -/
def Has (same : α → α → Prop) (l : List α) (x : α) : Prop := x ∈ l ∨ ∃ y, y ∈ l ∧ same x y

/-- The re-keying covers the held records: each is already there, or added as a `same` copy. -/
def Covers (rk : List α → List α → List α) (same : α → α → Prop) : Prop :=
  ∀ cur h x, x ∈ h → x ∈ cur ∨ ∃ y, y ∈ rk cur h ∧ same x y

theorem has_mono (same : α → α → Prop) (l l' : List α) (x : α) (hs : ∀ y, y ∈ l → y ∈ l')
    (h : Has same l x) : Has same l' x := by
  rcases h with h | ⟨y, hy, hxy⟩
  · exact Or.inl (hs x h)
  · exact Or.inr ⟨y, hs y hy, hxy⟩

/-- A record of `w` survives in `cur ++ rk cur (held w)` whenever `cur` keeps the push set. -/
theorem restored_has (rk : List α → List α → List α) (same : α → α → Prop) (hc : Covers rk same)
    (w cur : List α) (hcur : ∀ y, y ∈ strip keep w → y ∈ cur) (x : α) (hx : x ∈ w) :
    Has same (cur ++ rk cur (held keep w)) x := by
  cases hk : keep x
  · rcases hc cur (held keep w) x (List.mem_filter.mpr ⟨hx, by simp [hk]⟩) with h | ⟨y, hy, hxy⟩
    · exact Or.inl (List.mem_append.mpr (Or.inl h))
    · exact Or.inr ⟨y, List.mem_append.mpr (Or.inr hy), hxy⟩
  · exact Or.inl (List.mem_append.mpr (Or.inl (hcur x (List.mem_filter.mpr ⟨hx, hk⟩))))

/-- **Round 3, crash safety:** whichever step a sync is killed after, every record of the
working tree is still visible to every reader — provided the merge keeps what HEAD had. -/
theorem crash_safe [DecidableEq α] (merge : List α → List α) (rk : List α → List α → List α)
    (same : α → α → Prop) (hc : Covers rk same) (w : List α)
    (hm : ∀ y, y ∈ strip keep w → y ∈ merge (strip keep w)) :
    ∀ s, s ∈ phasesNew keep merge rk w → ∀ x, x ∈ w → Has same (view rk s) x := by
  intro s hs x hx
  have sub : ∀ l r : List α, ∀ y, y ∈ l → y ∈ l ++ r := fun l r y h => List.mem_append.mpr (Or.inl h)
  have hstrip : ∀ y, y ∈ strip keep w → y ∈ strip keep w := fun _ h => h
  simp only [phasesNew, List.mem_cons, List.not_mem_nil, or_false] at hs
  rcases hs with rfl | rfl | rfl | rfl | rfl | rfl <;> simp only [view]
  · exact Or.inl (sub _ _ x hx)
  · exact Or.inl (sub _ _ x hx)
  · exact restored_has keep rk same hc w _ hstrip x hx
  · exact restored_has keep rk same hc w _ hm x hx
  · exact has_mono same _ _ x (sub _ _) (restored_has keep rk same hc w _ hm x hx)
  · exact has_mono same _ _ x (sub _ _) (restored_has keep rk same hc w _ hm x hx)

/-- **Round 3, recovery:** from any crash point, the recovery run leaves every record in
the FILE itself, and the recovery file empty. -/
theorem recover_no_loss [DecidableEq α] (merge : List α → List α) (rk : List α → List α → List α)
    (same : α → α → Prop) (hc : Covers rk same) (w : List α)
    (hm : ∀ y, y ∈ strip keep w → y ∈ merge (strip keep w)) :
    ∀ s, s ∈ phasesNew keep merge rk w → (∀ x, x ∈ w → Has same (recover rk s).work x) ∧ (recover rk s).hf = [] :=
  fun s hs => ⟨crash_safe keep merge rk same hc w hm s hs, rfl⟩

/-- `mergeHeldRecords` without an id clash: the held records the file does not already hold. -/
def rkPlain [DecidableEq α] (cur h : List α) : List α := h.filter (fun x => decide (x ∉ cur))

theorem rkPlain_covers [DecidableEq α] : Covers (rkPlain (α := α)) (· = ·) := by
  intro cur h x hx
  by_cases hin : x ∈ cur
  · exact Or.inl hin
  · exact Or.inr ⟨x, List.mem_filter.mpr ⟨hx, by simp [hin]⟩, rfl⟩

/-- **Counterexample (replayed: `formal-audit-persist-sync-crash.test.ts`, SIGINT/SIGTERM/
SIGKILL mid-pull).** Records are numbers, `0` is scope:local. Round 2 killed after the reset:
no reader sees the local record, and nothing on disk holds it. -/
theorem old_crash_loses :
    ∃ s, s ∈ phasesOld (fun x : Nat => decide (x ≠ 0)) id rkPlain [1, 0] ∧ 0 ∉ view rkPlain s := by
  refine ⟨⟨[1], [1], []⟩, by simp [phasesOld, strip, held], by simp [view, rkPlain]⟩

/-- Non-vacuity: the round-3 phases with the same input keep `0` visible at every step. -/
theorem new_crash_example :
    ∀ s, s ∈ phasesNew (fun x : Nat => decide (x ≠ 0)) id rkPlain [1, 0] → 0 ∈ view rkPlain s := by
  intro s hs
  simp only [phasesNew, strip, held, List.mem_cons, List.not_mem_nil, or_false] at hs
  rcases hs with rfl | rfl | rfl | rfl | rfl | rfl <;> simp [view, rkPlain]

/-- Round 3, unloadable pull: HEAD and the file keep the pulled version; the held records stay in `hf`. -/
def pullR3 [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (w : List α) : D α :=
  if merge (strip keep w) = strip keep w then ⟨w, merge (strip keep w), []⟩
  else if loadable (merge (strip keep w)) then
    ⟨merge (strip keep w) ++ rk (merge (strip keep w)) (held keep w), merge (strip keep w), []⟩
  else ⟨merge (strip keep w), merge (strip keep w), held keep w⟩

/-- **Counterexample (replayed: the bare-array case in `formal-audit-persist-sync-crash.test.ts`).**
Round 2 on an unloadable pull: the next commit's blob is the PRE-pull one while HEAD is
the pulled one — a revert of the remote's change, pushed on the next sync. -/
theorem old_unloadable_reverts :
    let r := pullR2 (fun x : Nat => decide (x ≠ 0)) (fun _ => [1, 2]) (fun _ => false) rkPlain [1, 0]
    strip (fun x : Nat => decide (x ≠ 0)) r.work ≠ r.head := by
  decide

set_option linter.deprecated false in
/-- **Round 3:** an unloadable pull is not reverted — the next commit's blob is HEAD —
provided the remote carries only push-set records. -/
theorem unloadable_no_revert [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (w : List α)
    (hr : ∀ y, y ∈ merge (strip keep w) → keep y = true)
    (hl : loadable (merge (strip keep w)) = false) :
    strip keep (pullR3 keep merge loadable rk w).work = (pullR3 keep merge loadable rk w).head := by
  unfold pullR3
  by_cases h : merge (strip keep w) = strip keep w
  · rw [if_pos h]; exact h.symm
  · have hl' : ¬ (loadable (merge (strip keep w)) = true) := by simp [hl]
    rw [if_neg h, if_neg hl']
    exact List.filter_eq_self.mpr hr

set_option linter.deprecated false in
/-- **Round 3:** and nothing is lost: every record is visible to readers (the held ones
through the recovery file), whatever the loader says. -/
theorem unloadable_keeps_held [DecidableEq α] (merge : List α → List α) (loadable : List α → Bool)
    (rk : List α → List α → List α) (same : α → α → Prop) (hc : Covers rk same) (w : List α)
    (hm : ∀ y, y ∈ strip keep w → y ∈ merge (strip keep w)) :
    ∀ x, x ∈ w → Has same (view rk (pullR3 keep merge loadable rk w)) x := by
  intro x hx
  have sub : ∀ l r : List α, ∀ y, y ∈ l → y ∈ l ++ r := fun l r y h => List.mem_append.mpr (Or.inl h)
  unfold pullR3
  by_cases h : merge (strip keep w) = strip keep w
  · rw [if_pos h]; simp only [view]; exact Or.inl (sub _ _ x hx)
  · rw [if_neg h]
    by_cases hl : loadable (merge (strip keep w)) = true
    · rw [if_pos hl]; simp only [view]
      exact has_mono same _ _ x (sub _ _) (restored_has keep rk same hc w _ hm x hx)
    · rw [if_neg hl]; simp only [view]; exact restored_has keep rk same hc w _ hm x hx

end Sync

/-! ## 2. Migration runner (migrations/runner.ts `runMigrations`, `rollbackMigrations`)

`createBackup` is no-clobber: an existing `.bak.<v>` is kept, whatever the live file
now holds. Each step is an oracle `σ → Option σ` (`none` = the step threw). Steps run
on an in-memory copy; the live file is written only after all succeed.

Checked against round 2 (2026-09-27): still holds because runner.ts still runs every
step in memory and writes nothing when one throws; round 2 only replaced the final
`saveEngrams` + `setSchemaVersion` pair with `saveAndStamp`, which restores the corpus
if the stamp fails — that later step is `R2Persist` §4 (`fixed_consistent`). -/
namespace Migration

variable {σ : Type}

/-- Run the steps in memory: `none` as soon as one throws. -/
def runSteps : List (σ → Option σ) → σ → Option σ
  | [], s => some s
  | m :: ms, s => match m s with
    | none => none
    | some s' => runSteps ms s'

structure Disk (σ : Type) where
  live : σ
  bak : Option σ

/-- No-clobber backup: keep an existing one. -/
def backup (d : Disk σ) : σ := d.bak.getD d.live

/-- Before the fix: on failure, copy the backup over the live file. -/
def runOld (steps : List (σ → Option σ)) (d : Disk σ) : Disk σ :=
  let b := backup d
  match runSteps steps d.live with
  | none => ⟨b, some b⟩
  | some s => ⟨s, some b⟩

/-- The fix: on failure, write nothing. -/
def runFixed (steps : List (σ → Option σ)) (d : Disk σ) : Disk σ :=
  let b := backup d
  match runSteps steps d.live with
  | none => ⟨d.live, some b⟩
  | some s => ⟨s, some b⟩

/-- **Counterexample (confirmed by replay: 3 engrams → 1).** A stale backup plus a
failing step replaces the live store. -/
theorem old_failed_run_replaces_live :
    (runOld (σ := Nat) [fun _ => none] ⟨3, some 1⟩).live = 1 := rfl

/-- Fixed: a failed run leaves the live file identical, for every backup state. -/
theorem fixed_failed_run_keeps_live (steps : List (σ → Option σ)) (d : Disk σ)
    (hfail : runSteps steps d.live = none) :
    (runFixed steps d).live = d.live := by
  simp [runFixed, hfail]

/-- Non-vacuity: a successful run writes the migrated corpus. -/
theorem fixed_success_writes (steps : List (σ → Option σ)) (d : Disk σ) (s : σ)
    (hok : runSteps steps d.live = some s) :
    (runFixed steps d).live = s := by
  simp [runFixed, hok]

/-- The backup is still taken (kept for manual recovery), unchanged by the fix. -/
theorem fixed_keeps_backup (steps : List (σ → Option σ)) (d : Disk σ) :
    (runFixed steps d).bak = some (backup d) := by
  unfold runFixed; split <;> rfl

end Migration

/-! ## 3. File lock steal (store/async-lock.ts `stealLock`; sync twin `stealLockSync`)

Processes are `Nat`s. `lock` is the token in `<file>.lock` (the holder's id). A
process is `dead` (liveness probe = false) forever and never acts. `hold p` = p is in
the critical section. `claim p = some (h, x)`: p renamed the lock aside, having judged
`h` stale; the moved file actually carried `x`.

Checked against round 2 (2026-09-27): SUPERSEDED (verdict b). This is the ROUND-1
model of the ROUND-1 code: ONE steal guard file (`<lock>.steal`), in a model where a
process holding the guard never dies (`gAcq` needs `dead p = false` and nothing ever
removes a guard it does not own). The round-1 code did remove a guard abandoned by a
crashed stealer, by an unguarded read-then-unlink, and that double fault reopened the
two-holder race — outside this model. Round 2 replaced the guard with a ladder of
slots keyed by the judged token (`acquireStealSlot`, `clearStealSlots`, sync twin
`stealLockSync`); the current code, crashes included, is
`R2Persist.Guard.ladder_mutex` / `ladder_guard_excl` / `ladder_recovers`.
`fixed_mutex` below is a claim about the single-guard protocol only; `old_two_holders`
stays as the record of the pre-guard race. -/
namespace Lock

def upd {β : Type} (f : Nat → β) (p : Nat) (v : β) : Nat → β :=
  fun q => if q = p then v else f q

structure LS where
  lock  : Option Nat
  hold  : Nat → Bool
  guard : Option Nat
  seen  : Nat → Option Nat
  claim : Nat → Option (Nat × Nat)

/-- `claimAndRemove` tail: unlink when the moved file is the stale one, otherwise
put it back with `wx` (only if the path is still empty). -/
def finishLock (s : LS) (h x : Nat) : Option Nat :=
  if x = h then s.lock else (if s.lock = none then some x else s.lock)

/-! ### Before the fix: no guard, the judgement `seen` may be arbitrarily old. -/

inductive Act where
  | acq (p : Nat) | rel (p : Nat) | judge (p h : Nat) | rename (p : Nat) | finish (p : Nat)

/-- Old protocol, executable. `judge p h`: p observed stale `h` at `lock` (liveness
false). `rename p`: moves WHATEVER is at `lock` now. -/
def stepOld (dead : Nat → Bool) (s : LS) : Act → Option LS
  | .acq p => if dead p = false ∧ s.lock = none then
      some { s with lock := some p, hold := upd s.hold p true } else none
  | .rel p => if s.hold p = true then
      some { s with hold := upd s.hold p false, lock := if s.lock = some p then none else s.lock } else none
  | .judge p h => if dead p = false ∧ dead h = true ∧ s.lock = some h then
      some { s with seen := upd s.seen p (some h) } else none
  | .rename p => match s.seen p, s.lock with
      | some h, some x => some { s with claim := upd s.claim p (some (h, x)), lock := none,
                                        seen := upd s.seen p none }
      | _, _ => none
  | .finish p => match s.claim p with
      | some (h, x) => some { s with lock := finishLock s h x, claim := upd s.claim p none }
      | none => none

def runOld (dead : Nat → Bool) : LS → List Act → Option LS
  | s, [] => some s
  | s, a :: as => match stepOld dead s a with
    | some s' => runOld dead s' as
    | none => none

def init0 : LS := ⟨some 9, fun _ => false, none, fun _ => none, fun _ => none⟩
def dead9 : Nat → Bool := fun p => p == 9

/-- **Counterexample (confirmed by replay, `formal-persistence-lock.test.ts`).**
H=9 is dead. A=1 and B=2 both judge it stale; A claims, confirms and acquires; B's
rename moves A's live lock aside; C=3 O_EXCL-acquires; B's put-back loses. A and C
are both in the critical section. -/
theorem old_two_holders :
    (runOld dead9 init0
      [.judge 1 9, .judge 2 9, .rename 1, .finish 1, .acq 1, .rename 2, .acq 3, .finish 2]).map
      (fun s => (s.hold 1, s.hold 3)) = some (true, true) := by decide

/-! ### The round-1 fix (single guard, no crash inside it): a guard serializes stealers,
and the lock is re-read under it. Superseded by the round-2 ladder, `R2Persist` §1. -/

inductive FStep (dead : Nat → Bool) : LS → LS → Prop
  | acq (p : Nat) (s : LS) : dead p = false → s.lock = none →
      FStep dead s { s with lock := some p, hold := upd s.hold p true }
  | rel (p : Nat) (s : LS) : s.hold p = true →
      FStep dead s { s with hold := upd s.hold p false,
                            lock := if s.lock = some p then none else s.lock }
  | gAcq (p : Nat) (s : LS) : dead p = false → s.guard = none →
      FStep dead s { s with guard := some p, seen := upd s.seen p none }
  /-- `now === expected` under the guard; `expected` came from a liveness=false probe. -/
  | gRead (p h : Nat) (s : LS) : dead p = false → s.guard = some p → dead h = true →
      FStep dead s { s with seen := upd s.seen p (if s.lock = some h then some h else none) }
  | gRename (p h x : Nat) (s : LS) : dead p = false → s.guard = some p → s.seen p = some h →
      s.lock = some x →
      FStep dead s { s with claim := upd s.claim p (some (h, x)), lock := none,
                            seen := upd s.seen p none }
  | gFinish (p h x : Nat) (s : LS) : dead p = false → s.claim p = some (h, x) →
      FStep dead s { s with lock := finishLock s h x, claim := upd s.claim p none }
  | gRel (p : Nat) (s : LS) : dead p = false → s.guard = some p → s.claim p = none →
      FStep dead s { s with guard := none, seen := upd s.seen p none }

structure Inv (dead : Nat → Bool) (s : LS) : Prop where
  holders : ∀ q, s.hold q = true → s.lock = some q ∧ dead q = false
  seen    : ∀ p h, s.seen p = some h → s.guard = some p ∧ s.lock = some h ∧ dead h = true
  claims  : ∀ p h x, s.claim p = some (h, x) → x = h

set_option linter.deprecated false in
theorem inv_step (dead : Nat → Bool) (s s' : LS) (hi : Inv dead s) (hs : FStep dead s s') :
    Inv dead s' := by
  cases hs with
  | acq p s hd hl =>
    refine ⟨?_, ?_, ?_⟩
    · intro q hq
      simp only [upd] at hq ⊢
      by_cases hqp : q = p
      · subst hqp; exact ⟨rfl, hd⟩
      · rw [if_neg hqp] at hq
        have := (hi.holders q hq).1; rw [hl] at this; cases this
    · intro p' h hh
      have := (hi.seen p' h hh).2.1; rw [hl] at this; cases this
    · exact hi.claims
  | rel p s hp =>
    have ⟨hlp, hdp⟩ := hi.holders p hp
    refine ⟨?_, ?_, ?_⟩
    · intro q hq
      simp only [upd] at hq ⊢
      by_cases hqp : q = p
      · rw [if_pos hqp] at hq; cases hq
      · rw [if_neg hqp] at hq
        have ⟨hlq, hdq⟩ := hi.holders q hq
        rw [hlp] at hlq; cases hlq; exact absurd rfl hqp
    · intro p' h hh
      have ⟨_, hl, hdh⟩ := hi.seen p' h hh
      rw [hlp] at hl; cases hl; rw [hdp] at hdh; cases hdh
    · exact hi.claims
  | gAcq p s hd hg =>
    refine ⟨hi.holders, ?_, hi.claims⟩
    intro p' h hh
    simp only [upd] at hh ⊢
    by_cases hq : p' = p
    · rw [if_pos hq] at hh; cases hh
    · rw [if_neg hq] at hh
      have := (hi.seen p' h hh).1; rw [hg] at this; cases this
  | gRead p h s hd hg hdh =>
    refine ⟨hi.holders, ?_, hi.claims⟩
    intro p' h' hh
    simp only [upd] at hh ⊢
    by_cases hq : p' = p
    · rw [if_pos hq] at hh
      by_cases hl : s.lock = some h
      · rw [if_pos hl] at hh; cases hh; exact ⟨hq ▸ hg, hl, hdh⟩
      · rw [if_neg hl] at hh; cases hh
    · rw [if_neg hq] at hh; exact hi.seen p' h' hh
  | gRename p h x s hd hg hsp hl =>
    have ⟨_, hlh, hdh⟩ := hi.seen p h hsp
    rw [hl] at hlh; cases hlh
    refine ⟨?_, ?_, ?_⟩
    · intro q hq
      have ⟨hlq, hdq⟩ := hi.holders q hq
      rw [hl] at hlq; cases hlq; rw [hdh] at hdq; cases hdq
    · intro p' h' hh
      simp only [upd] at hh ⊢
      by_cases hq : p' = p
      · rw [if_pos hq] at hh; cases hh
      · rw [if_neg hq] at hh
        have ⟨hg', _, _⟩ := hi.seen p' h' hh
        rw [hg] at hg'; cases hg'; exact absurd rfl hq
    · intro p' h' x' hc
      simp only [upd] at hc
      by_cases hq : p' = p
      · rw [if_pos hq] at hc; cases hc; rfl
      · rw [if_neg hq] at hc; exact hi.claims p' h' x' hc
  | gFinish p h x s hd hc =>
    have hxh := hi.claims p h x hc
    have hfl : finishLock s h x = s.lock := by simp [finishLock, hxh]
    refine ⟨?_, ?_, ?_⟩
    · intro q hq; rw [hfl]; exact hi.holders q hq
    · intro p' h' hh; rw [hfl]; exact hi.seen p' h' hh
    · intro p' h' x' hc'
      simp only [upd] at hc'
      by_cases hq : p' = p
      · rw [if_pos hq] at hc'; cases hc'
      · rw [if_neg hq] at hc'; exact hi.claims p' h' x' hc'
  | gRel p s hd hg hc =>
    refine ⟨hi.holders, ?_, hi.claims⟩
    intro p' h hh
    simp only [upd] at hh ⊢
    by_cases hq : p' = p
    · rw [if_pos hq] at hh; cases hh
    · rw [if_neg hq] at hh
      have ⟨hg', hl, hd'⟩ := hi.seen p' h hh
      rw [hg] at hg'; cases hg'; exact absurd rfl hq

inductive Reach (dead : Nat → Bool) (s0 : LS) : LS → Prop
  | refl : Reach dead s0 s0
  | step (s s' : LS) : Reach dead s0 s → FStep dead s s' → Reach dead s0 s'

/-- **Mutual exclusion (fixed protocol):** from any state satisfying the invariant —
in particular a dead holder's lock and nobody inside — at most one process is ever in
the critical section. -/
theorem reach_inv (dead : Nat → Bool) (s0 s : LS) (h0 : Inv dead s0) (hr : Reach dead s0 s) :
    Inv dead s := by
  induction hr with
  | refl => exact h0
  | step s s' _ hs ih => exact inv_step dead s s' ih hs

/-- **Mutual exclusion (round-1 single-guard protocol, no crash inside the guard):**
from any state satisfying the invariant — in particular a dead holder's lock and nobody
inside — at most one process is ever in the critical section. Not a claim about the
current code; see `R2Persist.Guard.ladder_mutex`. -/
theorem fixed_mutex (dead : Nat → Bool) (s0 s : LS) (h0 : Inv dead s0) (hr : Reach dead s0 s)
    (p q : Nat) (hp : s.hold p = true) (hq : s.hold q = true) : p = q := by
  have hi := reach_inv dead s0 s h0 hr
  have := (hi.holders p hp).1
  rw [(hi.holders q hq).1] at this
  cases this; rfl

theorem init0_inv : Inv dead9 init0 := by
  refine ⟨?_, ?_, ?_⟩
  · intro q hq; exact absurd hq (by simp [init0])
  · intro p h hh; exact absurd hh (by simp [init0])
  · intro p h x hc; exact absurd hc (by simp [init0])

/-- Non-vacuity (round-1 protocol): the dead holder's lock IS stolen and a live
process gets in. -/
theorem fixed_steal_reachable :
    ∃ s, Reach dead9 init0 s ∧ s.hold 1 = true := by
  let s1 : LS := { init0 with guard := some 1, seen := upd init0.seen 1 none }
  let s2 : LS := { s1 with seen := upd s1.seen 1 (if s1.lock = some 9 then some 9 else none) }
  let s3 : LS := { s2 with claim := upd s2.claim 1 (some (9, 9)), lock := none,
                           seen := upd s2.seen 1 none }
  let s4 : LS := { s3 with lock := finishLock s3 9 9, claim := upd s3.claim 1 none }
  let s5 : LS := { s4 with guard := none, seen := upd s4.seen 1 none }
  let s6 : LS := { s5 with lock := some 1, hold := upd s5.hold 1 true }
  refine ⟨s6, ?_, rfl⟩
  have r1 : Reach dead9 init0 s1 := .step _ _ .refl (.gAcq 1 init0 rfl rfl)
  have r2 : Reach dead9 init0 s2 := .step _ _ r1 (.gRead 1 9 s1 rfl rfl rfl)
  have r3 : Reach dead9 init0 s3 := .step _ _ r2 (.gRename 1 9 9 s2 rfl rfl rfl rfl)
  have r4 : Reach dead9 init0 s4 := .step _ _ r3 (.gFinish 1 9 9 s3 rfl rfl)
  have r5 : Reach dead9 init0 s5 := .step _ _ r4 (.gRel 1 s4 rfl rfl rfl)
  exact .step _ _ r5 (.acq 1 s5 rfl rfl)

end Lock

/-! ## 3b. Lock heartbeat (decision P1; async-lock.ts `startHeartbeat`,
`heartbeatHeldLocks`; sync.ts `withLock`, `git`)

A contender that cannot probe the holder (another host) steals iff the lock's
age exceeds `T` (staleThreshold). Time in whole units; `age` = time since the
lock file was last touched.

Checked against round 2 (2026-09-27): still holds because `startHeartbeat` still
touches every `max(1, floor(T/3))` ms and sync.ts `git()` still calls
`heartbeatHeldLocks()` before each command, now with the timeout from the shared
`GIT_COMMAND_TIMEOUT_MS` (30 s, = `B` here). Round 2 only added a one-time warning when
`T/3 + 30 s ≥ T` (`R2Persist` §7 `warns_iff`), i.e. when `sync_age_bound`'s bound is
not below the threshold. -/
namespace Heartbeat

/-- Pre-fix: the file is touched only at acquisition (time 0). -/
def staleOld (T t : Nat) : Bool := decide (t > T)

/-- Post-fix, async work: a timer touches every `H` units, so at time `t` the
age is `t % H`. -/
def staleTimer (T H t : Nat) : Bool := decide (t % H > T)

/-- Replayed pre-fix: a holder on another host 61 s into a 90 s hold, threshold 60 s. -/
theorem old_stolen_mid_hold : staleOld 60 61 = true := by decide

/-- **Fixed code (P1), timer:** with the interval `T / 3` (T ≥ 3), a holder is
never judged stale at any time during its hold. -/
theorem timer_never_stale (T t : Nat) (hT : 3 ≤ T) : staleTimer T (T / 3) t = false := by
  have hH : 0 < T / 3 := by omega
  have h := Nat.mod_lt t hH
  simp only [staleTimer, decide_eq_false_iff_not]
  omega

/-- Post-fix, synchronous work (git under `Plur.sync`): touch points are the
starts of blocking segments (`gaps`, each ≤ `B`); a touch point re-touches iff the
last touch is ≥ `H` old (the throttle in `heartbeatHeldLocks`). The list is the
lock's age at the END of each segment — the oldest it gets. -/
def syncAges (H : Nat) : Nat → List Nat → List Nat
  | _, [] => []
  | a, g :: gs =>
    let a' := if a ≥ H then 0 else a
    (a' + g) :: syncAges H (a' + g) gs

/-- **Fixed code (P1), synchronous touch points:** the age never reaches
`H + B`, for every sequence of blocking segments of length ≤ `B`. With the
defaults (H = 60/3 = 20 s, git timeout B = 30 s) that is < 50 s < 60 s. -/
theorem sync_age_bound (H B : Nat) (hH : 0 < H) :
    ∀ (a : Nat) (gs : List Nat), (∀ g ∈ gs, g ≤ B) → ∀ x ∈ syncAges H a gs, x < H + B := by
  intro a gs
  induction gs generalizing a with
  | nil => intro _ x hx; cases hx
  | cons g gs ih =>
    intro hg x hx
    simp only [syncAges, List.mem_cons] at hx
    have hg0 := hg g (List.mem_cons_self ..)
    rcases hx with rfl | hx
    · split <;> omega
    · exact ih _ (fun g' h' => hg g' (List.mem_cons_of_mem _ h')) x hx

/-- The default sync hold (three 30 s git commands) stays below the 60 s
threshold; before the fix its age reached 90 s. -/
theorem default_sync_fresh : ∀ x ∈ syncAges 20 0 [30, 30, 30], x < 60 := by decide
theorem old_default_sync_stale : staleOld 60 (30 + 30 + 30) = true := by decide

end Heartbeat

/-! ## 4. Postgres advisory lock session (storage-postgres.ts `withExclusiveAccess`)

A checkout ends in `release()` (back to idle) or `release(err)` (destroyed). The
advisory lock belongs to the session. `unlockOk` is the oracle outcome of
`pg_advisory_unlock`.

Checked against round 2 (2026-09-27): still holds because `withExclusiveAccess` is not
in the round-2 diff of storage-postgres.ts (which changed `save`/`updateMany` duplicate
handling, `R2Persist` §2/§3b): the lock session is still destroyed with
`release(poisoned)` whenever the unlock may not have happened. (Outside this model:
`initSchema` still ends with a bare `client.release()` after a best-effort unlock whose
comment says the session ends on release — see findings/persistence.md.) -/
namespace PgLock

/-- Where the session ends up: `some locked?` = back in the pool (with its lock
state), `none` = destroyed. -/
def endOld (unlockOk : Bool) : Option Bool :=
  some (!unlockOk)                          -- bare `client.release()`

def endFixed (unlockOk : Bool) : Option Bool :=
  if unlockOk then some false else none     -- `client.release(poisoned)`

/-- **Counterexample (confirmed by replay):** a failed unlock returns a session that
still holds the lock to the pool. -/
theorem old_pool_gets_locked_session : endOld false = some true := rfl

/-- Fixed: no pooled session ever holds the advisory lock. -/
theorem fixed_pool_never_locked (u : Bool) : endFixed u ≠ some true := by
  cases u <;> simp [endFixed]

/-- Non-vacuity: a clean unlock still returns the session for reuse. -/
theorem fixed_clean_reuses : endFixed true = some false := rfl

end PgLock

/-! ## 5. Daily backup gate (backup.ts `maybeDailyBackup`, `validateStore`, `idsCreatedAfter`)

The shrink gate refuses a snapshot when `count < 0.9 · last_good_count`
(`count * 10 < last * 9` in ℕ); `last_good_count` is written ONLY by a successful
snapshot.

Checked against round 2 (2026-09-27): still holds because the gate and
`idsCreatedAfter` are not in the round-2 diff of backup.ts, and `saveEngrams` still
records the last-written count (P2, `write` below). Round 2 added two more PLUR writes
that record it — a sync pull that rewrote the file (`recordPulledCount`, `R2Persist`
§7 `pull_then_snap`) and the migration runner's restore — which only move events from
`ext` to `write`, and made `validateStore` accept repeated ids (P1, resolved by the
loader, `R2Persist` §3b), which the model never checked. -/
namespace Backup

structure BState where
  lastGood : Nat
  taken : Nat          -- snapshots taken

def day (s : BState) (count : Nat) : BState :=
  if count * 10 < s.lastGood * 9 then s else ⟨count, s.taken + 1⟩

def days (s : BState) : List Nat → BState
  | [] => s
  | c :: cs => days (day s c) cs

/-- **Confirmed (replayed; NEEDS-OWNER):** after one legitimate drop below 90% of the
last good count, no later day ever snapshots while the corpus stays below that floor —
the baseline that would have to move is only moved by a snapshot. -/
theorem backups_stop (s : BState) (cs : List Nat) (h : ∀ c, c ∈ cs → c * 10 < s.lastGood * 9) :
    days s cs = s := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    have hc := h c (List.mem_cons_self ..)
    simp only [days, day, hc, ↓reduceIte]
    exact ih s (fun c' hc' => h c' (List.mem_cons_of_mem _ hc'))

/-- Non-vacuity: a healthy day does snapshot and moves the baseline. -/
theorem healthy_day_snapshots : day ⟨100, 1⟩ 95 = ⟨95, 2⟩ := by simp [day]

/-- `idsCreatedAfter`, fixed: only canonical engram ids are reported. `isEngramId`
abstracts the `^(ENG|ABS|META)-…$` test. -/
def unrecoverable (isEngramId : String → Bool) (inBackup : String → Bool)
    (events : List String) : List String :=
  (events.filter isEngramId).filter (fun i => !inBackup i)

theorem unrecoverable_only_engrams (isEngramId inBackup : String → Bool) (evs : List String)
    (i : String) (hi : i ∈ unrecoverable isEngramId inBackup evs) : isEngramId i = true := by
  simp only [unrecoverable, List.mem_filter] at hi
  exact hi.1.2

/-! ### Decision P2 (last-written), post-fix.
The write path records the count PLUR wrote (`saveEngrams` → `recordLastWritten`);
the gate compares the file against that. `file` is what is on disk, `lw` the
recorded count. -/

structure PState where
  file : Nat
  lw : Nat
  taken : Nat
  deriving DecidableEq, Repr

inductive Ev | write (n : Nat) | ext (n : Nat) | snap

/-- One event: a PLUR write sets both the file and the record; an external change
(truncation, hand edit) moves only the file; a daily snapshot is taken iff the
file is not below 90% of what PLUR last wrote. -/
def stepP (s : PState) : Ev → PState
  | .write n => ⟨n, n, s.taken⟩
  | .ext n => ⟨n, s.lw, s.taken⟩
  | .snap => if s.file * 10 < s.lw * 9 then s else ⟨s.file, s.lw, s.taken + 1⟩

def runP (s : PState) : List Ev → PState
  | [] => s
  | e :: es => runP (stepP s e) es

/-- **Fixed code (P2):** whatever PLUR wrote last — including any legitimate
shrink — the next daily check snapshots it. Backups can no longer stop for good
after a deliberate removal. -/
theorem write_then_snap (s : PState) (n : Nat) :
    (stepP (stepP s (.write n)) .snap).taken = s.taken + 1 := by
  have h : ¬ (n * 10 < n * 9) := by omega
  simp [stepP, h]

/-- **Fixed code (P2):** a file that shrank below 90% of what PLUR last wrote,
without PLUR writing it, is still refused — the state is unchanged. -/
theorem truncation_refused (s : PState) (m : Nat) (h : m * 10 < s.lw * 9) :
    stepP (stepP s (.ext m)) .snap = ⟨m, s.lw, s.taken⟩ := by
  simp [stepP, h]

/-- The replayed sequence (100 on day 1, a legitimate forget to 70, then days
2–4) now snapshots every day; with the old gate `backups_stop` it never did. -/
theorem replay_rebaselines :
    (runP ⟨0, 0, 0⟩ [.write 100, .snap, .write 70, .snap, .snap, .snap]).taken = 4 := by decide

/-- …and an external truncation after the legitimate shrink is still refused. -/
theorem replay_truncation_refused :
    (runP ⟨0, 0, 0⟩ [.write 100, .snap, .write 70, .ext 50, .snap]).taken = 1 := by decide

/-! ### Decision P3 (engram_created only), post-fix `idsCreatedAfter`. -/

inductive Kind | created | retired | other
  deriving DecidableEq

/-- Events after the snapshot instant, as (kind, id). Reported: ids with a
`created` event, minus ids with a `retired` event, minus ids in the backup. -/
def unrecoverableP3 (inBackup : String → Bool) (evs : List (Kind × String)) : List String :=
  let created := (evs.filter (fun e => e.1 == .created)).map Prod.snd
  let retired := (evs.filter (fun e => e.1 == .retired)).map Prod.snd
  (created.filter (fun i => !retired.contains i)).filter (fun i => !inBackup i)

/-- **Fixed code (P3):** every reported id was created after the snapshot, was
not retired since, and is not in the backup — for every event log. -/
theorem unrecoverableP3_sound (inBackup : String → Bool) (evs : List (Kind × String))
    (i : String) (hi : i ∈ unrecoverableP3 inBackup evs) :
    (Kind.created, i) ∈ evs ∧ (Kind.retired, i) ∉ evs ∧ inBackup i = false := by
  simp only [unrecoverableP3, List.mem_filter, List.mem_map] at hi
  obtain ⟨⟨⟨⟨k, j⟩, ⟨hmem, hk⟩, rfl⟩, hr⟩, hb⟩ := hi
  simp only [beq_iff_eq] at hk
  subst hk
  refine ⟨hmem, ?_, by simpa using hb⟩
  intro hret
  have hm : j ∈ (evs.filter (fun e => e.1 == Kind.retired)).map Prod.snd :=
    List.mem_map.mpr ⟨(Kind.retired, j), List.mem_filter.mpr ⟨hret, rfl⟩, rfl⟩
  simp [hm] at hr

/-- Non-vacuity: a created, unretired id absent from the backup is reported;
feedback on an older engram is not. -/
theorem unrecoverableP3_reports :
    unrecoverableP3 (fun _ => false) [(.created, "ENG-050"), (.other, "ENG-007"),
      (.created, "ENG-060"), (.retired, "ENG-060")] = ["ENG-050"] := by decide

end Backup

/-! ## 6. Outbox flush order (outbox-order.ts `orderBySupersedes`)

Modelled: the permutation property (nothing vanishes, nothing doubles). Left out: the
edge-order and stability properties of the Kahn loop — covered by the randomized
property test `formal-persistence-outbox-order.test.ts` (300 random DAGs), not proved.

Checked against round 2 (2026-09-27): still holds because outbox-order.ts has no
round-2 change; `_flushOutboxClaimed` still orders the pending rows through it. -/
namespace Outbox

/-- Old shape, keyed by id: the emitted ids are looked up in a last-wins map. -/
def lastWins (rows : List (Nat × Nat)) (id : Nat) : Option (Nat × Nat) :=
  rows.foldl (fun acc r => if r.1 = id then some r else acc) none

/-- With no edges every row is ready; the ready list holds each row's id. -/
def oldNoEdges (rows : List (Nat × Nat)) : List (Option (Nat × Nat)) :=
  rows.map (fun r => lastWins rows r.1)

/-- **Counterexample (confirmed by replay):** rows `(id, tag)` = `(7,1),(7,2)` come out
as the second copy twice; the first vanishes. -/
theorem old_duplicate_drops :
    oldNoEdges [(7, 1), (7, 2)] = [some (7, 2), some (7, 2)] := by decide

/-- Fixed shape, keyed by position: the Kahn loop emits positions `o` (each at most
once — `placed` guards it — and all `< n`), then every unplaced position in order. -/
def fixedOrder (n : Nat) (o : List Nat) : List Nat :=
  o ++ (List.range n).filter (fun i => !o.contains i)

theorem fixed_is_permutation (n : Nat) (o : List Nat) (hnd : o.Nodup)
    (hlt : ∀ i, i ∈ o → i < n) : (fixedOrder n o).Perm (List.range n) := by
  rw [List.perm_iff_count]
  intro a
  have hr : (List.range n).count a = if a ∈ List.range n then 1 else 0 :=
    List.nodup_range.count
  simp only [fixedOrder, List.count_append, hnd.count, hr]
  by_cases ho : a ∈ o
  · have hin : a ∈ List.range n := List.mem_range.mpr (hlt a ho)
    have h0 : List.count a ((List.range n).filter (fun i => !decide (i ∈ o))) = 0 :=
      List.count_eq_zero.mpr (by simp [ho])
    simp [ho, hin]
    exact h0
  · have hf : List.count a ((List.range n).filter (fun i => !o.contains i)) =
        List.count a (List.range n) := List.count_filter (by simp [ho])
    rw [hf, hr]; simp [ho]

/-- Non-vacuity: with no edges the order is the identity (stability). -/
theorem fixed_no_edges_identity (n : Nat) (o : List Nat) (ho : o = List.range n) :
    fixedOrder n o = List.range n := by
  subst ho; simp [fixedOrder]

end Outbox

/-! ## 7. Dedup UPDATE/MERGE vs `commitment: locked` (learn-async.ts `executeDedupDecision`)

`pre` is the snapshot read before the store lock (`getById`), `cur` the row re-read
under it. A write is allowed only on an unlocked row.

Checked against round 2 (2026-09-27): still holds because learn-async.ts has no
round-2 change; round 2 only narrowed the candidates index.ts hands it to rows the
writer can persist (Decision A follow-up, `R2CoreA` §8 `async_target_persistable`),
which does not touch the locked re-check. -/
namespace LearnAsync

structure Row where
  locked : Bool
  stmt : Nat

/-- Before: checks `pre`, writes onto `cur`. `none` = falls back to ADD. -/
def writeOld (pre cur : Row) (new : Nat) : Option Row :=
  if pre.locked then none else some { cur with stmt := new }

/-- Fixed: checks `cur` too, under the lock. -/
def writeFixed (pre cur : Row) (new : Nat) : Option Row :=
  if pre.locked || cur.locked then none else some { cur with stmt := new }

/-- **Counterexample (confirmed by replay):** locked between the check and the lock ⇒
the locked row is rewritten. -/
theorem old_overwrites_locked :
    writeOld ⟨false, 1⟩ ⟨true, 1⟩ 2 = some ⟨true, 2⟩ := rfl

/-- Fixed: a row that is locked under the lock is never written. -/
theorem fixed_never_writes_locked (pre cur : Row) (new : Nat) (r : Row)
    (h : writeFixed pre cur new = some r) : cur.locked = false := by
  unfold writeFixed at h
  cases hp : pre.locked <;> cases hc : cur.locked <;> simp [hp, hc] at h ⊢

/-- Non-vacuity: an unlocked row is still updated. -/
theorem fixed_updates_unlocked : writeFixed ⟨false, 1⟩ ⟨false, 1⟩ 2 = some ⟨false, 2⟩ := rfl

end LearnAsync

/-! ## 8. Packs (packs.ts `computePackHash`, registry `addToRegistry`/`uninstallPack`)

The hash is `H(SKILL.md ‖ engrams.yaml)` for ANY hash oracle `H` — so it can only be
as injective as the unframed concatenation, which is not. A missing file hashes as an
empty one. The registry is keyed by manifest name; pack directories by source
basename.

Checked against round 2 (2026-09-27): still holds because packs.ts has no change on
this branch since a831872b — it still hashes v1 and keys the registry by name. The
fixes (hash v2, directory-keyed registry) are in separate PRs #1229/#1230, modelled by
`PacksV2`; these theorems stay as the record of v1. -/
namespace Packs

/-- `computePackHash` for an arbitrary hash oracle; `none` = file absent. -/
def packHash {δ : Type} (H : List UInt8 → δ) (skill eng : Option (List UInt8)) : δ :=
  H (skill.getD [] ++ eng.getD [])

/-- **Confirmed (replayed; NEEDS-OWNER — spec §5.5 defines this hash):** moving bytes
across the file boundary preserves the hash, for every oracle. -/
theorem hash_boundary_collision {δ : Type} (H : List UInt8 → δ) :
    packHash H (some [1, 2]) (some [3]) = packHash H (some [1]) (some [2, 3]) := rfl

theorem hash_missing_eq_empty {δ : Type} (H : List UInt8 → δ) (e : Option (List UInt8)) :
    packHash H none e = packHash H (some []) e := rfl

/-- Registry rows `(manifestName, integrity)`; `addToRegistry` replaces by name. -/
def addRow (reg : List (String × Nat)) (row : String × Nat) : List (String × Nat) :=
  if reg.any (fun r => r.1 == row.1) then reg.map (fun r => if r.1 == row.1 then row else r)
  else reg ++ [row]

def lookup (reg : List (String × Nat)) (name : String) : Option Nat :=
  (reg.find? (fun r => r.1 == name)).map (·.2)

/-- **Confirmed (replayed; NEEDS-OWNER):** two directories whose manifests share a
name share one row — the first pack's baseline is the second's hash, so the untouched
first pack reads `modified`. -/
theorem registry_shared_row :
    lookup (addRow (addRow [] ("shared-name", 1)) ("shared-name", 2)) "shared-name" = some 2 := by
  decide

end Packs

end PlurSpec.Persistence
