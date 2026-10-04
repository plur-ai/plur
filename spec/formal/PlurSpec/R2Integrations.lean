/-!
# R2Integrations — round 2 of the adapter layer

MCP annotations and plur_admin dispatch, the hermes bridge, the migrate codemod,
claw setup/context-engine, opencode turn buffer, ui host normalisation, plus the
round-1 follow-ups. Each section models the code branch for branch, proves the
fixed behaviour and keeps the original-code counterexample. Core library only.

Checked against the merge of main into #1228 (2026-09-30): the model still holds.
Its only tools.ts change is plur_session_end's checkpoint key list, which now
also tries the `_`-replacing `safeSessionKey` form (#1278; R2CLI §2). No tool's
annotations, effects or plur_admin dispatch changed.

Checked against #1277 (2026-09-30): still holds. tools.ts changes plur_outbox's
output (retrying/needs_action) and makes its explicit flush `force`, and adds
outbox notices to plur_status and plur_session_start. No tool's annotations,
effects or plur_admin dispatch changed.
-/

namespace PlurSpec.R2Integrations

/-! ## 1. MCP annotations vs plur_admin dispatch (tools.ts, mcp-integrations#6)

A tool has effects (what its handler can do) and annotations (what the client is
told). plur_admin dispatches a target iff it is not `destructiveHint` (tools.ts
`buildAdminDispatchTool`). -/

structure Effects where
  writes       : Bool   -- local or remote state changes
  retires      : Bool   -- some call retires an engram (non-additive)
  repeatAdds   : Bool   -- a repeat call with the same args can add new effects
  copyRemains  : Bool   -- every retirement leaves a copy of the content (a move)

structure Ann where
  ro    : Bool
  destr : Bool
  idem  : Bool

structure Tool where
  name : String
  eff  : Effects
  ann  : Ann

/-- `buildAdminDispatchTool` handler: refuse iff `destructiveHint === true`. -/
def adminDispatches (t : Tool) : Bool := !t.ann.destr

/-- A REMOVAL: some call retires content and no copy of it remains. -/
def removes (t : Tool) : Bool := t.eff.retires && !t.eff.copyRemains

/-- MCP spec reading of the three hints. -/
def roSound (t : Tool) : Prop := t.eff.writes = true → t.ann.ro = false
def idemSound (t : Tool) : Prop := t.eff.repeatAdds = true → t.ann.idem = false
def destrSound (t : Tool) : Prop := t.eff.retires = true → t.ann.destr = true
/-- Owner decision I_tensions_resolve ("every removal needs an explicit, gated
act"): a tool that REMOVES is destructive. A move (retire + copy) need not be. -/
def removalGated (t : Tool) : Prop := removes t = true → t.ann.destr = true

instance (t : Tool) : Decidable (roSound t) := by unfold roSound; infer_instance
instance (t : Tool) : Decidable (idemSound t) := by unfold idemSound; infer_instance
instance (t : Tool) : Decidable (destrSound t) := by unfold destrSound; infer_instance
instance (t : Tool) : Decidable (removalGated t) := by unfold removalGated; infer_instance

/-- The guarantee the admin comment documents follows from `destrSound` alone. -/
theorem admin_never_retires (t : Tool) (h : destrSound t) :
    adminDispatches t = true → t.eff.retires = false := by
  unfold adminDispatches destrSound at *
  cases hr : t.eff.retires <;> cases hd : t.ann.destr <;> simp_all

/-- Decision I, per tool: a gated tool never removes through plur_admin. -/
theorem admin_never_removes (t : Tool) (h : removalGated t) :
    adminDispatches t = true → removes t = false := by
  unfold adminDispatches removalGated at *
  cases hr : removes t <;> cases hd : t.ann.destr <;> simp_all

-- The table: every tool whose handler can retire (plus two references).
def status      : Tool := ⟨"plur_status",       ⟨false, false, false, true⟩,  ⟨true,  false, true⟩⟩
def forget      : Tool := ⟨"plur_forget",       ⟨true,  true,  false, false⟩, ⟨false, true,  true⟩⟩
def packsUninst : Tool := ⟨"plur_packs_uninstall", ⟨true, true, false, false⟩, ⟨false, true,  false⟩⟩
def tensPurge   : Tool := ⟨"plur_tensions_purge", ⟨true, true, false, false⟩, ⟨false, true,  true⟩⟩
/-- Rescope: a local target rewrites in place; a remote target retires the
original only after pushing a copy linked by `superseded_by` — a move. -/
def rescope     : Tool := ⟨"plur_rescope",      ⟨true,  true,  false, true⟩,  ⟨false, false, true⟩⟩
/-- After decision I: resolve retires the loser (no copy) — destructive. -/
def tensions    : Tool := ⟨"plur_tensions",     ⟨true,  true,  true,  false⟩, ⟨false, true,  false⟩⟩
/-- After decision I: the third failed validation retires a non-top meta-engram. -/
def validateMeta: Tool := ⟨"plur_validate_meta",⟨true,  true,  true,  false⟩, ⟨false, true,  false⟩⟩
def sessStart   : Tool := ⟨"plur_session_start",⟨true,  false, true,  true⟩,  ⟨false, false, false⟩⟩

-- Pre-fix / pre-decision rows (counterexamples only).
def tensionsOrig : Tool := ⟨"plur_tensions",     ⟨true, true,  true, false⟩, ⟨false, false, true⟩⟩
def tensionsPreI : Tool := ⟨"plur_tensions",     ⟨true, true,  true, false⟩, ⟨false, false, false⟩⟩
def validateMetaPreI : Tool := ⟨"plur_validate_meta", ⟨true, true, true, false⟩, ⟨false, false, false⟩⟩
def sessStartOrig: Tool := ⟨"plur_session_start",⟨true, false, true, true⟩,  ⟨true,  false, false⟩⟩

def fixedTable : List Tool :=
  [status, forget, packsUninst, tensPurge, rescope, tensions, validateMeta, sessStart]

/-- `CURSOR_CORE_TOOL_NAMES` after decision I (tools.ts). -/
def coreNames : List String :=
  ["plur_session_start", "plur_session_end", "plur_learn", "plur_recall", "plur_feedback",
   "plur_forget", "plur_status", "plur_receipt", "plur_doctor", "plur_packs_uninstall",
   "plur_tensions_purge", "plur_tensions", "plur_validate_meta"]

/-- Fixed: read-only and idempotent hints are sound for every tool in the table. -/
theorem fixed_ro_idem_sound : ∀ t ∈ fixedTable, roSound t ∧ idemSound t := by
  decide

/-- Decision I: every removal in the table is gated (destructive)… -/
theorem fixed_removal_gated : ∀ t ∈ fixedTable, removalGated t := by decide

/-- …so plur_admin dispatches no tool that removes… -/
theorem fixed_admin_never_removes :
    ∀ t ∈ fixedTable, adminDispatches t = true → removes t = false :=
  fun t ht => admin_never_removes t (fixed_removal_gated t ht)

/-- …and every destructive tool stays reachable as a direct tool (lean profile). -/
theorem fixed_destructive_is_direct :
    ∀ t ∈ fixedTable, t.ann.destr = true → t.name ∈ coreNames := by decide

/-- Lean profile size: the core set plus plur_admin (14). -/
theorem lean_profile_size : coreNames.length + 1 = 14 := rfl

/-- Non-vacuity: a move (rescope) retires yet is still dispatched — decision I
gates removals, not moves; resolve and validate_meta are refused. -/
theorem rescope_move_dispatched :
    adminDispatches rescope = true ∧ rescope.eff.retires = true ∧ removes rescope = false :=
  ⟨rfl, rfl, rfl⟩
theorem admin_refuses_tensions : adminDispatches tensions = false := rfl
theorem admin_refuses_validate_meta : adminDispatches validateMeta = false := rfl

/-- Original code: session_start claimed read-only though it writes. -/
theorem orig_session_start_ro_lies : ¬ roSound sessStartOrig := by decide
/-- Original code: tensions claimed idempotent though a repeat scan can add records. -/
theorem orig_tensions_idem_lies : ¬ idemSound tensionsOrig := by decide

/-- Non-vacuity: admin still dispatches read tools. -/
theorem admin_dispatches_status : adminDispatches status = true := rfl
theorem admin_refuses_forget : adminDispatches forget = false := rfl

/-- PRE-DECISION COUNTEREXAMPLE (before decision I_tensions_resolve): resolve
retired the loser through plur_admin, because plur_tensions was not annotated
destructive. Replayed at the time in
packages/mcp/test/formal-r2-integrations-annotations.test.ts; that case now
pins the refusal. -/
theorem tensions_resolve_via_admin :
    adminDispatches tensionsPreI = true ∧ removes tensionsPreI = true := ⟨rfl, rfl⟩
/-- PRE-DECISION COUNTEREXAMPLE, found by the decision-I audit:
plur_validate_meta retired a meta-engram through plur_admin. Replayed in
packages/mcp/test/formal-r2-apply-mcp-removal-gated.test.ts (scratch replay:
admin result carried no error and the meta-engram's status became retired). -/
theorem validate_meta_retires_via_admin :
    adminDispatches validateMetaPreI = true ∧ removes validateMetaPreI = true := ⟨rfl, rfl⟩
theorem pre_decision_not_gated : ¬ removalGated tensionsPreI ∧ ¬ removalGated validateMetaPreI := by
  decide
/-- Rescope retires through plur_admin, by decision (a move: a copy remains). -/
theorem rescope_retires_via_admin :
    adminDispatches rescope = true ∧ rescope.eff.retires = true := ⟨rfl, rfl⟩

/-! ## 2. Hermes bridge dedup, forget, tool-path scope, recall argv
(packages/hermes/plur_hermes/bridge.py, memory_provider.py, __init__.py; mcp-integrations#5)

`learn(stmt, scope)`: a cache hit or a recall hit returns `deduplicated`
WITHOUT calling the CLI; otherwise the CLI (core) decides. -/

/-- A recall hit: statement (already normalised) and the scope core reports. -/
structure Hit where
  stmt  : String
  scope : String
  id    : Nat

inductive Res where
  | dedup (id : Nat)
  | core
deriving DecidableEq

/-- ORIGINAL: cache keyed by statement only; recall hit matched in any scope. -/
def learnOrig (cache : List (String × Nat)) (hits : List Hit) (s : String) (_sc : Option String) : Res :=
  match cache.lookup s with
  | some id => .dedup id
  | none => match hits.find? (fun h => h.stmt == s) with
            | some h => .dedup h.id
            | none => .core

abbrev Key := Option String × String

/-- FIXED: cache keyed by (requested scope, statement); a recall hit counts only
in the requested scope; an unscoped write never uses a recall hit. -/
def learnFixed (cache : List (Key × Nat)) (hits : List Hit) (s : String) (sc : Option String) : Res :=
  match cache.lookup (sc, s) with
  | some id => .dedup id
  | none => match sc with
            | none => .core
            | some x => match hits.find? (fun h => h.stmt == s && h.scope == x) with
                        | some h => .dedup h.id
                        | none => .core

/-- `forget` (fixed): clears the cache. Original: leaves it untouched. -/
def forgetFixed (_cache : List (Key × Nat)) : List (Key × Nat) := []

/-- Fixed: a short-circuit is justified by an entry for the SAME scope key, or
by a recall hit in the SAME explicit scope. -/
theorem fixed_dedup_same_scope (c : List (Key × Nat)) (hits : List Hit) (s : String)
    (sc : Option String) (id : Nat) (h : learnFixed c hits s sc = .dedup id) :
    c.lookup (sc, s) = some id ∨
      ∃ x hh, sc = some x ∧ hits.find? (fun h => h.stmt == s && h.scope == x) = some hh ∧ hh.id = id := by
  unfold learnFixed at h
  split at h
  · simp_all
  · rename_i hn
    split at h
    · cases h
    · rename_i x
      split at h
      · rename_i hh hf
        cases h
        exact Or.inr ⟨x, hh, rfl, hf, rfl⟩
      · cases h

/-- Fixed: after a forget, the only short-circuit left is a live recall hit. -/
theorem fixed_forget_no_stale (c : List (Key × Nat)) (hits : List Hit) (s : String) (sc : Option String) :
    learnFixed (forgetFixed c) hits s sc =
      (match sc with
       | none => .core
       | some x => match hits.find? (fun h => h.stmt == s && h.scope == x) with
                   | some h => .dedup h.id
                   | none => .core) := by
  simp [learnFixed, forgetFixed]

/-- Fixed: an unscoped write with an empty cache always reaches core (core's
routing picks the scope; the bridge cannot know it). -/
theorem fixed_unscoped_reaches_core (hits : List Hit) (s : String) :
    learnFixed [] hits s none = .core := by simp [learnFixed, List.lookup]

-- Scenario: a personal engram exists (cached and recallable); a team write follows.
def personalHit : Hit := ⟨"deploys need two approvals", "user:alice", 1⟩

/-- Counterexample (original): the team write is swallowed as a duplicate. -/
theorem orig_team_write_swallowed :
    learnOrig [("deploys need two approvals", 1)] [personalHit]
      "deploys need two approvals" (some "group:acme/eng") = .dedup 1 := by decide

/-- Fixed: the same team write reaches core, from cache or recall. -/
theorem fixed_team_write_reaches_core :
    learnFixed [((some "user:alice", "deploys need two approvals"), 1)] [personalHit]
      "deploys need two approvals" (some "group:acme/eng") = .core := by decide

/-- Non-vacuity: a repeat in the same scope is still deduplicated (cache and recall). -/
theorem fixed_same_scope_dedup :
    learnFixed [((some "user:alice", "deploys need two approvals"), 1)] []
      "deploys need two approvals" (some "user:alice") = .dedup 1 ∧
    learnFixed [] [personalHit] "deploys need two approvals" (some "user:alice") = .dedup 1 := by
  decide

/-- Counterexample (original): after `forget`, the cached id is still served. -/
theorem orig_forget_stale :
    learnOrig [("deploys need two approvals", 1)] [] "deploys need two approvals" none = .dedup 1 := by
  decide

/-- Tool paths. ORIGINAL: `args.get("scope", "global")`; FIXED: `args.get("scope")`. -/
def toolScopeOrig (arg : Option String) : Option String := arg <|> some "global"
def toolScopeFixed (arg : Option String) : Option String := arg

/-- Fixed: an omitted scope stays omitted, so core's unscoped routing applies. -/
theorem fixed_tool_scope_passthrough (arg : Option String) : toolScopeFixed arg = arg := rfl
theorem orig_tool_scope_defeats_autoroute : toolScopeOrig none = some "global" := rfl

/-! Recall argv. The CLI's `plur recall` parse after R2-CLI (honours `--`):
`--limit` takes a value, `--fast` is a flag, any other `-…` token is refused. -/

def recallParse : List String → Option String
  | [] => none
  | "--" :: rest => rest.head?
  | "--limit" :: _ :: rest => recallParse rest
  | "--fast" :: rest => recallParse rest
  | a :: _ => if a.startsWith "-" then none else some a

/-- bridge.recall ORIGINAL argv: the query first, always. -/
def recallArgsOrig (q lim : String) (fast : Bool) : List String :=
  q :: "--limit" :: lim :: (if fast then ["--fast"] else [])

/-- bridge.recall FIXED argv: a query that begins with "-" goes after "--". -/
def recallArgs (q lim : String) (fast : Bool) : List String :=
  if q.startsWith "-" then "--limit" :: lim :: ((if fast then ["--fast"] else []) ++ ["--", q])
  else q :: "--limit" :: lim :: (if fast then ["--fast"] else [])

theorem recallParse_head (q : String) (rest : List String) (h : q.startsWith "-" = false) :
    recallParse (q :: rest) = some q := by
  have h1 : q ≠ "--" := by intro e; subst e; simp at h
  have h2 : q ≠ "--limit" := by intro e; subst e; simp at h
  have h3 : q ≠ "--fast" := by intro e; subst e; simp at h
  unfold recallParse
  split <;> simp_all

/-- Fixed: every query reaches the CLI verbatim as the query. -/
theorem recall_query_verbatim (q lim : String) (fast : Bool) :
    recallParse (recallArgs q lim fast) = some q := by
  unfold recallArgs
  cases hq : q.startsWith "-"
  · simp only [Bool.false_eq_true, ↓reduceIte]; exact recallParse_head q _ hq
  · cases fast <;> simp [recallParse]

/-- Counterexample (original): a query that begins with "-" is refused as a flag. -/
theorem orig_dash_query_refused :
    recallParse (recallArgsOrig "-x marks the spot" "3" false) = none := by
  simp [recallArgsOrig, recallParse]

/-! ### inject / capture text, and where `--path` goes (audit 1228-c)

The same rule for the other free text the bridges send. `bridge.inject(task)` /
`Plur.inject(task)` passed a user message as the first positional, so
"--path=/x …" reached the CLI's flag parser. FIXED: flag-like text goes after `--`
(`plur inject` honours it); `capture` sends it on stdin, which `plur capture` reads
when argv has no summary. Every other text keeps the old argv (so the npx-pinned
0.20.1 CLI behaves as before). -/

def injectParse : List String → Option String
  | [] => none
  | "--" :: rest => rest.head?
  | "--budget" :: _ :: rest => injectParse rest
  | "--fast" :: rest => injectParse rest
  | a :: _ => if a.startsWith "-" then none else some a

def injectArgsOrig (t b : String) (fast : Bool) : List String :=
  t :: "--budget" :: b :: (if fast then ["--fast"] else [])

def injectArgs (t b : String) (fast : Bool) : List String :=
  if t.startsWith "-" then "--budget" :: b :: ((if fast then ["--fast"] else []) ++ ["--", t])
  else t :: "--budget" :: b :: (if fast then ["--fast"] else [])

theorem injectParse_head (t : String) (rest : List String) (h : t.startsWith "-" = false) :
    injectParse (t :: rest) = some t := by
  have h1 : t ≠ "--" := by intro e; subst e; simp at h
  have h2 : t ≠ "--budget" := by intro e; subst e; simp at h
  have h3 : t ≠ "--fast" := by intro e; subst e; simp at h
  unfold injectParse
  split <;> simp_all

theorem inject_task_verbatim (t b : String) (fast : Bool) :
    injectParse (injectArgs t b fast) = some t := by
  unfold injectArgs
  cases ht : t.startsWith "-"
  · simp only [Bool.false_eq_true, ↓reduceIte]; exact injectParse_head t _ ht
  · cases fast <;> simp [injectParse]

theorem orig_dash_task_lost :
    injectParse (injectArgsOrig "--path=/x deploy" "2000" true) = none := by
  simp [injectArgsOrig, injectParse]

/-- capture: the summary is argv's first non-flag token, else stdin. -/
def captureSummary (argv : List String) (stdin : Option String) : Option String :=
  match injectParse argv with
  | some s => some s
  | none => stdin

def captureCall (t : String) : List String × Option String :=
  if t.startsWith "-" then ([], some t) else ([t], none)

theorem capture_summary_verbatim (t : String) :
    captureSummary (captureCall t).1 (captureCall t).2 = some t := by
  unfold captureCall
  cases ht : t.startsWith "-"
  · simp [captureSummary, injectParse_head t [] ht]
  · simp [captureSummary, injectParse]

/-- `bridge.call`: ORIGINAL inserted `--path P` before the FIRST "--" in the argv —
possibly a flag's VALUE. FIXED: right after `--json`, before every argument, so the
caller's argv survives intact as a suffix. -/
def insertAtSep (xs ins : List String) : List String :=
  xs.takeWhile (· ≠ "--") ++ ins ++ xs.dropWhile (· ≠ "--")

def callCmdOrig (c : String) (path : Option String) (args : List String) : List String :=
  match path with
  | none => c :: "--json" :: args
  | some p => insertAtSep (c :: "--json" :: args) ["--path", p]

def callCmd (c : String) (path : Option String) (args : List String) : List String :=
  c :: "--json" :: ((match path with | none => [] | some p => ["--path", p]) ++ args)

theorem call_args_intact (c : String) (path : Option String) (args : List String) :
    ∃ pre, callCmd c path args = pre ++ args := by
  cases path with
  | none => exact ⟨[c, "--json"], by simp [callCmd]⟩
  | some p => exact ⟨[c, "--json", "--path", p], by simp [callCmd]⟩

theorem orig_splits_flag_value :
    callCmdOrig "forget" (some "/s") ["--search", "--"] =
      ["forget", "--json", "--search", "--path", "/s", "--"] := by decide

/-! ## 3. MCP follow-ups: recall session rule, zero-session scope set, refusal wording, outbox count
(packages/mcp/src/tools.ts) -/

/-- The MCP-visible session state: open sessions (in start order), keyed default
scopes, and the process slot (the LAST started session's default). -/
structure Sess where
  open_ : List String
  keyed : List (String × String)
  slot  : Option String

/-- Core's `SessionScopeRegistry.get` with the E7 sentinel: `none` = NO_SESSION. -/
def regGet (r : Sess) : Option (Option String) → Option String
  | some (some s) => (r.keyed.lookup s) <|> r.slot
  | some none     => none          -- NO_SESSION: no default at all
  | none          => r.slot        -- `undefined`: the process slot

/-- `_resolveInjectionSession` (explicit, else the lone open session). -/
def resolveInj (r : Sess) (explicit : Option String) : Option String :=
  explicit <|> (match r.open_ with | [s] => some s | _ => none)

/-- `_resolveWriteSession`: same, else NO_SESSION. Encoded as the argument to `regGet`. -/
def resolveWrite (r : Sess) (explicit : Option String) : Option (Option String) :=
  some (resolveInj r explicit)

/-- ORIGINAL recall: `_resolveInjectionSession` → `undefined` when ambiguous. -/
def recallArgOrig (r : Sess) (explicit : Option String) : Option (Option String) :=
  match resolveInj r explicit with
  | some s => some (some s)
  | none   => none

/-- FIXED recall: the write rule. -/
def recallArg (r : Sess) (explicit : Option String) : Option (Option String) := resolveWrite r explicit

/-- Fixed: recall and writes resolve the same session (so the same dial context). -/
theorem recall_same_rule_as_write (r : Sess) (e : Option String) :
    regGet r (recallArg r e) = regGet r (resolveWrite r e) := rfl

/-- Fixed: with no id and not exactly one session open, recall gets no session
default — never the slot the last-started session owns. -/
theorem recall_ambiguous_no_default (r : Sess) (h : ∀ s, r.open_ ≠ [s]) :
    regGet r (recallArg r none) = none := by
  unfold recallArg resolveWrite resolveInj regGet
  cases hr : r.open_ with
  | nil => rfl
  | cons a t =>
    cases t with
    | nil => exact absurd hr (h a)
    | cons b u => rfl

/-- Two sessions: A (project:a) then B (group:acme/eng); the slot holds B's scope. -/
def twoOpen : Sess := ⟨["A", "B"], [("A", "project:a"), ("B", "group:acme/eng")], some "group:acme/eng"⟩

/-- Counterexample (original): an id-less recall dials with B's team scope. -/
theorem orig_recall_borrows_last_started :
    regGet twoOpen (recallArgOrig twoOpen none) = some "group:acme/eng" := rfl

/-- Non-vacuity: one open session, or an explicit id, still supplies its default. -/
theorem recall_lone_session_default :
    regGet ⟨["A"], [("A", "project:a")], some "project:a"⟩
      (recallArg ⟨["A"], [("A", "project:a")], some "project:a"⟩ none) = some "project:a" ∧
    regGet twoOpen (recallArg twoOpen (some "A")) = some "project:a" := ⟨rfl, rfl⟩

/-- plur_session_scope op:"set" with no explicit id. `none` = refused. FIXED
refuses when no session is open (and when several are, as before). -/
def setTarget (r : Sess) (explicit : Option String) : Option (Option String) :=
  match explicit with
  | some s => some (some s)
  | none => match r.open_ with
            | [s] => some (some s)
            | _   => none

/-- ORIGINAL: zero open sessions → the process slot (`some none`), accepted. -/
def setTargetOrig (r : Sess) (explicit : Option String) : Option (Option String) :=
  match explicit with
  | some s => some (some s)
  | none => match r.open_ with
            | [s] => some (some s)
            | []  => some none
            | _   => none

/-- Does some id-less call (learn, inject, recall — all `resolveWrite`) read the
registration `t`? The process slot (`none`) is read by none of them. -/
def readByIdless (r : Sess) : Option String → Prop
  | some s => resolveWrite r none = some (some s)
  | none   => False

/-- Fixed: a set with no explicit id is accepted only when an id-less call reads
what it sets. -/
theorem set_accepted_is_observable (r : Sess) (t : Option String)
    (h : setTarget r none = some t) : readByIdless r t := by
  simp only [setTarget] at h
  cases ho : r.open_ with
  | nil => simp [ho] at h
  | cons a t' =>
    cases t' with
    | nil =>
      simp [ho] at h
      subst h
      simp [readByIdless, resolveWrite, resolveInj, ho]
    | cons b u => simp [ho] at h

/-- Counterexample (original): with no session open the set is accepted into a
slot no id-less call reads. -/
theorem orig_zero_session_set_unobservable :
    setTargetOrig ⟨[], [], none⟩ none = some none ∧ ¬ readByIdless ⟨[], [], none⟩ none :=
  ⟨rfl, fun h => h⟩

/-- Refusal wording: core refuses a shared scope OR a remote personal scope not
verified as the user's own; the MCP text now names the kind. -/
inductive RefusedKind where
  | shared
  | remotePersonal
deriving DecidableEq

def describeKind (isShared : String → Bool) (scope : String) : RefusedKind :=
  if isShared scope then .shared else .remotePersonal

/-- ORIGINAL wording: every refusal was described as "a SHARED scope". -/
def describeKindOrig (_isShared : String → Bool) (_scope : String) : RefusedKind := .shared

theorem refusal_kind_truthful (isShared : String → Bool) (s : String) :
    describeKind isShared s = .shared ↔ isShared s = true := by
  unfold describeKind; cases isShared s <;> simp

theorem orig_personal_called_shared :
    describeKindOrig (fun s => s == "group:acme/eng") "user:bob" = .shared ∧
    describeKind (fun s => s == "group:acme/eng") "user:bob" = .remotePersonal := ⟨rfl, by decide⟩

/-- plur_outbox after a flush: FIXED counts the listed entries; ORIGINAL used a
separate counter that sees only push entries. -/
structure OEntry where
  retire : Bool

def pendingFixed (listed : List OEntry) : Nat := listed.length
def pendingOrig (listed : List OEntry) : Nat := (listed.filter (fun e => !e.retire)).length

theorem pending_counts_every_listed (l : List OEntry) : pendingFixed l = l.length := rfl
theorem orig_pending_misses_retire : pendingOrig [⟨true⟩] = 0 ∧ pendingFixed [⟨true⟩] = 1 := ⟨rfl, rfl⟩

/-! ## 4. migrate codemod (packages/migrate/src/scan.ts `applyFixes`, index.ts `run`; mcp#8)

A line is edited right-to-left. An insertion `(p, n)` puts `n` characters
before ORIGINAL character `p`. After some insertions, original character `k`
sits at index `idx ins k = k + Σ{n | (p,n) ∈ ins, p ≤ k}`. A later edit that
must close a wrap just before original character `e` inserts at a CURRENT
index; it is correct iff that index is in the gap after original character
`e-1` and at or before original character `e`. -/

def shiftLt (ins : List (Nat × Nat)) (k : Nat) : Nat :=
  ((ins.filter (fun x => decide (x.1 < k))).map (·.2)).sum
def shiftLe (ins : List (Nat × Nat)) (k : Nat) : Nat :=
  ((ins.filter (fun x => decide (x.1 ≤ k))).map (·.2)).sum

def idx (ins : List (Nat × Nat)) (k : Nat) : Nat := k + shiftLe ins k

/-- FIXED `map`: original offset → current offset (insertions strictly before). -/
def mapPos (ins : List (Nat × Nat)) (e : Nat) : Nat := e + shiftLt ins e
/-- ORIGINAL: the stale original offset. -/
def mapPosOrig (_ins : List (Nat × Nat)) (e : Nat) : Nat := e

theorem shiftLe_pred (ins : List (Nat × Nat)) (e : Nat) (he : 1 ≤ e) :
    shiftLe ins (e - 1) = shiftLt ins e := by
  induction ins with
  | nil => rfl
  | cons x t ih =>
    simp only [shiftLe, shiftLt, List.filter_cons] at *
    by_cases h : x.1 < e
    · have h' : x.1 ≤ e - 1 := by omega
      simp [h, h', ih]
    · have h' : ¬ x.1 ≤ e - 1 := by omega
      simp [h, h', ih]

theorem shiftLt_le (ins : List (Nat × Nat)) (e : Nat) : shiftLt ins e ≤ shiftLe ins e := by
  induction ins with
  | nil => exact Nat.le_refl _
  | cons x t ih =>
    simp only [shiftLe, shiftLt, List.filter_cons] at *
    by_cases h : x.1 < e
    · have h' : x.1 ≤ e := by omega
      simp [h, h']; omega
    · by_cases h' : x.1 ≤ e
      · simp [h, h']; omega
      · simp [h, h']; omega

/-- Fixed: the closing `)` lands after original character `e-1` and at or before
original character `e`, whatever was inserted before — nested or not. -/
theorem wrap_end_in_gap (ins : List (Nat × Nat)) (e : Nat) (he : 1 ≤ e) :
    idx ins (e - 1) < mapPos ins e ∧ mapPos ins e ≤ idx ins e := by
  unfold idx mapPos
  have h1 := shiftLe_pred ins e he
  have h2 := shiftLt_le ins e
  constructor <;> omega

/-- The replayed line: `plur.list(plur.getById(id)).length`; the inner `await `
(6 chars) went in at original offset 22 (column 23), the outer wrap ends at
offset 39 (`wrapTo` 40). The original put `)` six characters early. -/
theorem orig_nested_wrap_early :
    ¬ (idx [(22, 6)] 38 < mapPosOrig [(22, 6)] 39) := by decide
theorem fixed_nested_wrap_in_gap :
    idx [(22, 6)] 38 < mapPos [(22, 6)] 39 ∧ mapPos [(22, 6)] 39 ≤ idx [(22, 6)] 39 := by decide

/-- Non-vacuity: with no inner edit, the fixed and original maps agree. -/
theorem no_inner_edit_same (e : Nat) : mapPos [] e = mapPosOrig [] e := rfl

/-- `run` exit code: FIXED is non-zero whenever un-awaited calls remain. -/
def exitFixed (write : Bool) (fixableLeft manual : Nat) : Nat :=
  if manual > 0 || (!write && fixableLeft > 0) then 2 else 0
def exitOrig (_write : Bool) (_fixableLeft manual : Nat) : Nat :=
  if manual > 0 then 2 else 0

theorem exit_zero_means_clean (w : Bool) (f m : Nat) (h : exitFixed w f m = 0) :
    m = 0 ∧ (w = true ∨ f = 0) := by
  unfold exitFixed at h
  cases w <;> by_cases hm : m > 0 <;> by_cases hf : f > 0 <;> simp_all <;> omega

theorem orig_report_only_exit_zero : exitOrig false 3 0 = 0 := rfl
theorem write_all_fixed_exit_zero : exitFixed true 3 0 = 0 := rfl

/-- Summary: FIXED reports the fixes applied; ORIGINAL reported every fixable site. -/
def summaryFixed (_fixable applied : Nat) : Nat := applied
def summaryOrig (fixable _applied : Nat) : Nat := fixable
theorem summary_is_applied (f a : Nat) : summaryFixed f a = a := rfl
theorem orig_summary_overcounts : summaryOrig 2 1 ≠ 1 := by decide

/-! ## 5. claw setup/repair and context engine (packages/claw/src/setup.ts,
context-engine.ts; mcp#11) -/

/-- `plugins.slots.memory` after the run (`none` = unset). -/
def setupSlotOrig (_cur : Option String) : Option String := some "plur-claw"
def setupSlot (cur : Option String) : Option String :=
  match cur with
  | none => some "plur-claw"
  | some h => some h
def repairSlot (cur : Option String) : Option String :=
  match cur with
  | none => some "plur-claw"
  | some h => some h

theorem setup_agrees_with_repair (cur : Option String) : setupSlot cur = repairSlot cur := by
  cases cur <;> rfl
theorem setup_never_takes_foreign (h : String) : setupSlot (some h) = some h := rfl
theorem setup_fills_empty_slot : setupSlot none = some "plur-claw" := rfl
theorem orig_setup_takes_foreign : setupSlotOrig (some "other-memory") ≠ some "other-memory" := by decide

/-- A JSON value, abstractly. -/
inductive JVal where
  | obj
  | other (tag : Nat)   -- string / array / number / bool
deriving DecidableEq

/-- What `plugins` holds after the run: FIXED writes only when it is absent or
an object (otherwise the file is untouched); ORIGINAL replaced it by `{}`. -/
def pluginsAfter (v : Option JVal) : Option JVal :=
  match v with
  | some (.other t) => some (.other t)   -- refused: file left untouched
  | _ => some .obj
def pluginsAfterOrig (_v : Option JVal) : Option JVal := some .obj

theorem user_value_never_discarded (t : Nat) : pluginsAfter (some (.other t)) = some (.other t) := rfl
theorem orig_discards_user_value : pluginsAfterOrig (some (.other 7)) ≠ some (.other 7) := by decide

/-- `_learnIfNew`: `seen` after one occurrence whose write `ok`s or fails, and
whether the write was attempted. -/
def learnStep (seen : List String) (k : String) (ok : Bool) : List String × Bool :=
  if k ∈ seen then (seen, false)
  else (if ok then k :: seen else seen, true)
def learnStepOrig (seen : List String) (k : String) (_ok : Bool) : List String × Bool :=
  if k ∈ seen then (seen, false) else (k :: seen, true)

/-- Fixed: after a failed write the next occurrence writes again. -/
theorem failed_learn_retried (seen : List String) (k : String) (h : k ∉ seen) :
    (learnStep (learnStep seen k false).1 k true).2 = true := by
  simp [learnStep, h]
/-- Non-vacuity: a successful write is not repeated. -/
theorem ok_learn_not_repeated (seen : List String) (k : String) (h : k ∉ seen) :
    (learnStep (learnStep seen k true).1 k true).2 = false := by
  simp [learnStep, h]
theorem orig_failed_learn_never_retried :
    (learnStepOrig (learnStepOrig [] "k" false).1 "k" true).2 = false := by decide

/-- LRU `put` over the key order (most recent first), capped. -/
def lruPut (cap : Nat) (l : List String) (k : String) : List String := (k :: l.erase k).take cap

theorem lru_bounded (cap : Nat) (l : List String) (k : String) : (lruPut cap l k).length ≤ cap := by
  unfold lruPut; exact List.length_take_le _ _
theorem lru_keeps_latest (cap : Nat) (l : List String) (k : String) (h : 1 ≤ cap) :
    (lruPut cap l k).head? = some k := by
  unfold lruPut
  cases cap with
  | zero => omega
  | succ n => simp
/-- ORIGINAL: an unbounded map grows by one per new session. -/
def mapPutOrig (l : List String) (k : String) : List String := if k ∈ l then l else k :: l
theorem orig_unbounded (l : List String) (k : String) (h : k ∉ l) :
    (mapPutOrig l k).length = l.length + 1 := by simp [mapPutOrig, h]

/-! ## 6. opencode render path and turn buffer (packages/opencode/src/index.ts,
turn.ts; mcp#10) -/

/-- Copies of this turn's block in one model request: the fallback part (when
latched) plus the system.transform push. -/
def copiesFixed (fallbackFired : Bool) : Nat :=
  (if fallbackFired then 1 else 0) + (if fallbackFired then 0 else 1)
def copiesOrig (fallbackFired : Bool) : Nat :=
  (if fallbackFired then 1 else 0) + 1

theorem exactly_one_copy (f : Bool) : copiesFixed f = 1 := by cases f <;> rfl
theorem orig_double_injection : copiesOrig true = 2 := rfl

/-- Turn buffer: `taken` part ids; an update to a taken part is ignored. The
learner runs on a take when the buffer is fresh. -/
structure TB where
  fresh : Bool
  taken : List String

def appendFixed (b : TB) (part : String) : TB :=
  if part ∈ b.taken then b else { b with fresh := true }
def appendOrig (b : TB) (_part : String) : TB := { b with fresh := true }
/-- take: returns (learned?, new state), recording `part` as taken. -/
def take (b : TB) (part : String) : Bool × TB :=
  if b.fresh then (true, { fresh := false, taken := part :: b.taken }) else (false, b)

/-- Fixed: part → idle → the same part's late snapshot → idle learns ONCE. -/
theorem late_snapshot_learned_once (b : TB) (p : String) (h : b.fresh = false) :
    let b1 := appendFixed b p
    let (l1, b2) := take b1 p
    let (l2, _) := take (appendFixed b2 p) p
    (if p ∈ b.taken then l1 = false else l1 = true) ∧ l2 = false := by
  simp only [appendFixed, take]
  by_cases hp : p ∈ b.taken <;> simp [hp, h]

theorem orig_late_snapshot_learned_twice :
    let b1 := appendOrig ⟨false, []⟩ "prt"
    let (l1, b2) := take b1 "prt"
    let (l2, _) := take (appendOrig b2 "prt") "prt"
    l1 = true ∧ l2 = true := by decide

/-- Non-vacuity: a NEW part in the next turn is learned. -/
theorem new_part_learned : (take (appendFixed ⟨false, ["prt_1"]⟩ "prt_2") "prt_2").1 = true := by decide

/-- chat.message waits at most `bound` for recall (FIXED); ORIGINAL waits the
recall's own duration, unbounded. -/
def waitFixed (bound recall : Nat) : Nat := min bound recall
def waitOrig (_bound recall : Nat) : Nat := recall
theorem wait_bounded (b r : Nat) : waitFixed b r ≤ b := Nat.min_le_left _ _
theorem orig_wait_unbounded (b : Nat) : waitOrig b (b + 1) > b := by simp [waitOrig]

/-! ## 7. ui Host normalisation (packages/ui/src/server.ts; mcp#12)

A Host value abstracted as `n` bracket layers around an IPv6-shaped core (the
case where the two versions differ). -/

/-- ORIGINAL: unwraps one layer whenever there is one (inner has a colon). -/
def normOrig (n : Nat) : Nat := n - 1
/-- FIXED: unwraps only a single layer whose inner holds no bracket. -/
def normFixed (n : Nat) : Nat := if n = 1 then 0 else n

theorem norm_idempotent (n : Nat) : normFixed (normFixed n) = normFixed n := by
  unfold normFixed; by_cases h : n = 1 <;> simp [h]
theorem orig_not_idempotent : normOrig (normOrig 2) ≠ normOrig 2 := by decide
theorem norm_unwraps_single : normFixed 1 = 0 := rfl

/-- `hostIsAllowed`: `present` = the header carries a non-empty value; `name` =
its normalised form. -/
def builtin (name : String) : Bool := name == "127.0.0.1" || name == "localhost" || name == "::1"
def allowedFixed (present : Bool) (name : String) : Bool := !present || builtin name
def allowedOrig (_present : Bool) (name : String) : Bool := builtin name || name == ""

/-- Fixed: a present Host is allowed only for a built-in (or allowlisted) name. -/
theorem present_empty_refused : allowedFixed true "" = false := by decide
theorem absent_allowed (n : String) : allowedFixed false n = true := rfl
theorem orig_colon_port_allowed : allowedOrig true "" = true := by decide

end PlurSpec.R2Integrations
