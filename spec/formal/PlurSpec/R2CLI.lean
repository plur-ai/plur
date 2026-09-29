/-!
# PlurSpec.R2CLI — CLI hook sessions (formal round 2)

Models of `packages/cli/src/lib/{codex,cursor,agy}-hook-io.ts` and
`packages/cli/src/commands/{hook-inject,hook-learn-check,hook-session-end,
hook-session-guard,hook-agy-pre-invocation,doctor,recall,…}.ts`.
Findings, verdicts and replays: `spec/formal/findings/r2-cli.md`.

File contents, capture results, process liveness and string sanitisation are
abstract (oracles / parameters): every theorem holds for all of them. Each
section states the property of the FIXED code, proves it, exhibits a
counterexample theorem for the ORIGINAL code, and a reachability theorem so the
property is not vacuous.
-/

namespace PlurSpec.R2CLI

/-! ## 1. Session-directory vetting (cli#8)

A state directory, as `lstat` sees it. `plantable` is what lets another user
put a file into it: it is a symlink (points wherever they chose), belongs to
someone else, or is group/other-writable. -/
namespace Vet

structure Dir where
  symlink  : Bool
  ownedByMe : Bool
  gow      : Bool      -- mode & 0o022 ≠ 0
deriving DecidableEq, Repr

def plantable (d : Dir) : Bool := d.symlink || !d.ownedByMe || d.gow

/-- `sessionDirTrusted` (codex-hook-io.ts). -/
def trusted (d : Dir) : Bool := !d.symlink && d.ownedByMe && !d.gow

/-- The two predicates are exact complements: trust ⇔ nobody else could plant. -/
theorem trusted_iff_not_plantable (d : Dir) : trusted d = !plantable d := by
  cases d with
  | mk s o g => cases s <;> cases o <;> cases g <;> rfl

/-- ORIGINAL readers (`readAgyTurnCache`, `isSessionStarted`, `existsSync(sentinel)`):
whatever sits in the directory is believed. -/
def readOrig (_d : Dir) (contents : Option α) : Option α := contents

/-- FIXED readers: contents only from a trusted directory. -/
def readFixed (d : Dir) (contents : Option α) : Option α :=
  if trusted d then contents else none

/-- Property: nothing read from a plantable directory is ever believed. -/
theorem fixed_never_reads_plantable (d : Dir) (c : Option α) (h : plantable d = true) :
    readFixed d c = none := by
  have : trusted d = false := by rw [trusted_iff_not_plantable, h]; rfl
  simp [readFixed, this]

/-- Counterexample (replayed): a symlinked dir holding an attacker's turn cache —
the original reader returns it, and the hook emits it as recalled memory. -/
theorem orig_reads_planted :
    readOrig ⟨true, true, false⟩ (some "PLANTED-BY-ATTACKER") = some "PLANTED-BY-ATTACKER" := rfl

/-- Non-vacuity: a real 0700 dir of ours is read. -/
theorem fixed_reads_own (c : Option α) : readFixed ⟨false, true, false⟩ c = c := rfl

/-- Writers. ORIGINAL Cursor `markSessionStarted`/`incrementCounter`: computed the
verdict in `sessionsDir()` and wrote regardless. FIXED: write only when vetted. -/
def writesOrig (_ensureOk : Bool) : Bool := true
def writesFixed (ensureOk : Bool) : Bool := ensureOk

theorem fixed_writes_only_vetted (ok : Bool) (h : writesFixed ok = true) : ok = true := h
theorem orig_writes_refused : writesOrig false = true := rfl

/-- Tool names as Claude Code builds them: `mcp__<server>__<tool>`. -/
inductive Tool where
  | mcp (server tool : String)
  | builtin (name : String)
deriving DecidableEq

/-- ORIGINAL Claude guard exemption: the exact name only. -/
def exemptOrig : Tool → Bool
  | .mcp s t => s == "plur" && t == "plur_session_start"
  | .builtin n => n == "ToolSearch"

/-- FIXED: any server's `plur_session_start` (the suffix rule of the other guards). -/
def exemptFixed : Tool → Bool
  | .mcp _ t => t == "plur_session_start"
  | .builtin n => n == "ToolSearch"

theorem fixed_exempts_every_server (s : String) :
    exemptFixed (.mcp s "plur_session_start") = true := by simp [exemptFixed]

theorem orig_denies_plugin_server :
    exemptOrig (.mcp "plugin_plur_plur" "plur_session_start") = false := by decide

/-- The fix is only a widening: everything exempt before is exempt now. -/
theorem fixed_extends_orig (t : Tool) (h : exemptOrig t = true) : exemptFixed t = true := by
  cases t with
  | mcp s x => simp [exemptOrig] at h; simp [exemptFixed, h.2]
  | builtin n => exact h

/-- ...and it is not "exempt everything": an ordinary tool is still gated. -/
theorem fixed_gates_bash : exemptFixed (.builtin "Bash") = false := by decide

end Vet

/-! ## 2. Checkpoint lifecycle (cli#6)

One scan step of `processDeferredWrapups` over one checkpoint file. The capture
result and pid liveness are oracles. -/
namespace Checkpoint

inductive Cp where
  | corrupt
  | valid (ageMin : Nat) (pidKey : Bool) (alive : Bool)

structure Outcome where
  captured : Bool
  removed  : Bool      -- unlinked (a rename aside is NOT removal: bytes kept)
  notice   : Bool
deriving DecidableEq, Repr

def keep : Outcome := ⟨false, false, false⟩

/-- ORIGINAL (hook-inject.ts 220-271). -/
def stepOrig (staleMin : Nat) : Cp → Outcome
  | .corrupt => ⟨false, true, false⟩
  | .valid age _ _ => if age < staleMin then keep else ⟨false, true, true⟩

/-- FIXED: quarantine corrupt, skip live pid-keyed, capture BEFORE unlink. -/
def stepFixed (staleMin : Nat) (captureOk : Bool) : Cp → Outcome
  | .corrupt => keep
  | .valid age pidKey alive =>
      if age < staleMin then keep
      else if pidKey && alive then keep
      else if captureOk then ⟨true, true, true⟩ else keep

/-- THE property: a checkpoint is removed only after a durable capture. -/
theorem removed_only_after_capture (t : Nat) (ok : Bool) (c : Cp)
    (h : (stepFixed t ok c).removed = true) : (stepFixed t ok c).captured = true := by
  cases c with
  | corrupt => simp [stepFixed, keep] at h
  | valid a p l =>
    simp only [stepFixed] at h ⊢
    by_cases h1 : a < t
    · rw [ite_eq_left h1] at h; simp [keep] at h
    · rw [ite_eq_right h1] at h ⊢
      by_cases h2 : (p && l) = true
      · rw [ite_eq_left h2] at h; simp [keep] at h
      · rw [ite_eq_right h2] at h ⊢
        cases ok
        · simp [keep] at h
        · rfl

/-- A live session (its pid still running) is never recovered as an orphan. -/
theorem live_session_kept (t a : Nat) (ok : Bool) :
    (stepFixed t ok (.valid a true true)).removed = false := by
  simp only [stepFixed]; split <;> simp [keep]

/-- Counterexamples (replayed): the original removed a stale valid checkpoint with
no capture, removed a corrupt one, and removed a LIVE session's checkpoint. -/
theorem orig_removes_uncaptured :
    stepOrig 5 (.valid 30 false false) = ⟨false, true, true⟩ := rfl
theorem orig_removes_corrupt : (stepOrig 5 .corrupt).removed = true := rfl
theorem orig_removes_live : (stepOrig 5 (.valid 30 true true)).removed = true := rfl

/-- Non-vacuity: a dead session's stale checkpoint IS recovered and removed. -/
theorem orphan_recovered : stepFixed 5 true (.valid 30 true false) = ⟨true, true, true⟩ := rfl

/-- hook-session-end (#217, unchanged): unlink iff capture succeeded. -/
def sessionEnd (captureOk : Bool) : Outcome := ⟨captureOk, captureOk, false⟩
theorem session_end_removed_only_after_capture (ok : Bool)
    (h : (sessionEnd ok).removed = true) : (sessionEnd ok).captured = true := h

/-- Store root: `--path`, then PLUR_PATH, then ~/.plur. -/
def rootFixed (flag env : Option String) (home : String) : String :=
  (flag <|> env).getD home
/-- ORIGINAL writer and scan: PLUR_PATH only. -/
def rootOrigWriter (_flag env : Option String) (home : String) : String := env.getD home

/-- Writer, scan and closer now resolve the same directory (they share `rootFixed`);
the original writer disagreed with the closer whenever `--path` was given. -/
theorem orig_writer_ignores_path :
    rootOrigWriter (some "/b") (some "/a") "~" ≠ rootFixed (some "/b") (some "/a") "~" := by decide

/-- Keys (DOWNGRADED sub-claim): the writer keys `CLAUDE_SESSION_ID || ppid`; the
closer tries `[payload, CLAUDE_SESSION_ID, ppid]`. Same env, same ppid ⇒ the
closer's list contains the writer's key. -/
def writerKey (env : Option String) (ppid : String) : String := env.getD ppid
def closerKeys (payload env : Option String) (ppid : String) : List String :=
  [payload, env, some ppid].filterMap id

theorem closer_finds_writer (payload env : Option String) (ppid : String) :
    writerKey env ppid ∈ closerKeys payload env ppid := by
  cases payload <;> cases env <;> simp [writerKey, closerKeys]

end Checkpoint

/-! ## 3. Session identity and the inject lock (cli#7) -/
namespace Inject

/-- Marker key. `sid`/`pid` are disjoint by construction (the `sid-` prefix; a
ppid is all digits). `safe` is `safeSessionKey`, an arbitrary function. -/
inductive Key where
  | sid (s : String)
  | pid (p : Nat)
deriving DecidableEq

def keyOrig (_session : Option String) (ppid : Nat) : Key := .pid ppid
def keyFixed (safe : String → String) (session : Option String) (ppid : Nat) : Key :=
  match session with
  | some s => .sid (safe s)
  | none => .pid ppid

/-- Injection runs iff no marker exists for the key. After session `s1` in a
process, a later prompt carrying `s2` in the SAME process (/clear): -/
def injects (markers : List Key) (k : Key) : Bool := !(markers.contains k)

theorem orig_clear_skips_injection (s1 s2 : String) (p : Nat) :
    injects [keyOrig (some s1) p] (keyOrig (some s2) p) = false := by
  simp [injects, keyOrig]

theorem fixed_clear_injects (safe : String → String) (s1 s2 : String) (p : Nat)
    (h : safe s1 ≠ safe s2) :
    injects [keyFixed safe (some s1) p] (keyFixed safe (some s2) p) = true := by
  unfold injects keyFixed
  simp [Ne.symm h]

/-- ...and a second prompt of the same session is still NOT re-injected. -/
theorem fixed_same_session_no_reinject (safe : String → String) (s : String) (p q : Nat) :
    injects [keyFixed safe (some s) p] (keyFixed safe (some s) q) = false := by
  simp [injects, keyFixed]

/-! Lock. Each acquirer is a process; the ORIGINAL acquire is two steps (stat,
then write) and can interleave; the FIXED acquire is one atomic O_EXCL create. -/

/-- Original two-step protocol for two processes; schedule `[a-stat, b-stat,
a-write, b-write]`. Returns who proceeds. -/
def origTwo (present : Bool) : Bool × Bool :=
  let aFree := !present          -- A: stat
  let bFree := !present          -- B: stat (A has not written yet)
  (aFree, bFree)                 -- both then write and proceed iff they saw it free

theorem orig_both_proceed : origTwo false = (true, true) := rfl

/-- Fixed: a sequence of atomic `wx` creates, in any order. -/
def excl : Bool → List Nat → List Nat
  | _, [] => []
  | present, p :: ps => if present then excl true ps else p :: excl true ps

theorem excl_at_most_one (present : Bool) (ps : List Nat) : (excl present ps).length ≤ 1 := by
  induction ps generalizing present with
  | nil => simp [excl]
  | cons p ps ih =>
    have hz : ∀ qs : List Nat, (excl true qs).length = 0 := by
      intro qs; induction qs with
      | nil => rfl
      | cons _ _ ih' => simp [excl, ih']
    cases present <;> simp [excl, hz]

theorem excl_someone_wins (p : Nat) (ps : List Nat) : (excl false (p :: ps)).length = 1 := by
  have hz : ∀ qs : List Nat, (excl true qs).length = 0 := by
    intro qs; induction qs with
    | nil => rfl
    | cons _ _ ih' => simp [excl, ih']
  simp [excl, hz]

/-- Release. The body ends ok or throws. ORIGINAL: unlink on the ok path only. -/
def releasedOrig (bodyOk : Bool) : Bool := bodyOk
/-- FIXED: `try … finally unlink`. -/
def releasedFixed (_bodyOk : Bool) : Bool := true

theorem fixed_released_every_path (ok : Bool) : releasedFixed ok = true := rfl
theorem orig_leaks_on_throw : releasedOrig false = false := rfl

end Inject

/-! ## 4. Counters (cli#11)

The counter file is append-only: a list of entries in append order. -/
namespace Counter

/-- ORIGINAL: each entry is one byte; a caller's value is the file SIZE when it
stats, which may be after other appends. Schedule: A-append, B-append, A-stat,
B-stat. -/
def origSchedule : Nat × Nat :=
  let size := 0 + 1 + 1          -- two appends
  (size, size)                   -- both stats observe 2

theorem orig_duplicate : origSchedule = (2, 2) := rfl

/-- FIXED `ticketCounter`: value = 1 + position of the caller's own token. -/
def pos [DecidableEq α] : List α → α → Nat
  | [], _ => 0
  | x :: xs, y => if x = y then 0 else pos xs y + 1

theorem pos_append [DecidableEq α] (l m : List α) (p : α) (h : p ∈ l) :
    pos (l ++ m) p = pos l p := by
  induction l with
  | nil => simp at h
  | cons x xs ih =>
    simp only [List.cons_append, pos]
    by_cases hx : x = p
    · simp [hx]
    · have : p ∈ xs := by
        rcases List.mem_cons.mp h with h' | h'
        · exact absurd h'.symm hx
        · exact h'
      simp [hx, ih this]

/-- The value does not depend on WHEN the caller reads: later appends only extend
the file, and its own line is already in the prefix. -/
theorem ticket_stable [DecidableEq α] (l m : List α) (p : α) (h : p ∈ l) :
    pos (l ++ m) p + 1 = pos l p + 1 := by rw [pos_append l m p h]

theorem pos_lt [DecidableEq α] (l : List α) (p : α) (h : p ∈ l) : pos l p < l.length := by
  induction l with
  | nil => simp at h
  | cons x xs ih =>
    simp only [pos, List.length_cons]
    by_cases hx : x = p
    · simp [hx]
    · have : p ∈ xs := by
        rcases List.mem_cons.mp h with h' | h'
        · exact absurd h'.symm hx
        · exact h'
      simp [hx]; exact ih this

/-- Tokens are unique, so two distinct callers get distinct values. -/
theorem ticket_distinct [DecidableEq α] (l : List α) (p q : α) (hp : p ∈ l) (hq : q ∈ l)
    (hne : p ≠ q) : pos l p ≠ pos l q := by
  induction l with
  | nil => simp at hp
  | cons x xs ih =>
    simp only [pos]
    by_cases hxp : x = p
    · subst hxp
      rw [ite_eq_left rfl, ite_eq_right hne]; exact (Nat.succ_ne_zero _).symm
    · by_cases hxq : x = q
      · subst hxq
        rw [ite_eq_right hxp, ite_eq_left rfl]; exact Nat.succ_ne_zero _
      · rw [ite_eq_right hxp, ite_eq_right hxq]
        have hp' : p ∈ xs := by
          rcases List.mem_cons.mp hp with h' | h'
          · exact absurd h'.symm hxp
          · exact h'
        have hq' : q ∈ xs := by
          rcases List.mem_cons.mp hq with h' | h'
          · exact absurd h'.symm hxq
          · exact h'
        intro e; exact ih hp' hq' (by omega)

/-- Non-vacuity: sequential callers count 1, 2, 3. -/
theorem sequential_counts : ([0, 1, 2].map (fun p => pos [0, 1, 2] p + 1)) = [1, 2, 3] := by decide

end Counter

/-! ## 5. doctor verdict (cli#10) -/
namespace Doctor

inductive Harness where | claude | cursor | codex | agy
deriving DecidableEq

structure Cfg where
  harness : Harness
  hooks   : Bool

/-- ORIGINAL: "ready to use in Claude Code" whenever ANY config has hooks. -/
def claimsClaudeOrig (cs : List Cfg) : Bool := cs.any (·.hooks)
/-- FIXED `readyLine ∘ hookHarnesses`: the claim needs a Claude Code config with hooks. -/
def claimsClaudeFixed (cs : List Cfg) : Bool := cs.any (fun c => c.harness == .claude && c.hooks)

theorem fixed_claim_sound (cs : List Cfg) (h : claimsClaudeFixed cs = true) :
    ∃ c ∈ cs, c.harness = .claude ∧ c.hooks = true := by
  simp [claimsClaudeFixed] at h
  obtain ⟨c, hc, h1, h2⟩ := h
  exact ⟨c, hc, h1, h2⟩

theorem orig_false_green : claimsClaudeOrig [⟨.codex, true⟩] = true ∧
    ¬ ∃ c ∈ [(⟨.codex, true⟩ : Cfg)], c.harness = .claude := by
  refine ⟨rfl, ?_⟩; simp

theorem fixed_claims_when_true : claimsClaudeFixed [⟨.claude, true⟩] = true := rfl

end Doctor

/-! ## 6. Antigravity turn identity (cli#12)

A user-input line: its `step_index` (missing ⇒ -1), text hash and byte offset in
the append-only transcript. The cache records the last recalled turn. -/
namespace Agy

structure UserLine where
  step   : Int
  hash   : Nat
  offset : Nat

def newTurnOrig (u : UserLine) (cached : Option UserLine) : Bool :=
  match cached with
  | none => true
  | some c => decide (u.step > c.step) || u.hash != c.hash

def newTurnFixed (u : UserLine) (cached : Option UserLine) : Bool :=
  match cached with
  | none => true
  | some c => decide (u.step > c.step) || u.hash != c.hash || u.offset != c.offset

/-- Counterexample (replayed): "yes" … "yes", no step_index — the original replays
the first turn's memory for the second message. -/
theorem orig_replays_stale : newTurnOrig ⟨-1, 7, 100⟩ (some ⟨-1, 7, 0⟩) = false := by decide

/-- Property: a later user line (append-only ⇒ larger offset) is always a new turn. -/
theorem fixed_later_line_is_new (u c : UserLine) (h : c.offset < u.offset) :
    newTurnFixed u (some c) = true := by
  have : u.offset ≠ c.offset := Nat.ne_of_gt h
  simp [newTurnFixed, this]

/-- Non-vacuity: a mid-turn invocation (same line) replays, it does not re-recall. -/
theorem fixed_same_line_replays (u : UserLine) : newTurnFixed u (some u) = false := by
  simp [newTurnFixed]

/-- "First" turn. ORIGINAL: no cache and invocation 0 — permanently true when the
cache dir is unusable. FIXED: also requires the transcript to show this is the
only user message (when the transcript is readable). -/
def firstOrig (cacheNone inv0 : Bool) (_userTurns : Option Nat) : Bool := cacheNone && inv0
def firstFixed (cacheNone inv0 : Bool) (userTurns : Option Nat) : Bool :=
  cacheNone && inv0 && (match userTurns with | none => true | some n => n == 1)

theorem orig_every_turn_first : firstOrig true true (some 2) = true := rfl
theorem fixed_second_turn_not_first (n : Nat) (h : n ≥ 2) : firstFixed true true (some n) = false := by
  have : (n == 1) = false := by
    cases n with
    | zero => simp at h
    | succ k => cases k with
      | zero => simp at h
      | succ j => rfl
  simp [firstFixed, this]
theorem fixed_first_turn_first : firstFixed true true (some 1) = true := rfl

end Agy

/-! ## 7. `--` in free-text commands (follow-up) -/
namespace DashDash

/-- ORIGINAL `recall` loop: `--limit v` consumes a value; the first other token is
the query — including `--` itself. -/
def parseOrig : List String → Option String
  | [] => none
  | "--limit" :: _ :: rest => parseOrig rest
  | a :: _ => some a

/-- FIXED: `--` ends flag parsing; the next token is the query verbatim. -/
def parseFixed : List String → Option String
  | [] => none
  | "--" :: q :: _ => some q
  | "--" :: [] => none
  | "--limit" :: _ :: rest => parseFixed rest
  | a :: _ => some a

theorem orig_query_is_dashdash : parseOrig ["--", "-dash statement"] = some "--" := rfl

theorem fixed_after_dashdash_is_data (q : String) (rest : List String) :
    parseFixed ("--" :: q :: rest) = some q := by simp [parseFixed]

theorem fixed_even_a_flag_name :
    parseFixed ["--", "--limit"] = some "--limit" := by simp [parseFixed]

/-! ### Dispatch (audit 1228-c #3): `--` for every command, and `plur -- <cmd>`

index.ts passes `--` through to the command. Eight commands read it; every other
one took `--` as its first positional (`plur trust -- <dir>` trusted a directory
named `--`), and `plur -- learn x` failed with "Unknown command: --". FIXED
(`separatedArgs`): for a command that does not read `--`, the separator is dropped
and the values after it stay positional — refused if one begins with `-`, since
those commands read any `-…` token as their own flag; a leading `--` is refused
with a message naming the right order. -/

def aware (c : String) : Bool :=
  ["learn", "recall", "inject", "forget", "capture", "timeline", "similarity-search", "ingest"].contains c
    || c.startsWith "hook-"

def afterSep (rest : List String) : List String := (rest.dropWhile (· ≠ "--")).drop 1

def separated (c : String) (rest : List String) : Option (List String) :=
  if aware c || !rest.contains "--" then some rest
  else if (afterSep rest).any (·.startsWith "-") then none
  else some (rest.takeWhile (· ≠ "--") ++ afterSep rest)

inductive Disp | run (cmd : String) (args : List String) | refuse deriving DecidableEq

def dispatchOrig : List String → Disp
  | [] => .refuse
  | c :: rest => .run c rest

def dispatch : List String → Disp
  | [] => .refuse
  | c :: rest => if c = "--" then .refuse else
      match separated c rest with
      | some a => .run c a
      | none => .refuse

/-- trust.ts: the directory is `args[0]` (after `--list` is checked). -/
def trustDir (args : List String) : Option String := args.head?

theorem leading_sep_refused (rest : List String) : dispatch ("--" :: rest) = .refuse := by
  simp [dispatch]

/-- A command that reads `--` itself gets its argv unchanged, as before. -/
theorem aware_unchanged (c : String) (rest : List String) (hc : c ≠ "--") (ha : aware c = true) :
    dispatch (c :: rest) = .run c rest := by
  simp [dispatch, separated, hc, ha]

/-- No value after `--` reaches a non-reading command looking like a flag. -/
theorem no_flag_like_value_after_sep (c : String) (rest a : List String)
    (hs : separated c rest = some a) (hna : aware c = false) (hsep : rest.contains "--" = true) :
    ∀ v ∈ afterSep rest, v.startsWith "-" = false := by
  intro v hv
  unfold separated at hs
  simp only [hna, hsep, Bool.false_or, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at hs
  split at hs
  · cases hs
  · rename_i h
    simp only [List.any_eq_true, not_exists, not_and, Bool.not_eq_true] at h
    exact h v hv

/-- Replayed (original): `plur trust -- /repo` trusted `--`; fixed: `/repo`. -/
theorem orig_trust_dashdash :
    (match dispatchOrig ["trust", "--", "/repo"] with
     | .run _ a => trustDir a | .refuse => none) = some "--" := by decide
theorem fixed_trust_dashdash :
    (match dispatch ["trust", "--", "/repo"] with
     | .run _ a => trustDir a | .refuse => none) = some "/repo" := by
  simp [dispatch, separated, aware, afterSep, trustDir]
theorem fixed_dash_value_refused : dispatch ["trust", "--", "--list"] = .refuse := by
  simp [dispatch, separated, aware, afterSep]
/-- Non-vacuity: learn still sees its `--`, and a plain trust is untouched. -/
theorem fixed_learn_keeps_sep :
    dispatch ["learn", "--", "--dry-run"] = .run "learn" ["--", "--dry-run"] := by
  simp [dispatch, separated, aware]
theorem fixed_plain_trust : dispatch ["trust", "/repo"] = .run "trust" ["/repo"] := by
  simp [dispatch, separated, aware]

end DashDash


/-! ## Stale inject-lock takeover (coordinator gap closure, 2026-09-27)

`acquireInjectLock` (hook-inject.ts). A hook that judged the lock stale takes it over.
Old: `unlink(path)` — whatever is there now, even a fresh lock another hook just took.
New: `rename(path, aside)`, then compare the moved file's inode with the one judged
stale; a different inode is put back and the hook reports busy. The lock file is
modelled by its inode (`none` = no file); the hook remembers the inode it judged. -/
namespace InjectLock

/-- Old takeover: unlink whatever is at the path. -/
def oldTakeover (_seen : Nat) (_cur : Option Nat) : Option Nat := none

/-- New takeover: remove the file only if it is the one judged stale. -/
def newTakeover (seen : Nat) (cur : Option Nat) : Option Nat :=
  match cur with
  | some i => if i = seen then none else some i
  | none   => none

/-- A lock is live (someone holds it) when it is not the stale inode the hook judged. -/
def removesLive (take : Nat → Option Nat → Option Nat) (seen : Nat) (cur : Option Nat) : Prop :=
  ∃ i, cur = some i ∧ i ≠ seen ∧ take seen cur = none

/-- **The new takeover never removes a live lock.** -/
theorem new_never_removes_live (seen : Nat) (cur : Option Nat) : ¬ removesLive newTakeover seen cur := by
  rintro ⟨i, rfl, hne, h⟩
  simp [newTakeover, hne] at h

/-- The new takeover still removes the stale lock (the good case is reachable). -/
theorem new_removes_stale (seen : Nat) : newTakeover seen (some seen) = none := by
  simp [newTakeover]

/-- **Old counterexample:** hook B, having judged inode 1 stale, removes the fresh
lock (inode 2) that hook A took in between. -/
theorem old_removes_live : removesLive oldTakeover 1 (some 2) :=
  ⟨2, rfl, by decide, rfl⟩

end InjectLock

end PlurSpec.R2CLI
