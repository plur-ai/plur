/-!
# Adapters — MCP tools, CLI installers, bridges

Models of the adapter layer (packages/mcp/src/tools.ts, packages/cli/src/…,
packages/dsh, hermes/python bridges). Each section models one candidate branch
for branch with the code, states the property, proves the fixed code has it and
exhibits a counterexample for the original code. Core library only.
-/

namespace PlurSpec.Adapters

/-! ## 1. MCP learn entry points (tools.ts plur_learn / plur_learn_batch / plur_session_end)

`SessionScopeRegistry` (core/src/session-scopes.ts): keyed registrations plus a
process-default slot that the LAST `plur_session_start` overwrites. -/

structure Registry where
  keyed : List (String × Option String)   -- session ↦ registered default scope
  dflt  : Option String                   -- process slot
  open_ : List String                     -- `_sessionTelemetry` keys (open sessions)

/-- `SessionScopeRegistry.get(session)`. -/
def Registry.get (r : Registry) : Option String → Option String
  | some s => match r.keyed.lookup s with
              | some v => v
              | none   => r.dflt
  | none   => r.dflt

/-- `_resolveInjectionSession(args)`: explicit id, else the lone open session. -/
def resolveSession (r : Registry) (explicit : Option String) : Option String :=
  match explicit with
  | some s => some s
  | none => match r.open_ with
            | [s] => some s
            | _   => none

/-- The logical input every learn entry point receives. -/
structure LearnInput where
  scope     : Option String
  domain    : Option String
  pinned    : Bool
  sessionId : Option String

/-- The part of `LearnContext` that decides where and whether a write lands. -/
structure Ctx where
  scope   : Option String
  domain  : Option String
  pinned  : Bool
  session : Option String
deriving DecidableEq

/-- plur_learn (tools.ts ~1133-1170): the reference derivation.
`proj` is `.plur.yaml`'s `domain:`. -/
def learnCtx (r : Registry) (proj : Option String) (a : LearnInput) : Ctx :=
  { scope := a.scope, domain := a.domain <|> proj, pinned := a.pinned,
    session := resolveSession r a.sessionId }

/-- ORIGINAL plur_learn_batch item context: no session, no domain default. -/
def batchCtxOrig (_r : Registry) (_proj : Option String) (a : LearnInput) : Ctx :=
  { scope := a.scope, domain := a.domain, pinned := a.pinned, session := none }

/-- ORIGINAL plur_session_end: `plur.learn(statement, {type, …})` — no scope,
no domain, no session. -/
def endCtxOrig (_r : Registry) (_proj : Option String) (_a : LearnInput) : Ctx :=
  { scope := none, domain := none, pinned := false, session := none }

/-- FIXED plur_learn_batch: `session: _resolveInjectionSession(args)`,
`domain: e.domain ?? projectDomain`. -/
def batchCtx (r : Registry) (proj : Option String) (a : LearnInput) : Ctx :=
  { scope := a.scope, domain := a.domain <|> proj, pinned := a.pinned,
    session := resolveSession r a.sessionId }

/-- FIXED plur_session_end: `learnRouted(s, {session: endSession, domain: projectDomain})`.
A suggestion carries no scope/domain/pinned of its own. -/
def endCtx (r : Registry) (proj : Option String) (a : LearnInput) : Ctx :=
  { scope := none, domain := proj, pinned := false,
    session := resolveSession r a.sessionId }

/-- Effective scope chosen by core `_guardSensitiveScope` before routing:
explicit scope, else the session's registry entry (`none` = auto-route/default). -/
def effScope (r : Registry) (c : Ctx) : Option String :=
  c.scope <|> r.get c.session

/-- A suggestion as plur_learn would see it. -/
def asSuggestion (a : LearnInput) : LearnInput :=
  { scope := none, domain := none, pinned := false, sessionId := a.sessionId }

theorem batch_agrees_with_learn (r : Registry) (proj : Option String) (a : LearnInput) :
    batchCtx r proj a = learnCtx r proj a := rfl

theorem end_agrees_with_learn (r : Registry) (proj : Option String) (a : LearnInput) :
    endCtx r proj a = learnCtx r proj (asSuggestion a) := rfl

/-- The replayed counterexample: session A (project:a) then session B
(project:b, owns the process slot); session_end/batch for A with A's id. -/
def twoSessions : Registry :=
  { keyed := [("A", some "project:a"), ("B", some "project:b")],
    dflt := some "project:b", open_ := ["A", "B"] }

def endOfA : LearnInput := { scope := none, domain := none, pinned := false, sessionId := some "A" }

theorem orig_end_uses_other_session_scope :
    effScope twoSessions (endCtxOrig twoSessions none endOfA) = some "project:b" := rfl
theorem orig_batch_uses_other_session_scope :
    effScope twoSessions (batchCtxOrig twoSessions none endOfA) = some "project:b" := rfl
theorem fixed_end_uses_own_scope :
    effScope twoSessions (endCtx twoSessions none endOfA) = some "project:a" := rfl
theorem fixed_batch_uses_own_scope :
    effScope twoSessions (batchCtx twoSessions none endOfA) = some "project:a" := rfl

/-- General form: with an explicit id of a registered session, every entry
point writes under THAT session's scope, whatever the process slot holds. -/
theorem entry_points_use_named_session (r : Registry) (proj : Option String)
    (s : String) (v : Option String) (h : r.keyed.lookup s = some v) (a : LearnInput)
    (hs : a.sessionId = some s) (hsc : a.scope = none) :
    effScope r (learnCtx r proj a) = v ∧
    effScope r (batchCtx r proj a) = v ∧
    effScope r (endCtx r proj a) = v := by
  simp [effScope, learnCtx, batchCtx, endCtx, resolveSession, hs, hsc, Registry.get, h]

/-! ### Pinned-quota gate (tools.ts plur_learn ~1247; batch now per item) -/

/-- `true` = the write is admitted. `free` is `pinnedQuota().free`. -/
def pinGate (free : Int) (pinned : Bool) : Bool := !(pinned && decide (free ≤ 0))

def learnAdmits (free : Int) (a : LearnInput) : Bool := pinGate free a.pinned
def batchAdmitsOrig (_free : Int) (_a : LearnInput) : Bool := true
def batchAdmits (free : Int) (a : LearnInput) : Bool := pinGate free a.pinned

theorem batch_gate_agrees (free : Int) (a : LearnInput) :
    batchAdmits free a = learnAdmits free a := rfl

def pinnedItem : LearnInput := { scope := some "global", domain := none, pinned := true, sessionId := none }

theorem orig_batch_bypasses_quota :
    learnAdmits 0 pinnedItem = false ∧ batchAdmitsOrig 0 pinnedItem = true := ⟨rfl, rfl⟩

/-- Non-vacuity: an unpinned item, or a pinned one with room, is admitted. -/
theorem gate_admits_good (free : Int) (a : LearnInput) (h : a.pinned = false ∨ 0 < free) :
    batchAdmits free a = true := by
  rcases h with h | h
  · simp [batchAdmits, pinGate, h]
  · have : ¬ free ≤ 0 := by omega
    simp [batchAdmits, pinGate, this]

/-! ### Reported decision and warning -/

inductive Decision | add | noop deriving DecidableEq

/-- Outcome of core learn(): `absorbed` = the returned engram is an existing one
(write_count bumped); `outbox` = queued for remote retry. -/
structure Outcome where
  absorbed : Bool
  outbox   : Bool

def reportOrig (_o : Outcome) : Decision := .add
def report (o : Outcome) : Decision := if o.absorbed then .noop else .add

theorem report_truthful (o : Outcome) : (report o = .noop ↔ o.absorbed = true) := by
  cases o with | mk ab ob => cases ab <;> simp [report]

theorem orig_report_lies : reportOrig ⟨true, false⟩ = .add := rfl

/-- Fallback warning claims "remote failed; queued" — fixed: only when queued. -/
def claimsQueuedOrig (_o : Outcome) : Bool := true
def claimsQueued (o : Outcome) : Bool := o.outbox

theorem warning_truthful (o : Outcome) : claimsQueued o = o.outbox := rfl
theorem orig_warning_lies : claimsQueuedOrig ⟨false, false⟩ = true := rfl

/-! ## 2. MCP session lifecycle (tools.ts `_cleanExpiredSessions`, session_end)

State: open sessions (telemetry), keyed registrations, and (fixed code only) the
set of ids an id-only sweep expired but could not clear. -/

structure LState where
  open_   : List String
  keyed   : List String
  pending : List String

/-- ORIGINAL sweep. `withPlur` = the caller had a Plur instance. Only ids still
in `open_` can be cleared from `keyed`. -/
def sweepOrig (expired : List String) (withPlur : Bool) (s : LState) : LState :=
  let gone := s.open_.filter (· ∈ expired)
  { open_ := s.open_.filter (· ∉ expired),
    keyed := if withPlur then s.keyed.filter (· ∉ gone) else s.keyed,
    pending := s.pending }

/-- FIXED sweep: expired ids go to `pending`; a plur-bearing sweep clears all
of `pending` from `keyed`. -/
def sweep (expired : List String) (withPlur : Bool) (s : LState) : LState :=
  let gone := s.open_.filter (· ∈ expired)
  let pend := s.pending ++ gone
  { open_ := s.open_.filter (· ∉ expired),
    keyed := if withPlur then s.keyed.filter (· ∉ pend) else s.keyed,
    pending := if withPlur then [] else pend }

/-- Invariant: every registration belongs to an open session or is pending. -/
def Inv (s : LState) : Prop := ∀ x ∈ s.keyed, x ∈ s.open_ ∨ x ∈ s.pending

theorem sweep_preserves_inv (e : List String) (w : Bool) (s : LState) (h : Inv s) :
    Inv (sweep e w s) := by
  intro x hx
  cases w with
  | false =>
    simp only [sweep, Bool.false_eq_true, ↓reduceIte] at hx ⊢
    rcases h x hx with ho | hp
    · by_cases he : x ∈ e
      · exact Or.inr (List.mem_append_right _ (List.mem_filter.mpr ⟨ho, by simp [he]⟩))
      · exact Or.inl (List.mem_filter.mpr ⟨ho, by simp [he]⟩)
    · exact Or.inr (List.mem_append_left _ hp)
  | true =>
    simp [sweep] at hx ⊢
    obtain ⟨hk, hnp, hno⟩ := hx
    rcases h x hk with ho | hp
    · refine ⟨ho, ?_⟩
      rcases hno with h1 | h1
      · exact absurd ho h1
      · exact h1
    · exact absurd hp hnp

/-- After a plur-bearing sweep nothing is pending: every registration is open. -/
theorem plur_sweep_no_leak (e : List String) (s : LState) (h : Inv s) :
    ∀ x ∈ (sweep e true s).keyed, x ∈ (sweep e true s).open_ := by
  intro x hx
  rcases sweep_preserves_inv e true s h x hx with ho | hp
  · exact ho
  · simp [sweep] at hp

/-- Replayed counterexample: session "old" expires in an id-only sweep (plur_learn),
then a plur-bearing sweep (session_start) runs; the registration survives. -/
def s0 : LState := { open_ := ["old"], keyed := ["old"], pending := [] }

theorem orig_leaks :
    (sweepOrig [] true (sweepOrig ["old"] false s0)).keyed = ["old"] ∧
    (sweepOrig [] true (sweepOrig ["old"] false s0)).open_ = [] := by decide

theorem fixed_no_leak :
    (sweep [] true (sweep ["old"] false s0)).keyed = [] := by decide

/-- Non-vacuity: a live session's registration survives a sweep. -/
theorem live_session_kept :
    (sweep [] true { open_ := ["live"], keyed := ["live"], pending := [] }).keyed = ["live"] := by decide

/-- Id-less session_end: which session it ends. Original: none. Fixed: the
lone open one (same resolution as every other tool). -/
def endTargetOrig (_open : List String) (explicit : Option String) : Option String := explicit
def endTarget (open_ : List String) (explicit : Option String) : Option String :=
  resolveSession { keyed := [], dflt := none, open_ := open_ } explicit

theorem orig_idless_end_noop : endTargetOrig ["A"] none = none := rfl
theorem fixed_idless_end_ends_lone : endTarget ["A"] none = some "A" := rfl
theorem idless_end_ambiguous_ends_nothing : endTarget ["A", "B"] none = none := rfl

/-- ORIGINAL (before decision E7): with two sessions open and no id, plur_learn's
write took the process slot = the last-started session's scope (replayed). -/
def noId : LearnInput := { scope := none, domain := none, pinned := false, sessionId := none }
theorem ambiguous_learn_takes_last_started :
    effScope twoSessions (learnCtx twoSessions none noId) = some "project:b" := rfl

/-! ### Decision E7 applied (MCP side): `_resolveWriteSession` passes core's
`NO_SESSION` when no session resolves (no id, and zero or several open), and
`SessionScopeRegistry.get(NO_SESSION)` is `null` — neither a keyed registration
nor the process slot. Modelled as: an unresolved session contributes no
default. Writes (learn, batch, session_end) and injects all use it. -/

def effScopeW (r : Registry) (c : Ctx) : Option String :=
  c.scope <|> (match c.session with
               | some s => r.get (some s)
               | none => none)          -- NO_SESSION

/-- No resolvable session ⇒ no session default, whatever the process slot
holds, for every entry point. -/
theorem unresolved_session_no_default (r : Registry) (proj : Option String) (a : LearnInput)
    (hres : resolveSession r a.sessionId = none) (hsc : a.scope = none) :
    effScopeW r (learnCtx r proj a) = none ∧
    effScopeW r (batchCtx r proj a) = none ∧
    effScopeW r (endCtx r proj a) = none := by
  simp [effScopeW, learnCtx, batchCtx, endCtx, hres, hsc]

theorem fixed_ambiguous_no_default :
    effScopeW twoSessions (learnCtx twoSessions none noId) = none := rfl
/-- Zero sessions open: a stale process slot is not used either. -/
theorem fixed_no_session_ignores_slot :
    effScopeW { keyed := [], dflt := some "group:acme/eng", open_ := [] }
      (learnCtx { keyed := [], dflt := some "group:acme/eng", open_ := [] } none noId) = none := rfl

/-- Non-vacuity: exactly one open session still supplies its default, and an
explicit id still wins with several open (`entry_points_use_named_session`). -/
theorem lone_session_default (s : String) (v : Option String) (d : Option String) :
    effScopeW { keyed := [(s, v)], dflt := d, open_ := [s] }
      (learnCtx { keyed := [(s, v)], dflt := d, open_ := [s] } none noId) = v := by
  simp [effScopeW, learnCtx, resolveSession, noId, Registry.get]
theorem named_session_with_several_open :
    effScopeW twoSessions (learnCtx twoSessions none endOfA) = some "project:a" := rfl


/-! ## 3. Claude settings.json hook merge (cli/src/commands/init.ts mergeHooks)

One event's entry list (events are merged independently). A hook spec is
abstracted to the features the classifier reads. -/

structure Spec where
  hasCommand : Bool   -- `command` is a string (false for `type: "prompt"`)
  plurBinary : Bool   -- names `@plur-ai/cli` or the `.plur/bin/plur-hook` shim
  winPath    : Bool   -- the shim path is written with backslashes
  hookSub    : Bool   -- runs a `hook-*` subcommand
deriving DecidableEq

abbrev Entry := List Spec

/-- ORIGINAL `isPlurHook` on one spec: `none` = throws (`h.command.includes`
on undefined). The literal `.plur/bin/plur-hook` misses a backslash path; any
PLUR-binary command counts, subcommand or not. -/
def plurSpecOrig (h : Spec) : Option Bool :=
  if !h.hasCommand then none else some (h.plurBinary && !h.winPath)

/-- FIXED `isPlurHookSpec`: string command, binary after `\ → /`, `hook-*`. -/
def plurSpec (h : Spec) : Bool := h.hasCommand && h.plurBinary && h.hookSub

/-- FIXED `stripPlurHooks`, per spec. -/
def strip (es : List Entry) : List Entry :=
  es.filterMap fun e =>
    if e.any plurSpec then
      (if (e.filter (fun h => !plurSpec h)).isEmpty then none
       else some (e.filter (fun h => !plurSpec h)))
    else some e

def merge (es adds : List Entry) : List Entry := strip es ++ adds

/-- What PLUR installs: every entry non-empty and all of its specs PLUR's. -/
def Installable (adds : List Entry) : Prop := ∀ e ∈ adds, e ≠ [] ∧ ∀ h ∈ e, plurSpec h = true

theorem strip_no_plur (es : List Entry) : ∀ e ∈ strip es, ∀ h ∈ e, plurSpec h = false := by
  intro e he h hh
  simp only [strip, List.mem_filterMap] at he
  obtain ⟨e0, _, hmap⟩ := he
  by_cases ha : e0.any plurSpec = true
  · simp only [ha, ↓reduceIte] at hmap
    split at hmap
    · simp at hmap
    · simp only [Option.some.injEq] at hmap
      subst hmap
      simpa using (List.mem_filter.mp hh).2
  · simp only [ha, Bool.false_eq_true, ↓reduceIte, Option.some.injEq] at hmap
    subst hmap
    cases hp : plurSpec h
    · rfl
    · exact absurd (List.any_eq_true.mpr ⟨h, hh, hp⟩) ha

theorem strip_id_of_clean (es : List Entry) (h : ∀ e ∈ es, ∀ x ∈ e, plurSpec x = false) :
    strip es = es := by
  induction es with
  | nil => rfl
  | cons e rest ih =>
    have he : e.any plurSpec = false := by
      rw [List.any_eq_false]; intro x hx; simp [h e (by simp) x hx]
    have ih' := ih (fun e' he' => h e' (by simp [he']))
    simp only [strip, List.filterMap_cons, he, Bool.false_eq_true, ↓reduceIte] at ih' ⊢
    rw [ih']

theorem strip_installable (adds : List Entry) (h : Installable adds) : strip adds = [] := by
  induction adds with
  | nil => rfl
  | cons e rest ih =>
    obtain ⟨hne, hall⟩ := h e (by simp)
    have ha : e.any plurSpec = true := by
      cases e with
      | nil => exact absurd rfl hne
      | cons x xs => simp [List.any_cons, hall x (by simp)]
    have hf : (e.filter (fun h => !plurSpec h)).isEmpty = true := by
      rw [List.isEmpty_iff, List.filter_eq_nil_iff]; intro x hx; simp [hall x hx]
    have ih' := ih (fun e' he' => h e' (by simp [he']))
    simp only [strip, List.filterMap_cons, ha, ↓reduceIte, hf] at ih' ⊢
    exact ih'

theorem strip_append (a b : List Entry) : strip (a ++ b) = strip a ++ strip b := by
  simp [strip, List.filterMap_append]

/-- Idempotence: re-running `plur init` changes nothing. -/
theorem merge_idempotent (es adds : List Entry) (h : Installable adds) :
    merge (merge es adds) adds = merge es adds := by
  unfold merge
  rw [strip_append, strip_installable adds h, strip_id_of_clean _ (strip_no_plur es)]
  simp

/-- Preservation: every spec that is not PLUR's survives the merge. -/
theorem merge_preserves_user (es adds : List Entry) (e : Entry) (he : e ∈ es)
    (x : Spec) (hx : x ∈ e) (hu : plurSpec x = false) :
    ∃ e' ∈ merge es adds, x ∈ e' := by
  unfold merge strip
  by_cases ha : e.any plurSpec = true
  · refine ⟨e.filter (fun h => !plurSpec h), ?_, by simp [hx, hu]⟩
    apply List.mem_append_left
    apply List.mem_filterMap.mpr
    refine ⟨e, he, ?_⟩
    have hne : (e.filter (fun h => !plurSpec h)).isEmpty = false := by
      cases hk : (e.filter (fun h => !plurSpec h)).isEmpty
      · rfl
      · have : x ∈ e.filter (fun h => !plurSpec h) := by simp [hx, hu]
        rw [List.isEmpty_iff] at hk; rw [hk] at this; simp at this
    simp [ha, hne]
  · refine ⟨e, List.mem_append_left _ (List.mem_filterMap.mpr ⟨e, he, ?_⟩), hx⟩
    simp only [ha, Bool.false_eq_true, ↓reduceIte]

/-! ORIGINAL code counterexamples, each replayed with the built CLI. -/

/-- ORIGINAL strip (whole entry, total only if no spec throws). -/
def stripOrig (es : List Entry) : Option (List Entry) :=
  es.foldr (fun e acc => do
    let flags ← e.mapM plurSpecOrig
    let rest ← acc
    pure (if flags.any id then rest else e :: rest)) (some [])

def mergeOrig (es adds : List Entry) : Option (List Entry) := (· ++ adds) <$> stripOrig es

def plurShimPosix : Spec := ⟨true, true, false, true⟩
def plurShimWin   : Spec := ⟨true, true, true, true⟩
def userLint      : Spec := ⟨true, false, false, false⟩
def userPlurLearn : Spec := ⟨true, true, false, false⟩   -- `npx @plur-ai/cli learn …`
def promptHook    : Spec := ⟨false, false, false, false⟩

/-- `type: "prompt"` hook → init throws (replay: exit 1, "Cannot read properties of undefined"). -/
theorem orig_prompt_throws : mergeOrig [[promptHook]] [[plurShimPosix]] = none := by decide
/-- Mixed entry → the user's `./my-lint.sh` is deleted. -/
theorem orig_mixed_loses_user :
    mergeOrig [[plurShimPosix, userLint]] [[plurShimPosix]] = some [[plurShimPosix]] := by decide
/-- `npx @plur-ai/cli learn …` user hook → deleted. -/
theorem orig_user_plur_cli_lost :
    mergeOrig [[userPlurLearn]] [[plurShimPosix]] = some [[plurShimPosix]] := by decide
/-- Windows shim → not recognised, so every re-run appends another copy. -/
theorem orig_windows_not_idempotent :
    (mergeOrig [[plurShimWin]] [[plurShimWin]]) = some [[plurShimWin], [plurShimWin]] := by decide

/-- The fixed merge on the same inputs. -/
theorem fixed_cases :
    merge [[promptHook]] [[plurShimPosix]] = [[promptHook], [plurShimPosix]] ∧
    merge [[plurShimPosix, userLint]] [[plurShimPosix]] = [[userLint], [plurShimPosix]] ∧
    merge [[userPlurLearn]] [[plurShimPosix]] = [[userPlurLearn], [plurShimPosix]] ∧
    merge [[plurShimWin]] [[plurShimWin]] = [[plurShimWin]] := by decide

/-! ### Decision S4 (2) applied: `plur doctor` hasAnyPlurHook (cli/src/commands/doctor.ts)

Doctor asks "is a PLUR hook installed?" (any subcommand). ORIGINAL: the literal
`.plur/bin/plur-hook` test missed the backslash shim path. FIXED: string command
and the binary check after `\ → /`. -/

def doctorDetectsOrig (h : Spec) : Bool := h.hasCommand && h.plurBinary && !h.winPath
def doctorDetects (h : Spec) : Bool := h.hasCommand && h.plurBinary

/-- Whatever init installs (or would strip as PLUR's), doctor sees. -/
theorem doctor_sees_installed (h : Spec) (hp : plurSpec h = true) : doctorDetects h = true := by
  simp only [plurSpec, Bool.and_eq_true] at hp
  simp [doctorDetects, hp.1.1, hp.1.2]
theorem doctor_ignores_user (h : Spec) (hu : h.plurBinary = false) : doctorDetects h = false := by
  simp [doctorDetects, hu]
theorem orig_doctor_misses_windows :
    plurSpec plurShimWin = true ∧ doctorDetectsOrig plurShimWin = false := by decide


/-! ## 4. Cursor installer merges (cli/src/cursor-hooks.ts, mcp-config.ts)

(a) hooks.json top level: `version`, `hooks`, and keys PLUR does not own.
(b) the healed MCP entry's env: `{...existing, ...caller}` versus replace. -/

structure CursorCfg where
  version : Nat
  hooks   : List Entry
  extra   : List (String × String)   -- unknown top-level keys ($schema, …)

def mergeCursorOrig (c : CursorCfg) (adds : List Entry) : CursorCfg :=
  { version := c.version, hooks := strip c.hooks ++ adds, extra := [] }
def mergeCursor (c : CursorCfg) (adds : List Entry) : CursorCfg :=
  { c with hooks := strip c.hooks ++ adds }

theorem cursor_keeps_extra (c : CursorCfg) (adds : List Entry) :
    (mergeCursor c adds).extra = c.extra := rfl
theorem cursor_idempotent (c : CursorCfg) (adds : List Entry) (h : Installable adds) :
    mergeCursor (mergeCursor c adds) adds = mergeCursor c adds := by
  simp only [mergeCursor]
  have := merge_idempotent c.hooks adds h
  simp only [merge] at this
  rw [this]
theorem orig_cursor_drops_extra :
    (mergeCursorOrig ⟨1, [], [("$schema", "x")]⟩ []).extra = [] := rfl

abbrev Env := List (String × String)

/-- `{...a, ...b}` as a lookup table: `b` wins, `a` supplies the rest. -/
def envSpread (a b : Env) : Env := b ++ a

def envHealOrig (_old caller : Env) : Env := caller
def envHeal (old caller : Env) : Env := envSpread old caller

theorem heal_sets_caller_keys (old caller : Env) (k v : String) (h : caller.lookup k = some v) :
    (envHeal old caller).lookup k = some v := by
  simp [envHeal, envSpread, List.lookup_append, h]

theorem heal_keeps_user_keys (old caller : Env) (k : String) (h : caller.lookup k = none) :
    (envHeal old caller).lookup k = old.lookup k := by
  simp [envHeal, envSpread, List.lookup_append, h]

theorem orig_heal_loses_plur_path :
    (envHealOrig [("PLUR_PATH", "/data/team-plur"), ("PLUR_TOOL_PROFILE", "full")]
                 [("PLUR_TOOL_PROFILE", "cursor")]).lookup "PLUR_PATH" = none := by decide
theorem fixed_heal_keeps_plur_path :
    (envHeal [("PLUR_PATH", "/data/team-plur"), ("PLUR_TOOL_PROFILE", "full")]
             [("PLUR_TOOL_PROFILE", "cursor")]).lookup "PLUR_PATH" = some "/data/team-plur" ∧
    (envHeal [("PLUR_PATH", "/data/team-plur"), ("PLUR_TOOL_PROFILE", "full")]
             [("PLUR_TOOL_PROFILE", "cursor")]).lookup "PLUR_TOOL_PROFILE" = some "cursor" := by decide


/-! ## 5. CLI exit codes (cli/src/commands/feedback.ts, forget.ts, scopes.ts)

Property: exit 0 ⇔ the requested mutation succeeded, and the code does not
depend on the output mode (JSON when piped / --json, text on a TTY). -/

inductive Mode | json | text deriving DecidableEq

/-- Outcomes of the modelled commands. -/
inductive Cmd
  | feedbackBatch (oks : List Bool)          -- per-item success
  | forgetSearch (hits : Nat)                -- 1 = retired; 0 / ≥2 = nothing retired
  | scopesRegister (ok : Bool)
deriving DecidableEq

def succeeded : Cmd → Bool
  | .feedbackBatch oks => oks.all id
  | .forgetSearch n => n == 1
  | .scopesRegister ok => ok

def exitOrig : Mode → Cmd → Nat
  | _, .feedbackBatch _ => 0
  | .json, .forgetSearch _ => 0
  | .text, .forgetSearch n => if n == 0 then 1 else 0
  | .json, .scopesRegister _ => 0
  | .text, .scopesRegister ok => if ok then 0 else 1

/-- The code as fixed. Decision S1 applied: a refused `scopes register --json`
sets `process.exitCode = 1`, like text mode. -/
def exitFixed : Mode → Cmd → Nat
  | _, .feedbackBatch oks => if oks.all id then 0 else 1
  | _, .forgetSearch n => if n == 1 then 0 else 1
  | _, .scopesRegister ok => if ok then 0 else 1

/-- The intended rule, which the fix meets on every command it changed. -/
def exitSpec (_m : Mode) (c : Cmd) : Nat := if succeeded c then 0 else 1

theorem fixed_meets_spec_feedback (m : Mode) (oks : List Bool) :
    exitFixed m (.feedbackBatch oks) = exitSpec m (.feedbackBatch oks) := by
  cases m <;> rfl
theorem fixed_meets_spec_forget (m : Mode) (n : Nat) :
    exitFixed m (.forgetSearch n) = exitSpec m (.forgetSearch n) := by
  cases m <;> rfl
theorem fixed_meets_spec_scopes (m : Mode) (ok : Bool) :
    exitFixed m (.scopesRegister ok) = exitSpec m (.scopesRegister ok) := by
  cases m <;> rfl
/-- Every modelled command meets the rule, in both modes (S1 closed the residue). -/
theorem fixed_meets_spec (m : Mode) (c : Cmd) : exitFixed m c = exitSpec m c := by
  cases c with
  | feedbackBatch oks => exact fixed_meets_spec_feedback m oks
  | forgetSearch n => exact fixed_meets_spec_forget m n
  | scopesRegister ok => exact fixed_meets_spec_scopes m ok
theorem fixed_mode_independent (c : Cmd) :
    exitFixed .json c = exitFixed .text c := by
  rw [fixed_meets_spec, fixed_meets_spec]; rfl

theorem orig_batch_all_fail_exit0 : exitOrig .text (.feedbackBatch [false]) = 0 := rfl
theorem orig_forget_mode_dependent :
    exitOrig .json (.forgetSearch 0) = 0 ∧ exitOrig .text (.forgetSearch 0) = 1 := ⟨rfl, rfl⟩
theorem orig_forget_ambiguous_exit0 : exitOrig .text (.forgetSearch 2) = 0 := rfl
/-- The pre-S1 residue, on the original code: mode-dependent. -/
theorem orig_scopes_mode_dependent :
    exitOrig .json (.scopesRegister false) = 0 ∧ exitOrig .text (.scopesRegister false) = 1 := ⟨rfl, rfl⟩
theorem fixed_scopes_refused_exit1 (m : Mode) : exitFixed m (.scopesRegister false) = 1 := by
  cases m <;> rfl
/-- Non-vacuity: success exits 0. -/
theorem fixed_success_exit0 (m : Mode) : exitFixed m (.forgetSearch 1) = 0 ∧ exitFixed m (.feedbackBatch []) = 0 := by
  cases m <;> exact ⟨rfl, rfl⟩


/-! ## 6. dsh write tools (packages/dsh/src/tools.ts, learn.ts, engine.ts)

A client is either absent, the engine facade (always has every method; a
write resolves to a no-op when core did not load), or an injected client with
or without the method. -/

inductive Client
  | none
  | facade (loaded : Bool)
  | injected (hasMethod : Bool)
deriving DecidableEq

/-- Did a write actually reach an engine? -/
def performs : Client → Bool
  | .none => false
  | .facade loaded => loaded
  | .injected m => m

/-- ORIGINAL: `await plur?.learn?.(…); return true` — resolved ⇒ "Stored.". -/
def reportsStoredOrig : Client → Bool
  | _ => true

/-- FIXED: `writable(plur, m)` — method present, and `ready()` when offered. -/
def writableM : Client → Bool
  | .none => false
  | .facade loaded => loaded      -- facade has the method; ready() = loaded
  | .injected m => m              -- no ready(): trusted when the method exists

def reportsStored (c : Client) : Bool := writableM c

theorem dsh_report_truthful (c : Client) : reportsStored c = performs c := by
  cases c <;> rfl
theorem orig_dsh_stored_without_engine :
    reportsStoredOrig (.facade false) = true ∧ performs (.facade false) = false := ⟨rfl, rfl⟩
theorem dsh_good_case_reachable : reportsStored (.facade true) = true := rfl

/-! ### Decision S3 applied: the write queue's hard cap (dsh/src/guard.ts
`createWriteQueue`, learn.ts, capture.ts)

A write takes `d` ms (`none` = never settles). The slot is held for `hold`;
the next write starts then. ORIGINAL (auto-learn/capture): `queue(guard(write,
soft))`, so the slot was held `min d soft`. FIXED: the queue holds it until the
write settles or `hard` elapses. The tool caller still waits `min d soft`. -/

def holdFor (cap : Nat) : Option Nat → Nat
  | some d => min d cap
  | none => cap

/-- Did the next write start while this one was still running? -/
def overlaps (d : Option Nat) (hold : Nat) : Bool :=
  match d with
  | some x => decide (hold < x)
  | none => true

def holdOrig (soft : Nat) (d : Option Nat) : Nat := holdFor soft d
def holdFixed (hard : Nat) (d : Option Nat) : Nat := holdFor hard d

/-- Serialised: a write that settles within the hard cap is never overlapped,
however far past the soft timeout it ran. -/
theorem fixed_serialises_within_cap (hard x : Nat) (h : x ≤ hard) :
    overlaps (some x) (holdFixed hard (some x)) = false := by
  simp [overlaps, holdFixed, holdFor, Nat.min_eq_left h]

/-- Never wedged: whatever the write does, the slot is free after `hard`. -/
theorem fixed_bounded (hard : Nat) (d : Option Nat) : holdFixed hard d ≤ hard := by
  cases d <;> simp [holdFixed, holdFor, Nat.min_le_right]

/-- The tool caller's wait is unchanged: UNAVAILABLE at the soft timeout. -/
def callerWait (soft : Nat) (d : Option Nat) : Nat := holdFor soft d
theorem caller_wait_soft (soft : Nat) (d : Option Nat) : callerWait soft d ≤ soft := by
  cases d <;> simp [callerWait, holdFor, Nat.min_le_right]

/-- Replayed counterexample (scratchpad/q.mts): A takes 100 ms, soft 10 ms —
B started while A ran. Fixed with the 60 s cap: no overlap. -/
theorem orig_overlaps_past_soft : overlaps (some 100) (holdOrig 10 (some 100)) = true := by decide
theorem fixed_replay_serialised : overlaps (some 100) (holdFixed 60000 (some 100)) = false := by decide
/-- Non-vacuity: a write that never settles is released exactly at the cap. -/
theorem hung_released_at_cap : holdFixed 60000 none = 60000 := rfl


/-! ## 7. Hermes bridge argv (packages/hermes/plur_hermes/bridge.py learn)

The CLI's parser is abstracted as `readsAsFlag : String → Bool` (an oracle:
`--json`, `--path`, `--x=…`, the learn flags). The only fact used about it is
that every token it reads as a flag starts with `-` (`hDash`). `plur learn`
takes the first non-flag positional as the statement, else stdin. -/

structure Delivery where
  argv  : List String
  stdin : Option String

/-- What `plur learn` stores: first positional not read as a flag, else stdin.
(`none` = refused / usage error.) -/
def cliStatement (readsAsFlag : String → Bool) (d : Delivery) : Option String :=
  match d.argv.find? (fun t => !readsAsFlag t) with
  | some t => some t
  | none => d.stdin

def startsDash (t : String) : Bool := t.startsWith "-"

/-- `deliver` is the rule of BOTH bridges: hermes `plur_hermes/bridge.py learn`
and, since decision S4 (3), the python client `plur_ai/client.py learn`
(via `run_json(…, input=)`), so `bridge_statement_verbatim` covers both. -/
def deliverOrig (st : String) : Delivery := { argv := [st], stdin := none }
def deliver (st : String) : Delivery :=
  if startsDash st then { argv := [], stdin := some st } else { argv := [st], stdin := none }

theorem bridge_statement_verbatim (readsAsFlag : String → Bool)
    (hDash : ∀ t, readsAsFlag t = true → startsDash t = true) (st : String) :
    cliStatement readsAsFlag (deliver st) = some st := by
  unfold deliver
  by_cases h : startsDash st = true
  · simp [h, cliStatement]
  · have hf : readsAsFlag st = false := by
      cases hr : readsAsFlag st
      · rfl
      · exact absurd (hDash st hr) h
    simp [h, cliStatement, hf]

/-- Counterexample: the replayed statement is read as a flag and nothing is stored. -/
def replayFlag (t : String) : Bool := t == "--dry-run=true is required for every deploy"
theorem orig_flag_statement_refused :
    cliStatement replayFlag (deliverOrig "--dry-run=true is required for every deploy") = none := by
  decide
theorem ordinary_statement_in_argv : (deliver "Use pnpm, not npm").argv = ["Use pnpm, not npm"] := by
  simp [deliver, startsDash]

/-! ### Decision S4 (1) applied: the CLI honours `--` (cli/src/plur.ts
`parseGlobalFlags`, cli/src/commands/learn.ts).

`learnParse` walks argv: a token the parser reads as a flag is skipped (value
consumption abstracted into the oracle), `--` ends parsing and the NEXT token is
the statement. The original parser had no `--` case, so `--` itself — not a
known flag — became the statement. Global flags (`--path`) are only read from
the tokens before `--`. -/

def learnParse (rf : String → Bool) : List String → Option String
  | [] => none
  | t :: rest => if t = "--" then rest.head? else if rf t then learnParse rf rest else some t

def learnParseOrig (rf : String → Bool) (argv : List String) : Option String :=
  argv.find? (fun t => !rf t)

/-- Whatever flags precede it, `-- st` stores `st` verbatim. -/
theorem learn_sep_verbatim (rf : String → Bool) (pre : List String) (st : String)
    (rest : List String) (hpre : ∀ t ∈ pre, rf t = true ∧ t ≠ "--") :
    learnParse rf (pre ++ "--" :: st :: rest) = some st := by
  induction pre with
  | nil => simp [learnParse]
  | cons t ts ih =>
    have ht := hpre t (List.mem_cons_self ..)
    have hts : ∀ u ∈ ts, rf u = true ∧ u ≠ "--" := fun u hu => hpre u (List.mem_cons_of_mem _ hu)
    simp [learnParse, ht.1, ht.2, ih hts]

/-- The global `--path` is read only before `--` (`isPath` is an oracle for
"this token, after `=` expansion, is `--path`"). -/
def globalPath (isPath : String → Bool) (argv : List String) : Option String :=
  (argv.takeWhile (· ≠ "--")).find? isPath
def globalPathOrig (isPath : String → Bool) (argv : List String) : Option String :=
  argv.find? isPath

theorem takeWhile_sep (pre post : List String) (hpre : "--" ∉ pre) :
    (pre ++ "--" :: post).takeWhile (· ≠ "--") = pre.takeWhile (· ≠ "--") := by
  induction pre with
  | nil => simp
  | cons t ts ih =>
    have ht : t ≠ "--" := fun h => hpre (h ▸ List.mem_cons_self ..)
    have hts : "--" ∉ ts := fun h => hpre (List.mem_cons_of_mem _ h)
    rw [List.cons_append, List.takeWhile_cons_of_pos (by simpa using ht),
      List.takeWhile_cons_of_pos (by simpa using ht), ih hts]

theorem statement_never_selects_store (isPath : String → Bool) (pre post : List String)
    (hpre : "--" ∉ pre) :
    globalPath isPath (pre ++ "--" :: post) = globalPath isPath pre := by
  unfold globalPath; rw [takeWhile_sep pre post hpre]

/-- Replayed counterexamples on the original parser. -/
def rfReplay (t : String) : Bool := t == "--json" || t == "--dry-run=true is required for deploys"
theorem orig_sep_stored_literally :
    learnParseOrig rfReplay ["--", "--dry-run=true is required for deploys"] = some "--" := by decide
def isPathReplay (t : String) : Bool := t == "--path=P/other"
theorem orig_statement_selects_store :
    globalPathOrig isPathReplay ["learn", "--", "--path=P/other"] = some "--path=P/other" := by decide
theorem fixed_sep_cases :
    learnParse rfReplay ["--", "--dry-run=true is required for deploys"] =
      some "--dry-run=true is required for deploys" ∧
    globalPath isPathReplay ["learn", "--", "--path=P/other"] = none := by decide
/-- Non-vacuity: a global flag before `--` still selects the store. -/
theorem path_before_sep_kept :
    globalPath isPathReplay ["--path=P/other", "learn", "--", "x"] = some "--path=P/other" := by decide


/-! ## 8. (a) MCP array coercion; (b) init-remote `.plur.yaml` rewrite

(a) tools.ts `jsonSchemaPropToZod`: a bare string sent for an array param.
ORIGINAL: split on commas whenever the items accept strings, which for
`engram_suggestions` (union items, free-text statements) turned one statement
into several engrams. Decision S2 applied: union items (`anyOf`/`oneOf` with a
string variant) take the string as ONE item; `items: {type: string}` (tags)
keep the comma split. -/

/-- A statement as a token list (words and commas); the coercion splits on commas. -/
inductive Tok | word (w : String) | comma deriving DecidableEq

def splitCommas : List Tok → List (List Tok)
  | [] => [[]]
  | .comma :: rest => [] :: splitCommas rest
  | t :: rest => match splitCommas rest with
    | [] => [[t]]
    | g :: gs => (t :: g) :: gs

def coerceComma (v : List Tok) : List (List Tok) := (splitCommas v).filter (· ≠ [])

/-- "Use pnpm, not npm" — one statement — becomes two engrams (replayed). -/
theorem comma_split_breaks_statement :
    coerceComma [.word "Use", .word "pnpm", .comma, .word "not", .word "npm"] =
      [[.word "Use", .word "pnpm"], [.word "not", .word "npm"]] := by decide

/-- Item schema of an array param: plain string items (tags) or a union that
accepts a string (free-text statements). -/
inductive ItemKind | plainString | unionWithString deriving DecidableEq

/-- ORIGINAL: every string-accepting item kind is comma-split. -/
def coerceOrig (_k : ItemKind) (v : List Tok) : List (List Tok) := coerceComma v
/-- FIXED (S2): union items take the bare string as one item (`[]` when empty). -/
def coerce : ItemKind → List Tok → List (List Tok)
  | .plainString, v => coerceComma v
  | .unionWithString, v => if v = [] then [] else [v]

/-- A statement list never alters a statement: it arrives verbatim, as one item. -/
theorem statement_list_verbatim (v : List Tok) (h : v ≠ []) :
    coerce .unionWithString v = [v] := by simp [coerce, h]
/-- Tag lists keep the #297 comma workaround unchanged. -/
theorem tags_unchanged (v : List Tok) : coerce .plainString v = coerceOrig .plainString v := rfl
/-- The replayed input now yields one engram, and a tag list still splits. -/
theorem fixed_coercion_cases :
    coerce .unionWithString [.word "Use", .word "pnpm", .comma, .word "not", .word "npm"] =
      [[.word "Use", .word "pnpm", .comma, .word "not", .word "npm"]] ∧
    coerce .plainString [.word "a", .comma, .word "b"] = [[.word "a"], [.word "b"]] := by decide

/-! (b) `stripRemoteKeys` / `buildConfigBody`, at line granularity. A line is
PLUR-owned if it is a top-level remote key (or a list item under one — the
list-skip is abstracted into the classifier) or, after the fix, one of the two
header comment lines. Trailing-blank trimming is left out. -/

structure Line where
  topRemoteKey : Bool   -- `remote_url:` etc. at column 0 (or its list items)
  nestedRemote : Bool   -- `  remote_url:` under a user key
  header       : Bool   -- one of the two header comments PLUR writes
deriving DecidableEq

def oursOrig (l : Line) : Bool := l.topRemoteKey || l.nestedRemote   -- trimmed match, no header
def ours (l : Line) : Bool := l.topRemoteKey || l.header

def stripY (own : Line → Bool) (xs : List Line) : List Line := xs.filter (fun l => !own l)
def buildY (own : Line → Bool) (xs block : List Line) : List Line := stripY own xs ++ block

theorem buildY_idempotent (xs block : List Line) (hb : ∀ l ∈ block, ours l = true) :
    buildY ours (buildY ours xs block) block = buildY ours xs block := by
  simp only [buildY, stripY, List.filter_append]
  have h1 : List.filter (fun l => !ours l) (List.filter (fun l => !ours l) xs) =
      List.filter (fun l => !ours l) xs := by
    rw [List.filter_filter]; congr 1; funext l; cases ours l <;> rfl
  have h2 : List.filter (fun l => !ours l) block = [] := by
    rw [List.filter_eq_nil_iff]; intro l hl; simp [hb l hl]
  rw [h1, h2, List.append_nil]

theorem buildY_keeps_nested (xs block : List Line) (l : Line) (hl : l ∈ xs)
    (h : l.topRemoteKey = false ∧ l.header = false) : l ∈ buildY ours xs block := by
  simp [buildY, stripY, ours, hl, h.1, h.2]

def hdr : Line := ⟨false, false, true⟩
def key : Line := ⟨true, false, false⟩
def nested : Line := ⟨false, true, false⟩
def blockY : List Line := [hdr, hdr, key]

theorem orig_header_accumulates :
    buildY oursOrig (buildY oursOrig [] blockY) blockY = [hdr, hdr, hdr, hdr, key] := by decide
theorem orig_nested_deleted : buildY oursOrig [nested] [] = [] := by decide
theorem fixed_init_remote_cases :
    buildY ours (buildY ours [] blockY) blockY = blockY ∧ buildY ours [nested] [] = [nested] := by decide


/-! ## 9. `.plur.yaml` scope trust across adapters

Decision function per adapter: given whether the file's directory is trusted
(`plur trust`) and the declared scope, which scope becomes the default.
ORIGINAL: only opencode checked trust. Decision E3 applied: every adapter
follows opencode (MCP `readTrustedProjectConfig`, dsh `trustedWorkspaceScope`,
CLI hooks `trustedProjectScope`); dsh additionally never adopts `global`
("the ambient global store is never a fallback"). -/

inductive Adapter | opencode | mcp | dsh | cliHook deriving DecidableEq

def adoptScopeOrig : Adapter → Bool → Option String → Option String
  | .opencode, trusted, d => if trusted then d else none   -- resolveTrustedScope
  | .mcp, _, d => d        -- plur_session_start: projectConfig.scope, no trust check
  | .dsh, _, d => d        -- readWorkspaceScope: unconditional
  | .cliHook, _, d => d    -- hook-inject: "local filters … need no gate"

def adoptScope : Adapter → Bool → Option String → Option String
  | .dsh, trusted, d => if trusted && d != some "global" then d else none
  | _, trusted, d => if trusted then d else none

/-- The owner's rule: an untrusted file never sets any adapter's scope. -/
theorem untrusted_never_adopted (a : Adapter) (d : Option String) :
    adoptScope a false d = none := by
  cases a <;> rfl

/-- Trusted directories behave as before (non-`global` scopes), and all
adapters agree. -/
theorem trusted_as_before (a : Adapter) (d : Option String) (hg : d ≠ some "global") :
    adoptScope a true d = d ∧ adoptScope a true d = adoptScopeOrig .opencode true d := by
  cases a <;> simp [adoptScope, adoptScopeOrig, hg]

theorem adapters_agree (a b : Adapter) (t : Bool) (d : Option String) (hg : d ≠ some "global") :
    adoptScope a t d = adoptScope b t d := by
  cases a <;> cases b <;> cases t <;> simp [adoptScope, hg]

/-- dsh never takes the ambient global store from a workspace file. -/
theorem dsh_never_global (t : Bool) (d : Option String) :
    adoptScope .dsh t d ≠ some "global" := by
  cases t <;> by_cases h : d = some "global" <;> simp [adoptScope, h]

/-- Non-vacuity: a trusted team scope is adopted. -/
theorem trusted_team_adopted : adoptScope .mcp true (some "group:acme/eng") = some "group:acme/eng" := rfl

/-- Replayed for MCP on the original code: an untrusted cloned repo's
`scope: group:acme/eng` became the session default. -/
theorem adapters_disagree_untrusted :
    adoptScopeOrig .mcp false (some "group:acme/eng") = some "group:acme/eng" ∧
    adoptScopeOrig .opencode false (some "group:acme/eng") = none := ⟨rfl, rfl⟩
theorem orig_dsh_global : adoptScopeOrig .dsh true (some "global") = some "global" := rfl

end PlurSpec.Adapters
