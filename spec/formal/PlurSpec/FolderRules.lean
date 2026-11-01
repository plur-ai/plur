/-!
# Folder rules: policy resolution, the MCP gate, mode guesses, answer nonces

Models, branch for branch:
* `resolveExplicitFolderPolicy` / `resolveFolderPolicy` (packages/core/src/folders.ts).
  Path matching (entry forms, globs, case) is abstracted into the facts the
  resolver reads: whether an `off` entry matches, the most specific explicit
  mode entry, the most specific deciding entry, a marker, an untrusted
  `.plur.yaml` request, the map scope.
* `createFolderGate().check` (packages/mcp/src/folder-gate.ts): the off check
  reads the map once, the per-folder loop reads it again, so the two reads are
  separate policy functions (the map may change in between).
* `suggestMode` (packages/core/src/folder-map-check.ts), with edit distance as
  an arbitrary oracle.
* Nonces (folders.ts): `answerKey`, `verifyFolderNonce`, the set flow that
  consumes only after the save, and `hostFolderNonces`' host match.
-/
namespace PlurSpec.FolderRules

inductive Mode where
  | on | off | ask | remoteOnly
  deriving DecidableEq, Repr

inductive Reason where
  | malformed | untrusted
  deriving DecidableEq, Repr

inductive Source where
  | map | plurYaml | marker | default | git
  deriving DecidableEq, Repr

structure Policy where
  mode : Mode
  reason : Option Reason := none
  source : Source
  scope : Option Nat := none
  deriving DecidableEq, Repr

/-- What the resolver reads from the map and the folder. -/
structure View where
  malformed : Bool
  offMatch : Bool
  /-- Most specific entry with an explicit `plur:` mode (remote-only matched as widely as off). -/
  bestMode : Option Mode
  /-- Most specific deciding entry: `some m` with its `plur:` (none = trusted/scope only). -/
  deciding : Option (Option Mode)
  marker : Bool
  untrustedRequest : Bool
  mapScope : Option Nat
  configScope : Option Nat

/-- resolveExplicitFolderPolicy, in its order. -/
def resolveExplicit (v : View) : Policy :=
  if v.malformed then { mode := .ask, reason := some .malformed, source := .default } else
  if v.offMatch then { mode := .off, source := .map } else
  if v.bestMode = some .remoteOnly then { mode := .remoteOnly, source := .map, scope := v.mapScope } else
  if v.untrustedRequest && v.deciding.isNone then
    { mode := .ask, reason := some .untrusted, source := .plurYaml } else
  if v.marker && !v.untrustedRequest then
    { mode := .on, source := .marker, scope := v.mapScope.orElse (fun _ => v.configScope) } else
  match v.deciding with
  | some m =>
    let mode := m.getD .on
    { mode := mode, source := .map, scope := if mode = .on then v.mapScope else none }
  | none => { mode := .ask, source := .default }

inductive GitOutcome where
  | notGit | scope (s : Nat) | other
  deriving DecidableEq

/-- resolveFolderPolicy: a git default only fills an absent default. -/
def resolve (v : View) (hasSources coversHome : Bool) (g : GitOutcome) : Policy :=
  let p := resolveExplicit v
  if !hasSources || p.scope.isSome || p.reason.isSome ||
     !(p.mode = .on || (p.mode = .ask && p.source = .default)) then p else
  if coversHome then p else
  match g with
  | .notGit => p
  | .scope s => { p with mode := .on, source := .git, scope := some s }
  | .other => { p with mode := .on, source := .git }

theorem malformed_never_on (v : View) (h : v.malformed = true) (src home : Bool) (g : GitOutcome) :
    (resolve v src home g).mode = .ask ∧ (resolve v src home g).reason = some .malformed := by
  simp [resolve, resolveExplicit, h]

theorem off_always_off (v : View) (h : v.offMatch = true) (src home : Bool) (g : GitOutcome) :
    v.malformed = false → (resolve v src home g).mode = .off := by
  intro hm
  simp [resolve, resolveExplicit, h, hm]

/-- A repository marker, an untrusted request or a git default never undo remote-only. -/
theorem remote_only_kept (v : View) (src home : Bool) (g : GitOutcome)
    (hm : v.malformed = false) (ho : v.offMatch = false) (hr : v.bestMode = some .remoteOnly) :
    (resolve v src home g).mode = .remoteOnly := by
  simp [resolve, resolveExplicit, hm, ho, hr]

/-- An untrusted `.plur.yaml` with no deciding entry asks, whatever git says. -/
theorem untrusted_asks (v : View) (src home : Bool) (g : GitOutcome)
    (hm : v.malformed = false) (ho : v.offMatch = false) (hr : v.bestMode ≠ some .remoteOnly)
    (hu : v.untrustedRequest = true) (hd : v.deciding = none) :
    (resolve v src home g).mode = .ask := by
  simp [resolve, resolveExplicit, hm, ho, hr, hu, hd]

/-- An explicit `ask` entry is never switched on by a git default. -/
theorem explicit_ask_kept (v : View) (src home : Bool) (g : GitOutcome)
    (hm : v.malformed = false) (ho : v.offMatch = false) (hr : v.bestMode ≠ some .remoteOnly)
    (hu : v.untrustedRequest = false) (hk : v.marker = false) (hd : v.deciding = some (some .ask)) :
    (resolve v src home g).mode = .ask := by
  simp [resolve, resolveExplicit, hm, ho, hr, hu, hk, hd]

/-- The home folder keeps asking even inside a repository. -/
theorem home_keeps_asking (v : View) (src : Bool) (g : GitOutcome)
    (h : resolveExplicit v = { mode := .ask, source := .default }) :
    (resolve v src true g).mode = .ask := by
  simp [resolve, h]

/-- Not vacuous: an undecided folder in a mapped repository is switched on by git. -/
theorem git_fills_default :
    (resolve ⟨false, false, none, none, false, false, none, none⟩ true false (.scope 7)) =
      { mode := .on, source := .git, scope := some 7 } := by decide

/-! ## The MCP gate -/

inductive Outcome where
  | run | question | offAnswer
  deriving DecidableEq, Repr

/-- The per-folder loop of `check`, as fixed: only on and remote-only continue. -/
def gateLoop (pol : Nat → Mode) : List Nat → Outcome
  | [] => .run
  | d :: ds =>
    match pol d with
    | .ask => .question
    | .on | .remoteOnly => gateLoop pol ds
    | .off => .offAnswer

/-- The loop before the fix: anything but ask continued. -/
def gateLoopOld (pol : Nat → Mode) : List Nat → Outcome
  | [] => .run
  | d :: ds => if pol d = .ask then .question else gateLoopOld pol ds

/-- check: the off check over every folder (first read), then the loop (second read). -/
def check (offRead loopRead : Nat → Mode) (all askable : List Nat) : Outcome :=
  if all.any (fun d => offRead d = .off) then .offAnswer else gateLoop loopRead askable

def checkOld (offRead loopRead : Nat → Mode) (all askable : List Nat) : Outcome :=
  if all.any (fun d => offRead d = .off) then .offAnswer else gateLoopOld loopRead askable

theorem gateLoop_runs_only_on (pol : Nat → Mode) :
    ∀ ds, gateLoop pol ds = .run → ∀ d ∈ ds, pol d = .on ∨ pol d = .remoteOnly := by
  intro ds
  induction ds with
  | nil => intro _ d hd; cases hd
  | cons x xs ih =>
    intro h d hd
    unfold gateLoop at h
    cases hx : pol x <;> rw [hx] at h <;> simp at h
    all_goals
      cases hd with
      | head => simp [hx]
      | tail _ hm => exact ih h d hm

/-- Whatever the map said at the off check, the tool runs only when every
asked-about folder is on or remote-only at the second read. -/
theorem check_runs_only_on (offRead loopRead : Nat → Mode) (all askable : List Nat)
    (h : check offRead loopRead all askable = .run) :
    ∀ d ∈ askable, loopRead d = .on ∨ loopRead d = .remoteOnly := by
  unfold check at h
  split at h
  · cases h
  · exact gateLoop_runs_only_on loopRead askable h

/-- Undecided never runs: a folder that reads ask yields the question or an off answer. -/
theorem check_ask_never_runs (offRead loopRead : Nat → Mode) (all askable : List Nat)
    (d : Nat) (hd : d ∈ askable) (ha : loopRead d = .ask) :
    check offRead loopRead all askable ≠ .run := by
  intro h
  have := check_runs_only_on offRead loopRead all askable h d hd
  rw [ha] at this
  cases this <;> contradiction

/-- The defect, replayed against folder-gate.ts: off at the second read, the tool ran. -/
theorem old_gate_runs_in_off_folder :
    checkOld (fun _ => .on) (fun _ => .off) [1] [1] = .run := by decide

theorem new_gate_refuses_that : check (fun _ => .on) (fun _ => .off) [1] [1] = .offAnswer := by decide

/-- Not vacuous: an on workspace runs. -/
theorem gate_runs_when_on : check (fun _ => .on) (fun _ => .on) [1, 2] [1] = .run := by decide

/-- The home folder is not in `askable`: an undecided home with no roots runs (owner question). -/
theorem home_undecided_runs : check (fun _ => .ask) (fun _ => .ask) [0] [] = .run := by decide

/-! ## Mode guesses in a repair (suggestMode) -/

def MODES : List String := ["on", "off", "ask", "remote-only"]
def YES_NO : List String := ["yes", "no", "y", "n", "true", "false", "none", "non", "null", "~"]

/-- The one-letter-off branch: a unique near mode, never on or remote-only. -/
def guessNear (dist : String → String → Nat) (lower : String) : Option String :=
  match MODES.filter (fun m => dist lower m == 1) with
  | [m] => if m ≠ "on" ∧ m ≠ "remote-only" then some m else none
  | _ => none

/-- `lower` is the lower-cased printable token; `dist` is any edit distance. -/
def suggestMode (dist : String → String → Nat) (printable : Bool) (lower : String) : Option String :=
  if !printable then none else
  if lower ∈ MODES then some lower else
  if lower.length < 3 || lower ∈ YES_NO then none else
  guessNear dist lower

theorem guessNear_safe (dist : String → String → Nat) (lower m : String)
    (h : guessNear dist lower = some m) : m ≠ "on" ∧ m ≠ "remote-only" := by
  unfold guessNear at h
  split at h
  · split at h
    · rename_i hne; cases h; exact hne
    · cases h
  · cases h

theorem suggest_safe (dist : String → String → Nat) (p : Bool) (lower m : String)
    (h : suggestMode dist p lower = some m) : m = lower ∨ (m ≠ "on" ∧ m ≠ "remote-only") := by
  unfold suggestMode at h
  split at h
  · cases h
  · split at h
    · cases h; left; rfl
    · split at h
      · cases h
      · right; exact guessNear_safe dist lower m h

/-- A guess never switches memory on: on comes only from the token on itself. -/
theorem guess_never_on (dist : String → String → Nat) (p : Bool) (lower : String)
    (h : suggestMode dist p lower = some "on") : lower = "on" := by
  rcases suggest_safe dist p lower "on" h with h' | h'
  · exact h'.symm
  · exact absurd rfl h'.1

/-- A near-miss of remote-only is left alone. -/
theorem guess_never_remote_only (dist : String → String → Nat) (p : Bool) (lower : String)
    (h : suggestMode dist p lower = some "remote-only") : lower = "remote-only" := by
  rcases suggest_safe dist p lower "remote-only" h with h' | h'
  · exact h'.symm
  · exact absurd rfl h'.2

/-- Not vacuous: a one-letter slip is guessed when it points only at off. -/
theorem guess_off_reachable :
    suggestMode (fun a b => if a = "ofx" ∧ b = "off" then 1 else 5) true "ofx" = some "off" := by decide

/-! ## Answer nonces -/

/-- A FolderAnswer. Scope is a stand-in number. -/
inductive Answer where
  | set (mode : Option Mode) (scope : Option Nat) (trusted : Option Bool)
  | remove | notNow
  | malformed
  deriving DecidableEq, Repr

inductive Key where
  | set (mode : Option Mode) (scope : Option Nat) (trusted : Option Bool)
  | remove | notNow
  deriving DecidableEq, Repr

/-- answerKey: `--scope X` alone means on; a record with no bound answer has no key. -/
def answerKey : Answer → Option Key
  | .set m s t => some (.set (m.orElse (fun _ => if s.isSome then some .on else none)) s t)
  | .remove => some .remove
  | .notNow => some .notNow
  | .malformed => none

/-- What a set writes for the mode, given the merged mode in effect (setFolderEntryUnlocked). -/
def effMode (m : Option Mode) (s : Option Nat) (cur : Option Mode) : Option Mode :=
  match m with
  | some x => some x
  | none => if s.isSome then (if cur = some .remoteOnly then some .remoteOnly else some .on) else cur

/-- Two answers with the same key make the same write in a folder that is not
remote-only (the folder question is asked only where the folder is undecided). -/
theorem same_key_same_write (m₁ m₂ : Option Mode) (s₁ s₂ : Option Nat) (t₁ t₂ : Option Bool)
    (cur : Option Mode) (hc : cur ≠ some .remoteOnly)
    (h : answerKey (.set m₁ s₁ t₁) = answerKey (.set m₂ s₂ t₂)) :
    effMode m₁ s₁ cur = effMode m₂ s₂ cur ∧ s₁ = s₂ ∧ t₁ = t₂ := by
  simp only [answerKey, Option.some.injEq, Key.set.injEq] at h
  obtain ⟨hm, hs, ht⟩ := h
  subst hs; subst ht
  refine ⟨?_, rfl, rfl⟩
  cases m₁ <;> cases m₂ <;> cases s₁ <;> simp_all [effMode, Option.orElse]

/-- Residual, documented: on a folder that became remote-only after the question,
`--scope X` keeps remote-only while `--scope X --on` (same key) leaves it. -/
theorem same_key_differs_on_remote_only :
    answerKey (.set none (some 1) none) = answerKey (.set (some .on) (some 1) none) ∧
    effMode none (some 1) (some .remoteOnly) ≠ effMode (some .on) (some 1) (some .remoteOnly) := by
  decide

/-- The trusted flag is part of the key: a plain yes never grants --trusted. -/
theorem trusted_distinguished (m : Option Mode) (s : Option Nat) :
    answerKey (.set m s none) ≠ answerKey (.set m s (some true)) := by
  simp [answerKey]

structure Record where
  nonce : Nat
  folder : Nat
  answer : Answer
  deriving DecidableEq, Repr

abbrev Store := List Record

inductive VErr where
  | unknown | folder | answer
  deriving DecidableEq, Repr

/-- verifyFolderNonce (session and expiry checks elided; each refuses without consuming). -/
def verify (st : Store) (n f : Nat) (a : Answer) : Except VErr Record :=
  match st.find? (fun r => r.nonce == n) with
  | none => .error .unknown
  | some r =>
    if r.folder ≠ f then .error .folder else
    match answerKey r.answer with
    | none => .error .answer
    | some k => if some k = answerKey a then .ok r else .error .answer

def consume (st : Store) (n : Nat) : Store := st.filter (fun r => r.nonce != n)

/-- The set flow: verify, then any refusal before the save (`fail`), then save, then consume. -/
def setFlow (st : Store) (n f : Nat) (a : Answer) (fail : Bool) : Option Store :=
  match verify st n f a with
  | .error _ => none
  | .ok _ => if fail then none else some (consume st n)

theorem verify_binds (st : Store) (n f : Nat) (a : Answer) (r : Record)
    (h : verify st n f a = .ok r) :
    r.folder = f ∧ answerKey r.answer = answerKey a ∧ answerKey a ≠ none := by
  unfold verify at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · rename_i hf k hk hka
          cases h
          refine ⟨by simp_all, by rw [hk]; exact hka, ?_⟩
          rw [← hka]; simp
        · cases h

theorem unbound_record_authorises_nothing (st : Store) (n f : Nat) (a : Answer) (r : Record)
    (hr : r.answer = .malformed) : verify st n f a ≠ .ok r := by
  intro h
  have := (verify_binds st n f a r h).2
  rw [hr] at this
  simp [answerKey] at this
  exact this.2 this.1.symm

/-- A refused or failed write never consumes: the store is untouched (setFlow returns none). -/
theorem failed_write_keeps_nonce (st : Store) (n f : Nat) (a : Answer) :
    setFlow st n f a true = none := by
  unfold setFlow; split <;> rfl

theorem verify_absent (st : Store) (n f : Nat) (a : Answer)
    (h : ∀ r ∈ st, r.nonce ≠ n) : verify st n f a = .error .unknown := by
  unfold verify
  have : st.find? (fun r => r.nonce == n) = none := by
    rw [List.find?_eq_none]; intro r hr; simp [h r hr]
  rw [this]

/-- Single use: after a successful write, the same nonce is refused for every answer and folder. -/
theorem nonce_single_use (st st' : Store) (n f : Nat) (a : Answer)
    (h : setFlow st n f a false = some st') (f' : Nat) (a' : Answer) :
    verify st' n f' a' = .error .unknown := by
  unfold setFlow at h
  split at h
  · cases h
  · simp at h; subst h
    apply verify_absent
    intro r hr
    simp [consume] at hr
    exact hr.2

/-- Issue: a nonce larger than every outstanding one, so each offered answer gets its own. -/
def fresh (st : Store) : Nat := st.foldr (fun r m => max r.nonce m) 0 + 1

theorem fresh_gt (st : Store) : ∀ r ∈ st, r.nonce < fresh st := by
  induction st with
  | nil => intro r hr; cases hr
  | cons x xs ih =>
    intro r hr
    simp only [fresh, List.foldr] at *
    cases hr with
    | head => omega
    | tail _ hm => have := ih r hm; omega

def issue (st : Store) (f : Nat) (a : Answer) : Store := ⟨fresh st, f, a⟩ :: st

/-- A nonce issued for one answer is refused for another key: offering several
answers issues one nonce each, and none grants another. -/
theorem issued_grants_only_its_answer (st : Store) (f : Nat) (a b : Answer)
    (hk : answerKey a ≠ answerKey b) : ∀ r, verify (issue st f a) (fresh st) f b ≠ .ok r := by
  intro r h
  have hb := verify_binds _ _ _ _ _ h
  have hfind : (issue st f a).find? (fun r => r.nonce == fresh st) = some ⟨fresh st, f, a⟩ := by
    simp [issue]
  unfold verify at h
  rw [hfind] at h
  simp at h
  split at h
  · cases h
  · rename_i k hk'
    split at h
    · rename_i he; exact hk (by rw [hk']; exact he)
    · cases h

theorem issued_works_once (st : Store) (f : Nat) (a : Answer) (k : Key) (hk : answerKey a = some k) :
    ∃ st', setFlow (issue st f a) (fresh st) f a false = some st' ∧
      verify st' (fresh st) f a = .error .unknown := by
  have hv : verify (issue st f a) (fresh st) f a = .ok ⟨fresh st, f, a⟩ := by
    simp [verify, issue, hk]
  refine ⟨consume (issue st f a) (fresh st), by simp [setFlow, hv], ?_⟩
  apply verify_absent
  intro r hr
  simp [consume] at hr
  exact hr.2

/-! ## Host match (hostFolderNonces) -/

structure Host where
  pid : Nat
  started : Int

/-- A nonce file's host matches only with a recorded start time within the tolerance. -/
def hostMatches (tol : Nat) (hosts : List Host) (pid : Option Nat) (started : Option Int) : Bool :=
  match pid, started with
  | some p, some s => hosts.any (fun h => h.pid == p && (h.started - s).natAbs ≤ tol)
  | _, _ => false

theorem no_start_no_match (tol : Nat) (hosts : List Host) (pid : Option Nat) :
    hostMatches tol hosts pid none = false := by cases pid <;> rfl

theorem match_same_pid_close (tol : Nat) (hosts : List Host) (p : Nat) (s : Int)
    (h : hostMatches tol hosts (some p) (some s) = true) :
    ∃ x ∈ hosts, x.pid = p ∧ (x.started - s).natAbs ≤ tol := by
  simp [hostMatches] at h
  obtain ⟨x, hx, hp, ht⟩ := h
  exact ⟨x, hx, hp, ht⟩

/-- A reused id that started more than the tolerance apart never matches. -/
theorem reused_pid_far_start (tol : Nat) (p : Nat) (s s' : Int) (h : tol < (s' - s).natAbs) :
    hostMatches tol [⟨p, s'⟩] (some p) (some s) = false := by
  simp [hostMatches]; omega

/-- Residual, documented: a reused id started within the tolerance is indistinguishable. -/
theorem reused_pid_close_start_matches :
    hostMatches 3000 [⟨42, 1_000_000⟩] (some 42) (some 1_002_000) = true := by decide

end PlurSpec.FolderRules
