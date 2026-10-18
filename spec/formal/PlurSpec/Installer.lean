/-!
# PlurSpec.Installer — the enterprise first install (`plur-enterprise init`)

Models of `packages/cli/src/enterprise/{cleanup,owner-only,hello,mcp-stdio,
args,summary}.ts` on branch formal/epic-1797 (epic "enterprise first install",
plan C tasks 1, 6, 7, 8, 10a). Findings, verdicts and replays:
`spec/formal/findings/installer.md`.

File contents, parsers, icacls output, MCP answers and process timing are
abstract (oracles / parameters): every theorem holds for all of them. Where a
defect was found, the section models the FIXED code, proves the property, and
gives a counterexample theorem for the ORIGINAL code, plus a reachability
theorem so the property is not vacuous.

Left out: the TOML/JSONC editing itself (which bytes are cut), the WHATWG URL
parser, process trees (an `npx` or `cmd.exe` wrapper's grandchild), and the
Windows-only `rmSync` refusal (modelled only as an oracle in §4).
-/

namespace PlurSpec.Installer

/-! ## 1. Cleanup of one editor config (`cleanup.ts` run / cleanupX / backupWriter)

`runTarget` mirrors each `cleanupX` and the `run` wrapper: an unparsable file is
refused before anything happens; no entry → absent; `makeBackup` throwing is
caught by `run` → refused with the file untouched; `atomicWrite` is
all-or-nothing (temp file + rename), so its failure leaves the file as it was. -/
namespace Cleanup

inductive Status | removed | absent | refused
  deriving DecidableEq, Repr

structure Env where
  parsed   : Bool   -- read + parse succeeded
  hasEntry : Bool   -- a plur-enterprise entry is there
  backupOk : Bool   -- the backup writer returned (see `loop` below for what that means)
  writeOk  : Bool   -- atomicWrite succeeded

structure Outcome where
  status      : Status
  fileChanged : Bool
  backupMade  : Bool

def runTarget (e : Env) : Outcome :=
  if !e.parsed then ⟨.refused, false, false⟩
  else if !e.hasEntry then ⟨.absent, false, false⟩
  else if !e.backupOk then ⟨.refused, false, false⟩
  else if !e.writeOk then ⟨.refused, false, true⟩
  else ⟨.removed, true, true⟩

/-- A config is changed only after its backup succeeded. -/
theorem changed_implies_backup (e : Env) :
    (runTarget e).fileChanged = true → (runTarget e).backupMade = true ∧ e.backupOk = true := by
  unfold runTarget
  cases e.parsed <;> cases e.hasEntry <;> cases e.backupOk <;> cases e.writeOk <;> simp

/-- Anything but `removed` leaves the file byte-identical. -/
theorem not_removed_unchanged (e : Env) :
    (runTarget e).status ≠ .removed → (runTarget e).fileChanged = false := by
  unfold runTarget
  cases e.parsed <;> cases e.hasEntry <;> cases e.backupOk <;> cases e.writeOk <;> simp

/-- `run` over all targets: each result is its own target's, so one failure
never changes or aborts another (the try/catch around each `fn`). -/
def runAll (es : List Env) : List Outcome := es.map runTarget

theorem one_failure_isolated (es : List Env) (i : Nat) (h : i < es.length) :
    (runAll es).length = es.length ∧
    (runAll es)[i]'(by simp [runAll]; exact h) = runTarget (es[i]'h) := by
  simp [runAll]

theorem removal_reachable : (runTarget ⟨true, true, true, true⟩).status = .removed := rfl

/-! ### 1b. The backup is complete before it counts (finding I1b)

`fs.writeSync` returns how many bytes it wrote, which may be fewer than asked.
`w rem` is that oracle (the OS never reports more than asked, hence `min`).
The fixed code loops until all `len` bytes are written and throws on a zero
write; `fuel` only bounds the Lean recursion (each step writes ≥ 1 byte). -/

def loop (w : Nat → Nat) (len : Nat) : (fuel off : Nat) → Option Nat
  | 0, off => if len ≤ off then some off else none
  | fuel + 1, off =>
    if len ≤ off then some off
    else
      let n := min (w (len - off)) (len - off)
      if n = 0 then none else loop w len fuel (off + n)

/-- Fixed: a backup that is reported written holds every byte. -/
theorem loop_complete (w : Nat → Nat) (len : Nat) :
    ∀ fuel off k, off ≤ len → loop w len fuel off = some k → k = len := by
  intro fuel
  induction fuel with
  | zero =>
    intro off k hle h
    simp only [loop] at h
    split at h
    · simp at h; omega
    · simp at h
  | succ f ih =>
    intro off k hle h
    simp only [loop] at h
    split at h
    · simp at h; omega
    · rename_i hlt
      split at h
      · simp at h
      · rename_i hn
        exact ih _ k (by omega) h

theorem loop_reachable : loop (fun r => r) 4 4 0 = some 4 := by decide

/-- Original: one `writeSync` call, its count ignored. -/
def oldBackup (w : Nat → Nat) (len : Nat) : Option Nat := some (min (w len) len)

/-- Counterexample (replayed: formal-installer-backup.test.ts): a short write is
accepted as the backup, and the config is then changed. -/
theorem old_backup_truncated : oldBackup (fun r => r / 2) 4 = some 2 := by decide

/-! ### 1c. No backup overwrites an earlier one

Whatever name the numbering loop picks, the file is opened with `'wx'`
(O_EXCL): the open fails when anything is at that path at open time. -/

def openExcl (present : Nat → Bool) (dest : Nat) : Bool := !present dest

theorem backup_never_overwrites (present : Nat → Bool) (dest : Nat) :
    openExcl present dest = true → present dest = false := by
  simp [openExcl]

/-! ### 1d. One snapshot per replacement, verified before it is written (Codex round 3, findings 3 and 4)

`replaceFromSnapshot`. Each attempt reads the file ONCE (`f`), plans the edit from
those bytes (`edit f`; `none` is absent or refused — for OpenCode that includes a
config with a duplicate key, `ambiguous`), verifies the edited document (`ok`: the
targeted entry is no longer active when re-parsed the way the editor reads it),
backs up `f` itself, and re-reads just before the replacement. `writer k` is the
concurrent writer during attempt `k` (identity = no change). The replacement is
written only when the re-read equals the snapshot (`f' = f`); otherwise the next
attempt plans from the current contents, and after `fuel` attempts the target is
refused. `replaced` is the file just before cleanup's own write.

Left out: the remaining gap between the last comparison and the rename (no
lock-free writer closes it), and which bytes the edit cuts. -/
namespace Snapshot

structure Res (α : Type) where
  status   : Status
  final    : α
  backup   : Option α
  replaced : Option α

/-- Fixed: plan, verify, back up and replace from one snapshot; retry on change. -/
def run {α : Type} [DecidableEq α] (edit : α → Option α) (ok : α → Bool)
    (writer : Nat → α → α) : (fuel k : Nat) → α → Res α
  | 0, _, f => ⟨.refused, f, none, none⟩
  | fuel + 1, k, f =>
    match edit f with
    | none => ⟨.absent, f, none, none⟩
    | some out =>
      if ok out = false then ⟨.refused, f, none, none⟩
      else
        let f' := writer k f
        if f' = f then ⟨.removed, out, some f, some f⟩ else run edit ok writer fuel (k + 1) f'

/-- A removal is built from exactly the bytes it replaced, and those are the backup. -/
theorem removed_from_replaced {α : Type} [DecidableEq α] (edit : α → Option α) (ok : α → Bool)
    (writer : Nat → α → α) :
    ∀ fuel k f, (run edit ok writer fuel k f).status = .removed →
      ∃ r, (run edit ok writer fuel k f).replaced = some r ∧
        (run edit ok writer fuel k f).backup = some r ∧
        edit r = some (run edit ok writer fuel k f).final := by
  intro fuel
  induction fuel with
  | zero => intro k f h; simp [run] at h
  | succ n ih =>
    intro k f h
    simp only [run] at h ⊢
    split at h
    · simp at h
    · rename_i out he
      split at h
      · simp at h
      · split at h
        · rename_i hw
          simp_all
        · rename_i hb hw
          simp only [hb, hw, ite_false]
          exact ih (k + 1) _ h

/-- Every written edit passed the post-edit verification. -/
theorem removed_verified {α : Type} [DecidableEq α] (edit : α → Option α) (ok : α → Bool)
    (writer : Nat → α → α) :
    ∀ fuel k f, (run edit ok writer fuel k f).status = .removed →
      ok (run edit ok writer fuel k f).final = true := by
  intro fuel
  induction fuel with
  | zero => intro k f h; simp [run] at h
  | succ n ih =>
    intro k f h
    simp only [run] at h ⊢
    split at h
    · simp at h
    · rename_i out he
      split at h
      · simp at h
      · rename_i hb
        split at h
        · rename_i hw
          simp_all
        · rename_i hw
          simp only [hb, hw, ite_false]
          exact ih (k + 1) _ h

/-- The OpenCode plan refuses an ambiguous (duplicate-key) config before editing. -/
def guarded {α : Type} (ambiguous : α → Bool) (edit : α → Option α) (f : α) : Option α :=
  if ambiguous f then none else edit f

/-- A config that stays ambiguous is never reported removed. -/
theorem ambiguous_never_removed {α : Type} [DecidableEq α] (ambiguous : α → Bool)
    (edit : α → Option α) (ok : α → Bool) (writer : Nat → α → α) (hA : ∀ x, ambiguous x = true) :
    ∀ fuel k f, (run (guarded ambiguous edit) ok writer fuel k f).status ≠ .removed := by
  intro fuel
  induction fuel with
  | zero => intro k f; simp [run]
  | succ n _ => intro k f; simp [run, guarded, hA]

/-! Instances on lists of server names: `0` is `plur-enterprise`; the edit removes it. -/
def rmEntry (l : List Nat) : Option (List Nat) := if 0 ∈ l then some (l.erase 0) else none
def noEntry (l : List Nat) : Bool := !(l.contains 0)
/-- The editor adds server 7 during the first attempt only. -/
def addsOnce (k : Nat) (l : List Nat) : List Nat := if k = 0 ∧ ¬ 7 ∈ l then 7 :: l else l

/-- Reachable: a concurrent addition is retried and survives the removal. -/
theorem concurrent_setting_survives :
    let r := run rmEntry noEntry addsOnce 3 0 [0, 1]
    r.status = .removed ∧ r.final = [7, 1] ∧ r.backup = some [7, 0, 1] := by
  decide

/-- A file that keeps changing is refused after the bounded attempts. -/
theorem always_changing_refused :
    (run rmEntry noEntry (fun _ l => 7 :: l) 3 0 [0]).status = .refused := by
  decide

/-- Original (finding 3): plan from the first read, back up a fresh re-read,
replace without comparing. -/
def runOld {α : Type} (edit : α → Option α) (writer : Nat → α → α) (f : α) : Res α :=
  match edit f with
  | none => ⟨.absent, f, none, none⟩
  | some out => let f' := writer 0 f; ⟨.removed, out, some f', some f'⟩

/-- **Finding 3 (replayed):** the old cleanup replaced `[7, 0, 1]` with `[1]` —
the server the editor added is gone, and the status says removed. -/
theorem old_loses_concurrent_setting :
    let r := runOld rmEntry addsOnce [0, 1]
    r.status = .removed ∧ r.replaced = some [7, 0, 1] ∧ r.final = [1] ∧ rmEntry [7, 0, 1] ≠ some [1] := by
  decide

/-- **Finding 4 (replayed):** two `mcp` objects; the offset edit removes the entry
from the first, the last-wins parse still sees it in the second. Modelled as a
document `(first, last)` whose active entry is in `last`; the old code reported
removed without verifying. -/
def editFirst (d : List Nat × List Nat) : Option (List Nat × List Nat) :=
  if 0 ∈ d.1 then some (d.1.erase 0, d.2) else none
def activeGone (d : List Nat × List Nat) : Bool := !(d.2.contains 0)

theorem old_unverified_reports_removed :
    let r := runOld editFirst (fun _ d => d) ([0], [0, 1])
    r.status = .removed ∧ activeGone r.final = false := by
  decide

/-- The same document under the fixed code (no duplicate-key guard even needed):
verification refuses it. -/
theorem verified_refuses_duplicate :
    (run editFirst activeGone (fun _ d => d) 3 0 ([0], [0, 1])).status = .refused := by
  decide

end Snapshot

end Cleanup

/-! ## 2. The shared header file (`headerHolders`, finding I2)

Each editor config has a real state on disk and what a `stat` of its path
shows: when a parent folder cannot be traversed (EACCES) the path cannot be
looked at, whatever is there. `parse t = none` is a parse failure,
`some has` whether the legacy entry is there; `names t` whether the text names
the header file. The header goes only when no config is a holder. -/
namespace Header

variable {T : Type}

inductive Real (T : Type) | missing | file (t : T)

structure Cfg (T : Type) where
  real   : Real T
  denied : Bool   -- the path cannot be looked at (EACCES/EPERM/ELOOP…)

/-- Fixed: `lookup` is tri-state; only ENOENT/ENOTDIR is "absent". -/
def holderNew (parse : T → Option Bool) (names : T → Bool) (c : Cfg T) : Bool :=
  if c.denied then true
  else match c.real with
    | .missing => false
    | .file t => match parse t with
      | none => true
      | some has => has || names t

/-- Original: `existsSync` is false for a path it cannot stat, so a denied
path was skipped as if absent. -/
def holderOld (parse : T → Option Bool) (names : T → Bool) (c : Cfg T) : Bool :=
  if c.denied then false
  else match c.real with
    | .missing => false
    | .file t => match parse t with
      | none => true
      | some has => has || names t

def removes (holder : Cfg T → Bool) (cs : List (Cfg T)) : Bool := cs.all (fun c => !holder c)

/-- Fixed: the header is removed only when every config on disk was read,
parsed, has no legacy entry and does not name the file. -/
theorem removed_only_when_unreferenced (parse : T → Option Bool) (names : T → Bool)
    (cs : List (Cfg T)) (h : removes (holderNew parse names) cs = true) :
    ∀ c ∈ cs, ∀ t, c.real = .file t → c.denied = false ∧ parse t = some false ∧ names t = false := by
  intro c hc t ht
  simp only [removes, List.all_eq_true] at h
  have hc' := h c hc
  simp only [holderNew, ht] at hc'
  cases hd : c.denied
  · simp only [hd] at hc'
    cases hp : parse t with
    | none => simp [hp] at hc'
    | some has =>
      simp only [hp] at hc'
      cases has <;> cases hn : names t <;> simp_all
  · simp [hd] at hc'

theorem removal_reachable (parse : T → Option Bool) (names : T → Bool) :
    removes (holderNew parse names) [⟨.missing, false⟩, ⟨.missing, false⟩] = true := by
  simp [removes, holderNew]

/-- Counterexample for the original (replayed: formal-installer.test.ts I2):
a config behind an untraversable folder still has the legacy entry, and the
header is removed anyway. -/
theorem old_removes_referenced :
    removes (holderOld (fun b : Bool => some b) (fun _ => false)) [⟨.file true, true⟩] = true := by
  decide

end Header

/-! ## 3. Owner-only protection (`owner-only.ts`, `backupWriter`, `protectBackupDir`) -/
namespace OwnerOnly

/-- One icacls run pair. `principals` is what `icaclsPrincipals` parsed; names are
compared after `toLower` (abstracted as `norm`). -/
structure Icacls where
  setStatus  : Nat
  readStatus : Nat
  principals : List String

def protect (norm : String → String) (acct : Option String) (r : Icacls) : Bool :=
  match acct with
  | none => false
  | some a => r.setStatus == 0 && r.readStatus == 0 && !r.principals.isEmpty &&
      r.principals.all (fun p => norm p == norm a)

theorem protect_sound (norm : String → String) (acct : Option String) (r : Icacls) :
    protect norm acct r = true →
    ∃ a, acct = some a ∧ r.setStatus = 0 ∧ r.readStatus = 0 ∧ r.principals ≠ [] ∧
      ∀ p ∈ r.principals, norm p = norm a := by
  cases acct with
  | none => simp [protect]
  | some a =>
    intro h
    simp only [protect, Bool.and_eq_true, beq_iff_eq, List.all_eq_true, Bool.not_eq_true',
      List.isEmpty_eq_false_iff] at h
    exact ⟨a, rfl, h.1.1.1, h.1.1.2, h.1.2, h.2⟩

/-- The steps of one backup. `dirOk` is `protectBackupDir` (Unix: not a symlink,
a folder, our uid, mode read back 0700; Windows: `protect` of the folder),
`fileOk` the per-file check (Unix: fstat mode & 077 = 0; Windows: `protect`
of the empty file). -/
inductive Step | dirChecked | fileCreated | fileChecked | secretWritten | emptyRemoved
  deriving DecidableEq, Repr

def backupSteps (dirOk fileOk : Bool) : List Step :=
  if !dirOk then [.dirChecked]
  else if !fileOk then [.dirChecked, .fileCreated, .fileChecked, .emptyRemoved]
  else [.dirChecked, .fileCreated, .fileChecked, .secretWritten]

/-- The secret is copied only when both protections were established and verified. -/
theorem secret_only_when_protected (dirOk fileOk : Bool) :
    Step.secretWritten ∈ backupSteps dirOk fileOk → dirOk = true ∧ fileOk = true := by
  cases dirOk <;> cases fileOk <;> simp [backupSteps]

/-- A failed protection leaves no file behind (the empty one is unlinked). -/
theorem failure_leaves_nothing (fileOk : Bool) (h : fileOk = false) :
    backupSteps true fileOk = [.dirChecked, .fileCreated, .fileChecked, .emptyRemoved] := by
  simp [backupSteps, h]

theorem copy_reachable : Step.secretWritten ∈ backupSteps true true := by decide

end OwnerOnly

/-! ## 4. The hello proof (`hello.ts` runHello, `mcp-stdio.ts`) -/
namespace Hello

/-- What runHello does, as a trace. `open i` is a successful `openMcpSession`
(a failed one ends its own child, `mcp-stdio.ts` initialize catch). -/
inductive Act | mkTmp | marker | openS (i : Nat) | call (i : Nat) | close (i : Nat) | rmTmp
  deriving DecidableEq, Repr

structure Oracle where
  openOk  : Nat → Bool
  learnOk : Bool        -- the learn call returned and `failReason` was null

/-- Recall launches: open a FRESH process → recall → close, on the success and
the catch path alike. Every launch, the saving one (0) included, recalls this
way (Codex round 4, finding 1). -/
def rest (o : Oracle) : List Nat → List Act
  | [] => []
  | i :: is => (if o.openOk i then [.openS i, .call i, .close i] else []) ++ rest o is

/-- Fixed: the saving session (open 0, learn, close 0) ends before any recall. -/
def body (o : Oracle) (others : List Nat) : List Act :=
  if !o.openOk 0 then []
  else if !o.learnOk then [.openS 0, .call 0, .close 0]
  else [.openS 0, .call 0, .close 0] ++ rest o (0 :: others)

/-- Original: the first launch recalled inside the saving session, where the
saved row sits in the remote store's optimistic cache. -/
def bodyOld (o : Oracle) (others : List Nat) : List Act :=
  if !o.openOk 0 then []
  else if !o.learnOk then [.openS 0, .call 0, .close 0]
  else [.openS 0, .call 0, .call 0, .close 0] ++ rest o others

/-- The `try … finally rmSync` around everything after mkdtemp. -/
def trace (o : Oracle) (others : List Nat) : List Act :=
  [.mkTmp, .marker] ++ body o others ++ [.rmTmp]

/-- Sessions still open after a prefix of the trace. -/
def live : List Act → List Nat → List Nat
  | [], s => s
  | .openS i :: t, s => live t (i :: s)
  | .close i :: t, s => live t (s.erase i)
  | _ :: t, s => live t s

theorem live_append (a b : List Act) (s : List Nat) : live (a ++ b) s = live b (live a s) := by
  induction a generalizing s with
  | nil => rfl
  | cons x t ih => cases x <;> simp [live, ih]

theorem live_rest (o : Oracle) (is : List Nat) (s : List Nat) : live (rest o is) s = s := by
  induction is generalizing s with
  | nil => rfl
  | cons i t ih =>
    simp only [rest, live_append]
    cases o.openOk i <;> simp [live, ih]

/-- Every opened MCP child is closed (killed if needed) on every exit path. -/
theorem every_session_closed (o : Oracle) (others : List Nat) :
    live (trace o others) [] = [] := by
  simp only [trace, live_append, body]
  cases o.openOk 0 <;> cases o.learnOk <;> simp [live, live_rest]

/-- The temporary folder (and the `.plur.yaml` marker in it) is removed last, on every path. -/
theorem tmp_removed_last (o : Oracle) (others : List Nat) :
    (trace o others).getLast? = some .rmTmp := by
  unfold trace
  exact List.getLast?_concat

/-- `marker` is the only write, inside the temporary folder: the user's folder
map is not in the action set at all (structural, by construction of runHello). -/
theorem only_write_is_marker (o : Oracle) (others : List Nat) :
    ∀ a ∈ trace o others, a = .marker ∨ a = .mkTmp ∨ a = .rmTmp ∨
      (∃ i, a = .openS i ∨ a = .call i ∨ a = .close i) := by
  intro a _
  cases a <;> simp

/-- Windows: `rmSync` is best effort, so the marker survives exactly when it fails. -/
def markerLeft (rmOk : Bool) : Bool := !rmOk

theorem marker_left_iff (rmOk : Bool) : markerLeft rmOk = true ↔ rmOk = false := by
  cases rmOk <;> simp [markerLeft]

/-- Each request settles at the first of: its answer, the child's exit, or the
timer. The timer is always armed, so every call is bounded by `timeout`; on the
timer the child is terminated. -/
def settle (answer exit : Option Nat) (timeout : Nat) : Nat × Bool :=
  let t := min timeout (min (answer.getD timeout) (exit.getD timeout))
  (t, answer.all (fun a => timeout < a) && exit.all (fun e => timeout < e))

theorem call_bounded (answer exit : Option Nat) (timeout : Nat) :
    (settle answer exit timeout).1 ≤ timeout := by
  simp [settle]; omega

/-- `terminate`: SIGTERM, and SIGKILL after the grace period if still running. -/
def terminated (exitedOnTerm : Bool) : List String :=
  if exitedOnTerm then ["SIGTERM"] else ["SIGTERM", "SIGKILL"]

theorem kill_escalates (b : Bool) : b = false → "SIGKILL" ∈ terminated b := by
  intro h; simp [terminated, h]

/-- `failReason`: a save counts only when it reached the server with an id. -/
structure Learn where
  off      : Bool
  delivery : Option String
  idOk     : Bool    -- a non-empty string id

def saveConfirmed (r : Learn) : Bool := !r.off && r.delivery == some "remote" && r.idOk

theorem saved_means_remote (r : Learn) :
    saveConfirmed r = true → r.off = false ∧ r.delivery = some "remote" ∧ r.idOk = true := by
  simp only [saveConfirmed, Bool.and_eq_true, Bool.not_eq_true', beq_iff_eq]
  intro h; exact ⟨h.1.1, h.1.2, h.2⟩

/-- The saving session is closed before the first recall call: no recall
runs in the process whose optimistic cache holds the saved row. -/
theorem save_closed_before_recall (o : Oracle) (others : List Nat)
    (h0 : o.openOk 0 = true) (hl : o.learnOk = true) :
    body o others = [.openS 0, .call 0, .close 0] ++ rest o (0 :: others) := by
  simp [body, h0, hl]

/-- Counterexample for the original: the second `call 0` (the recall) comes
before `close 0`, inside the saving session. -/
theorem old_recalls_in_saving_session :
    bodyOld ⟨fun _ => true, true⟩ [] = [.openS 0, .call 0, .call 0, .close 0] := by decide

/-- One recall answer, as `recallShortfall` reads it (`hello.ts`). -/
structure Recall where
  remoteOk : Bool   -- `remote.state` = ok for THIS call
  complete : Bool   -- `results_complete` = true
  hostOk   : Bool   -- the intended server is a dialed host and answered ok
  hostRows : Bool   -- that host returned at least one row
  idIn     : Bool   -- the saved id is among the results

/-- Fixed: recalled only with the live-remote evidence. -/
def recalled (r : Recall) : Bool := r.remoteOk && r.complete && r.hostOk && r.hostRows && r.idIn

/-- Original: the id alone. -/
def recalledOld (r : Recall) : Bool := r.idIn

theorem recalled_means_live (r : Recall) :
    recalled r = true →
    r.remoteOk = true ∧ r.complete = true ∧ r.hostOk = true ∧ r.hostRows = true ∧ r.idIn = true := by
  simp only [recalled, Bool.and_eq_true]
  intro h; exact ⟨h.1.1.1.1, h.1.1.1.2, h.1.1.2, h.1.2, h.2⟩

theorem recalled_reachable : recalled ⟨true, true, true, true, true⟩ = true := by decide

/-- Counterexample for the original (replayed: enterprise-hello.test.ts
"a cached row"; enterprise-hello-real-mcp.test.ts 401/500/no rows): the server
leg failed, the cached id came back, and the old check called it recalled. -/
theorem old_accepts_cached_row :
    recalledOld ⟨false, false, false, false, true⟩ = true ∧
    recalled ⟨false, false, false, false, true⟩ = false := by decide

theorem reachable : live (trace ⟨fun _ => true, true⟩ [1, 2]) [] = [] := by decide

end Hello

/-! ## 5. Init arguments (`args.ts`, finding I5) and the URL contract

Tokens are abstract: `kind` classifies a token as a value flag (`--mode` apart,
which also checks its value), a boolean flag, or unknown; `flagLike` is
`startsWith('--')`; `isEmpty` is `=== ''`. -/
namespace Args

inductive Kind | server | otherValue | mode | boolean | unknown
  deriving DecidableEq

inductive R | err | ok (server : Option String)
  deriving DecidableEq

variable (kind : String → Kind) (flagLike : String → Bool) (modeOk : String → Bool)

/-- `fixed = false` is the original (an empty value was accepted). -/
def parse (fixed : Bool) : List String → Option String → R
  | [], srv => .ok srv
  | a :: rest, srv =>
    match kind a with
    | .boolean => parse fixed rest srv
    | .unknown => .err
    | k =>
      match rest with
      | [] => .err
      | v :: rest' =>
        if (fixed && v == "") || flagLike v then .err
        else if k == .mode && !modeOk v then .err
        else parse fixed rest' (if k == .server then some v else srv)

/-- `if (!server) server = env['PLUR_SERVER']`: an empty string is falsy. -/
def resolve (r : R) (env : Option String) : Option String :=
  match r with
  | .err => none
  | .ok (some s) => if s == "" then env else some s
  | .ok none => env

theorem unknown_is_error (a : String) (rest : List String) (srv : Option String)
    (h : kind a = .unknown) : parse kind flagLike modeOk true (a :: rest) srv = .err := by
  simp [parse, h]

theorem value_flag_needs_value (a : String) (srv : Option String)
    (h : kind a ≠ .boolean ∧ kind a ≠ .unknown) : parse kind flagLike modeOk true [a] srv = .err := by
  unfold parse; split <;> simp_all

theorem empty_value_is_error (a : String) (rest : List String) (srv : Option String)
    (h : kind a ≠ .boolean ∧ kind a ≠ .unknown) :
    parse kind flagLike modeOk true (a :: "" :: rest) srv = .err := by
  unfold parse; split <;> simp_all

/-- Fixed: a server that came from `--server` is never empty, so the env
fall-back is used only when no `--server` was given. -/
theorem given_server_nonempty :
    ∀ (args : List String) (srv : Option String) (s : String),
      (∀ x, srv = some x → x ≠ "") →
      parse kind flagLike modeOk true args srv = .ok (some s) → s ≠ ""
  | [], srv, s, hs, h => by
    simp [parse] at h; exact hs s h
  | [a], srv, s, hs, h => by
    unfold parse at h
    split at h
    · simp [parse] at h; exact hs s h
    · simp at h
    · simp at h
  | a :: v :: rest', srv, s, hs, h => by
    unfold parse at h
    split at h
    · exact given_server_nonempty (v :: rest') srv s hs h
    · simp at h
    · simp only at h
      split at h
      · simp at h
      · rename_i hv
        split at h
        · simp at h
        · refine given_server_nonempty rest' _ s ?_ h
          intro x hx
          split at hx
          · simp at hx; subst hx; simp_all
          · exact hs x hx

/-- Counterexample for the original (replayed: `--server ""` → PLUR_SERVER). -/
theorem old_empty_server_falls_back (env : String)
    (hk : kind "--server" = .server) (hf : flagLike "" = false) :
    resolve (parse kind flagLike modeOk false ["--server", ""] none) (some env) = some env := by
  simp [parse, hk, hf, resolve]

/-! ### The http-loopback rule vs the served installer (`served-installer.ts`)

Hosts as the two validators see them. CLI: `LOCALHOST_HOSTNAMES` =
localhost, 127.0.0.1, [::1] (after WHATWG parsing). Server:
`LOOPBACK_HOST_RE` = localhost, 127.x.y.z (any 1–3 digit octets), [::1]. -/
inductive Host | localhost | v4 (a b c d : Nat) | v6loop | name (s : String)

def cliHttpOk : Host → Bool
  | .localhost => true
  | .v4 a b c d => a == 127 && b == 0 && c == 0 && d == 1
  | .v6loop => true
  | .name _ => false

def serverHttpOk : Host → Bool
  | .localhost => true
  | .v4 a _ _ _ => a == 127
  | .v6loop => true
  | .name _ => false

/-- Everything the CLI accepts over http, the server accepts too. -/
theorem cli_subset_server (h : Host) : cliHttpOk h = true → serverHttpOk h = true := by
  cases h <;> simp_all [cliHttpOk, serverHttpOk]

/-- CONTRACT MISMATCH (replayed against both real validators): the server bakes
`http://127.0.0.2:…` into the script, and `plur-enterprise init` refuses it. -/
theorem mismatch_127_slash_8 : serverHttpOk (.v4 127 0 0 2) = true ∧ cliHttpOk (.v4 127 0 0 2) = false := by
  decide

/-- CONTRACT MISMATCH: the server accepts a base path and bakes it; the CLI
keeps only the origin, so a server under `/plur` is addressed at `/`. -/
structure Url where
  host : Host
  path : List String

def cliServer (u : Url) : Url := { u with path := [] }

theorem path_dropped (u : Url) (h : u.path ≠ []) : cliServer u ≠ u := by
  intro e; apply h; rw [← e]; rfl

end Args

/-! ## 6. The summary's tool line (`summary.ts`, finding I6) -/
namespace Summary

inductive Status | wired | refused | otherSide | failed
  deriving DecidableEq

structure Tool where
  status     : Status
  versionBad : Bool          -- `version` present and not ok
  proven     : Bool
  recalled   : Option Bool   -- this tool's entry in hello.perTool, if any

inductive Line | plainWired | notProven | otherSide | refused | failed
  deriving DecidableEq

/-- Fixed: plain "wired — restart" needs the evidence in the same result. -/
def lineNew (savedOk : Option Bool) (t : Tool) : Line :=
  if t.status == .wired && t.versionBad then .notProven
  else if t.status == .wired && t.proven && savedOk == some true && t.recalled == some true then .plainWired
  else if t.status == .wired then .notProven
  else if t.status == .otherSide then .otherSide
  else if t.status == .refused then .refused
  else .failed

/-- Original: the `proven` flag alone. -/
def lineOld (_savedOk : Option Bool) (t : Tool) : Line :=
  if t.status == .wired && t.versionBad then .notProven
  else if t.status == .wired && t.proven then .plainWired
  else if t.status == .wired then .notProven
  else if t.status == .otherSide then .otherSide
  else if t.status == .refused then .refused
  else .failed

/-- No failure is collapsed into success: plainly wired means the version
check did not fail, the hello save was confirmed and this tool recalled it. -/
theorem plain_wired_has_evidence (savedOk : Option Bool) (t : Tool) :
    lineNew savedOk t = .plainWired →
    t.status = .wired ∧ t.versionBad = false ∧ t.proven = true ∧ savedOk = some true ∧ t.recalled = some true := by
  unfold lineNew
  cases hs : t.status <;> cases hv : t.versionBad <;> cases hp : t.proven <;>
    cases hr : t.recalled <;> cases savedOk <;> simp_all <;>
    (try (rename_i b; cases b <;> simp_all)) <;>
    (try (rename_i b c; cases b <;> cases c <;> simp_all))

theorem plain_wired_reachable :
    lineNew (some true) ⟨.wired, false, true, some true⟩ = .plainWired := by decide

/-- Counterexample for the original (replayed: formal-installer.test.ts I6). -/
theorem old_collapses_failed_save :
    lineOld (some false) ⟨.wired, false, true, none⟩ = .plainWired := by decide

end Summary

end PlurSpec.Installer
