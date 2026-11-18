import PlurSpec.Adapters

/-!
# McpTools — session resolution, scope refusals and call serialisation

Models of packages/mcp/src/tools.ts (`_cleanExpiredSessions`,
`_implicitSessionId`, `_knownSession`, `_writeSession`, `_resolveWriteSession`,
`_resolveScopeSession`,
the plur_session_scope and plur_episode_to_engram handlers) and
packages/mcp/src/server.ts (`acquireCall` / `callTail`). Each section follows
the code branch for branch, proves the property, shows the good case is
reachable and keeps a counterexample for the broken variant.

Builds on Adapters §1–§2 (registry, pending-eviction sweep) instead of
re-proving them: §2 here links the eight-hour TTL to `Adapters.sweep`.
-/

namespace PlurSpec.McpTools

/-! ## 1. Which session default an unscoped write takes -/

/-- A `_sessionTelemetry` entry: the fields the resolution reads. -/
structure Rec where
  id       : String
  started  : Nat                     -- started_at, ms
  adjusted : Bool                    -- scope_adjusted
  wsKey    : Option String           -- workspace_key
  wsScope  : Option (Option String)  -- workspace_scope (`none` = undefined)
  dflt     : Option String           -- default_scope (what op:"clear" restores)

def TTL : Nat := 8 * 60 * 60 * 1000

/-- `started_at < Date.now() - SESSION_TTL_MS`. -/
def expired (now : Nat) (r : Rec) : Bool := decide (r.started + TTL < now)

/-- The telemetry `_cleanExpiredSessions` leaves. -/
def sweepTel (now : Nat) (tel : List Rec) : List Rec := tel.filter (fun r => !expired now r)

/-- `_implicitSessionId`: sweep, then the lone open session. -/
def implicit (now : Nat) (tel : List Rec) : Option String :=
  match sweepTel now tel with
  | [r] => some r.id
  | _ => none

/-- What a write hands core as `session`. `folder sc` is the registry key
`FOLDER_SCOPE_SESSION_PREFIX + sc`, registered with `sc` just before. -/
inductive Sess | noSession | key (s : String) | folder (sc : String) | undef
deriving DecidableEq

/-- Core's `SessionScopeRegistry`. -/
structure Core where
  keyed : List (String × Option String)
  slot  : Option String

/-- `SessionScopeRegistry.get`: an unregistered key, or no key, falls back to the slot. -/
def Core.get (c : Core) : Sess → Option String
  | .noSession => none
  | .key s => match c.keyed.lookup s with
              | some v => v
              | none => c.slot
  | .folder sc => some sc
  | .undef => c.slot

/-- The default a session holds of its own, never the slot. -/
def Core.own (c : Core) : Sess → Option String
  | .key s => (c.keyed.lookup s).getD none
  | .folder sc => some sc
  | _ => none

/-- `_knownSession(id, plur, viaServer)`; `reserved` = starts with NUL. -/
def known (reserved : String → Bool) (tel : List Rec) (c : Core) (viaServer : Bool) (id : String) : Bool :=
  !reserved id && (tel.any (·.id == id) || (!viaServer && (c.keyed.lookup id).isSome))

structure St where
  now  : Nat
  tel  : List Rec
  core : Core

/-- The workspace the FolderScopeContext resolves: unreadable (resolve threw or
answered null), or a key, the agreed scope and whether the roots disagree. -/
inductive WS | unreadable | ws (key : String) (scope : Option String) (disagree : Bool)

def WS.scope : WS → Option String
  | .unreadable => none
  | .ws _ sc _ => sc

inductive Out | refused | sess (s : Sess)
deriving DecidableEq

/-- `chosen` and the telemetry after it: `base`, else explicit, else implicit
(which sweeps). -/
def chosenOf (s : St) (base explicit : Option String) : Option String × List Rec :=
  match base with
  | some b => (some b, s.tel)
  | none => match explicit with
    | some e => (some e, s.tel)
    | none => (implicit s.now s.tel, sweepTel s.now s.tel)

/-- The tail of `_writeSession` once the workspace is read: the start default
holds while the session adjusted its scope, or while the workspace is the one
it started in; otherwise the workspace's agreed scope, or no session. -/
def holds (core : Core) (tel : List Rec) (c : String) (w : WS) : Bool :=
  match tel.find? (·.id == c) with
  | none => false
  | some r => r.adjusted ||
      ((core.get (.key c)).isSome && match w with
        | .unreadable => false
        | .ws k sc _ => r.wsKey == some k && r.wsScope == some sc)

def fallback (w : WS) : Out :=
  match w.scope with
  | none => .sess .noSession
  | some sc => .sess (.folder sc)

def rest (core : Core) (tel : List Rec) (session : Option String) (w : WS) : Out :=
  match session with
  | some c => if holds core tel c w then .sess (.key c) else fallback w
  | none => fallback w

/-- Without a FolderScopeContext: `chosen` if `_knownSession(chosen, plur, false)`, else NO_SESSION. -/
def localSess (res : String → Bool) (s : St) (base explicit : Option String) : Sess :=
  match (chosenOf s base explicit).1 with
  | some c => if known res (chosenOf s base explicit).2 s.core false c then .key c else .noSession
  | none => .noSession

/-- Through the server: `chosen` if this process started it, else no session. -/
def serverSession (res : String → Bool) (s : St) (base explicit : Option String) : Option String :=
  match (chosenOf s base explicit).1 with
  | some c => if known res (chosenOf s base explicit).2 s.core true c then some c else none
  | none => none

/-- `_writeSession`, branch for branch. `ctx = none`: no FolderScopeContext.
`free` = the write may land without a scope choice (`args.scope === undefined
&& !explicitDestinations && !read`); a split window then throws the refusal. -/
def writeSession (res : String → Bool) (s : St) (ctx : Option WS)
    (base explicit : Option String) (free : Bool) : Out :=
  match ctx with
  | none => .sess (localSess res s base explicit)
  | some w =>
    match w with
    | .ws _ _ true =>
      if free then .refused else rest s.core (chosenOf s base explicit).2 (serverSession res s base explicit) w
    | _ => rest s.core (chosenOf s base explicit).2 (serverSession res s base explicit) w

/-- ORIGINAL no-context branch: `return chosen ?? NO_SESSION`. -/
def writeSessionOrigNoCtx (s : St) (base explicit : Option String) : Out :=
  match (chosenOf s base explicit).1 with
  | some c => .sess (.key c)
  | none => .sess .noSession

/-- Every open session has its own registration: plur_session_start always
calls `setSessionScope(default_scope, {session})`. -/
def Reg (s : St) : Prop := ∀ r ∈ s.tel, (s.core.keyed.lookup r.id).isSome

theorem sweepTel_sub (now : Nat) (tel : List Rec) : ∀ r ∈ sweepTel now tel, r ∈ tel := by
  intro r h; exact (List.mem_filter.mp h).1

theorem chosen_tel_sub (s : St) (b e : Option String) : ∀ r ∈ (chosenOf s b e).2, r ∈ s.tel := by
  unfold chosenOf
  cases b with
  | some _ => intro r h; exact h
  | none => cases e with
    | some _ => intro r h; exact h
    | none => exact sweepTel_sub _ _

theorem known_registered (res : String → Bool) (s : St) (hr : Reg s) (tel : List Rec)
    (ht : ∀ r ∈ tel, r ∈ s.tel) (v : Bool) (c : String) (hk : known res tel s.core v c = true) :
    (s.core.keyed.lookup c).isSome := by
  simp only [known, Bool.and_eq_true, Bool.not_eq_true', Bool.or_eq_true, List.any_eq_true,
    beq_iff_eq] at hk
  rcases hk.2 with ⟨r, hm, he⟩ | ⟨_, h⟩
  · exact he ▸ hr r (ht r hm)
  · exact h

theorem fallback_cases (w : WS) :
    fallback w = Out.sess .noSession ∨ ∃ sc, fallback w = Out.sess (.folder sc) := by
  unfold fallback; cases w.scope <;> simp

theorem rest_cases (core : Core) (tel : List Rec) (session : Option String) (w : WS) :
    rest core tel session w = Out.sess .noSession ∨
    (∃ sc, rest core tel session w = Out.sess (.folder sc)) ∨
    (∃ c, session = some c ∧ rest core tel session w = Out.sess (.key c)) := by
  cases session with
  | none =>
    simp only [rest]
    rcases fallback_cases w with h | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
  | some c =>
    simp only [rest]
    by_cases hh : holds core tel c w = true
    · simp only [hh, ↓reduceIte]; exact Or.inr (Or.inr ⟨c, rfl, rfl⟩)
    · simp only [hh]; rcases fallback_cases w with h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)

theorem ctx_cases (res : String → Bool) (s : St) (w : WS) (b e : Option String) (free : Bool) :
    writeSession res s (some w) b e free = .refused ∨
    writeSession res s (some w) b e free = rest s.core (chosenOf s b e).2 (serverSession res s b e) w := by
  cases w with
  | unreadable => exact Or.inr rfl
  | ws k sc d => cases d with
    | false => exact Or.inr rfl
    | true => cases free with
      | true => exact Or.inl rfl
      | false => exact Or.inr rfl

/-- A server-side write result is no session, a workspace scope, or the
session `serverSession` admitted. -/
theorem server_cases (res : String → Bool) (s : St) (w : WS) (b e : Option String) (free : Bool) (x : Sess)
    (h : writeSession res s (some w) b e free = Out.sess x) :
    x = .noSession ∨ (∃ sc, x = .folder sc) ∨ (∃ c, serverSession res s b e = some c ∧ x = .key c) := by
  rcases ctx_cases res s w b e free with h1 | h1 <;> rw [h1] at h
  · cases h
  · rcases rest_cases s.core (chosenOf s b e).2 (serverSession res s b e) w with h2 | ⟨sc, h2⟩ | ⟨c, hc, h2⟩
      <;> rw [h2] at h <;> cases h
    · exact Or.inl rfl
    · exact Or.inr (Or.inl ⟨sc, rfl⟩)
    · exact Or.inr (Or.inr ⟨c, hc, rfl⟩)

theorem own_of_registered (c : Core) (k : String) (h : (c.keyed.lookup k).isSome) :
    c.get (.key k) = c.own (.key k) := by
  simp only [Core.get, Core.own]
  cases hl : c.keyed.lookup k with
  | none => simp [hl] at h
  | some v => rfl

/-- An unscoped write never takes the process-wide slot: the default core
reads for it is always a session's own (or the workspace's), never `slot`. -/
theorem write_never_process_slot (res : String → Bool) (s : St) (hr : Reg s) (ctx : Option WS)
    (b e : Option String) (free : Bool) (x : Sess)
    (h : writeSession res s ctx b e free = Out.sess x) : s.core.get x = s.core.own x := by
  have hsub := chosen_tel_sub s b e
  cases ctx with
  | none =>
    simp only [writeSession, Out.sess.injEq] at h
    subst h
    unfold localSess
    split
    · rename_i c _
      split
      · rename_i hk; exact own_of_registered _ _ (known_registered res s hr _ hsub false c hk)
      · rfl
    · rfl
  | some w =>
    rcases server_cases res s w b e free x h with h1 | ⟨sc, h1⟩ | ⟨c, hc, h1⟩ <;> subst h1
    · rfl
    · rfl
    · unfold serverSession at hc
      split at hc
      · rename_i c0 _
        split at hc
        · rename_i hk
          simp only [Option.some.injEq] at hc; subst hc
          exact own_of_registered _ _ (known_registered res s hr _ hsub true c0 hk)
        · cases hc
      · cases hc

theorem implicit_none (s : St) (hn : (sweepTel s.now s.tel).length ≠ 1) : implicit s.now s.tel = none := by
  unfold implicit
  cases h : sweepTel s.now s.tel with
  | nil => rfl
  | cons a t => cases t with
    | nil => rw [h] at hn; simp at hn
    | cons _ _ => rfl

/-- With no id and not exactly one unexpired session open, no session's
default applies: the write gets no session, the workspace's scope, or is refused. -/
theorem ambiguous_no_session_default (res : String → Bool) (s : St) (ctx : Option WS) (free : Bool)
    (hn : (sweepTel s.now s.tel).length ≠ 1) (c : String) :
    writeSession res s ctx none none free ≠ Out.sess (.key c) := by
  have hch : (chosenOf s none none).1 = none := by simp [chosenOf, implicit_none s hn]
  intro h
  cases ctx with
  | none =>
    simp only [writeSession, Out.sess.injEq, localSess, hch] at h
    cases h
  | some w =>
    have hs : serverSession res s none none = none := by simp [serverSession, hch]
    rcases server_cases res s w none none free _ h with h1 | ⟨_, h1⟩ | ⟨_, hc, _⟩
    · cases h1
    · cases h1
    · rw [hs] at hc; cases hc

/-- An expired session is never the implicit one. -/
theorem implicit_unexpired (now : Nat) (tel : List Rec) (i : String) (h : implicit now tel = some i) :
    ∃ r ∈ tel, r.id = i ∧ expired now r = false := by
  unfold implicit at h
  cases hs : sweepTel now tel with
  | nil => rw [hs] at h; simp at h
  | cons r t => cases t with
    | cons _ _ => rw [hs] at h; simp at h
    | nil =>
      rw [hs] at h; simp only [Option.some.injEq] at h
      have hm : r ∈ sweepTel now tel := by rw [hs]; simp
      have := List.mem_filter.mp hm
      exact ⟨r, this.1, h, by simpa using this.2⟩

/-- A session id this process never registered supplies no default:
through the server, unless the session was started here; without it, unless
core holds a registration for it. -/
theorem unknown_id_no_default (res : String → Bool) (s : St) (ctx : Option WS) (b : Option String)
    (free : Bool) (c : String) (hb : b = none ∨ b = some c)
    (ht : ∀ r ∈ s.tel, r.id ≠ c) (hcore : ctx = none → s.core.keyed.lookup c = none) :
    writeSession res s ctx b (some c) free ≠ Out.sess (.key c) := by
  have hch : chosenOf s b (some c) = (some c, s.tel) := by
    rcases hb with h | h <;> subst h <;> rfl
  have hnt : s.tel.any (·.id == c) = false := by
    simp only [List.any_eq_false, beq_iff_eq]; exact ht
  intro h
  cases ctx with
  | none =>
    have hk : known res s.tel s.core false c = false := by simp [known, hnt, hcore rfl]
    simp [writeSession, localSess, hch, hk] at h
  | some w =>
    have hk : known res s.tel s.core true c = false := by simp [known, hnt]
    have hs : serverSession res s b (some c) = none := by simp [serverSession, hch, hk]
    rcases server_cases res s w b (some c) free _ h with h1 | ⟨_, h1⟩ | ⟨_, hc, _⟩
    · cases h1
    · cases h1
    · rw [hs] at hc; cases hc

/-- Replayed (formal-mcp-tools-session.test.ts, "without the server, a session
id never started"): A(project:a) then B(project:b) start outside the server, so
B set the slot; plur_learn with session_id "never-started" stored at project:b. -/
def recA : Rec := ⟨"A", 0, false, none, none, some "project:a"⟩
def recB : Rec := ⟨"B", 1, false, none, none, some "project:b"⟩
def twoOpen : St :=
  { now := 2, tel := [recA, recB],
    core := { keyed := [("A", some "project:a"), ("B", some "project:b")], slot := some "project:b" } }

theorem orig_unknown_id_takes_slot :
    twoOpen.core.get (match writeSessionOrigNoCtx twoOpen none (some "never-started") with
      | .sess x => x | .refused => .noSession) = some "project:b" := rfl

theorem fixed_unknown_id_no_slot :
    writeSession (fun _ => false) twoOpen none none (some "never-started") true = Out.sess .noSession := by
  decide

/-- Non-vacuity: the lone open session's default applies, and a named session's
default applies with several open. -/
theorem lone_session_default :
    writeSession (fun _ => false) { twoOpen with tel := [recA] } none none none true = Out.sess (.key "A") := by
  decide
theorem named_session_default :
    writeSession (fun _ => false) twoOpen none none (some "A") true = Out.sess (.key "A") := by decide

/-- Through the server, a split window refuses a free write, and a start
default holds only in the workspace the session started in. -/
def recW : Rec := ⟨"W", 0, false, some "k1", some (some "project:w"), some "project:w"⟩
def oneW : St := { now := 1, tel := [recW], core := { keyed := [("W", some "project:w")], slot := none } }
theorem split_window_refused :
    writeSession (fun _ => false) oneW (some (.ws "k1" none true)) none none true = .refused := by decide
theorem start_default_holds_same_ws :
    writeSession (fun _ => false) oneW (some (.ws "k1" (some "project:w") false)) none none true
      = Out.sess (.key "W") := by decide
theorem start_default_dropped_other_ws :
    writeSession (fun _ => false) oneW (some (.ws "k2" (some "group:t") false)) none none true
      = Out.sess (.folder "group:t") := by decide

/-! ### plur_episode_to_engram

The handler hands `_writeSession(args, plur)` to core's learn, returning the
roots-disagree refusal as plur_learn does. ORIGINAL (the replayed variant):
`session: undefined`, and a thrown refusal. -/

def episodeSession (res : String → Bool) (s : St) (ctx : Option WS) (explicit : Option String)
    (scopeGiven : Bool) : Out :=
  writeSession res s ctx none explicit (!scopeGiven)

def episodeSessionOrig (_s : St) (_explicit : Option String) : Out := .sess .undef

theorem episode_never_process_slot (res : String → Bool) (s : St) (hr : Reg s) (ctx : Option WS)
    (e : Option String) (g : Bool) (x : Sess) (h : episodeSession res s ctx e g = Out.sess x) :
    s.core.get x = s.core.own x :=
  write_never_process_slot res s hr ctx none e (!g) x h

theorem episode_ambiguous_no_default (res : String → Bool) (s : St) (ctx : Option WS) (g : Bool)
    (hn : (sweepTel s.now s.tel).length ≠ 1) (c : String) :
    episodeSession res s ctx none g ≠ Out.sess (.key c) :=
  ambiguous_no_session_default res s ctx (!g) hn c

theorem orig_episode_takes_slot :
    twoOpen.core.get (match episodeSessionOrig twoOpen none with
      | .sess x => x | .refused => .noSession) = some "project:b" := rfl

/-! ## 2. The TTL sweep and Adapters' pending evictions

`_cleanExpiredSessions` moves every expired id into `_pendingScopeEvictions`;
Adapters §2 models that set (`Adapters.sweep`). Here the expired ids are the
ones the eight-hour TTL picks. -/

def expiredIds (now : Nat) (tel : List Rec) : List String := (tel.filter (expired now ·)).map (·.id)

/-- Per-session state is bounded: every session left open started within the TTL. -/
theorem open_within_ttl (now : Nat) (tel : List Rec) : ∀ r ∈ sweepTel now tel, now ≤ r.started + TTL := by
  intro r h
  have := (List.mem_filter.mp h).2
  simp [expired] at this
  exact this

/-- The plur-bearing sweep at plur_session_start clears every expired
session's registration, whether or not an earlier id-only sweep dropped its
telemetry first (Adapters `Inv`: every registration is open or pending). -/
theorem expired_registration_cleared (now : Nat) (tel : List Rec) (s : Adapters.LState)
    (hinv : Adapters.Inv s) (r : Rec) (hr : r ∈ tel) (he : expired now r = true) :
    r.id ∉ (Adapters.sweep (expiredIds now tel) true s).keyed := by
  have hid : r.id ∈ expiredIds now tel := List.mem_map.mpr ⟨r, List.mem_filter.mpr ⟨hr, he⟩, rfl⟩
  intro hk
  simp only [Adapters.sweep, ↓reduceIte, List.mem_filter, decide_eq_true_eq] at hk
  obtain ⟨hk, hnot⟩ := hk
  apply hnot
  rcases hinv _ hk with ho | hp
  · exact List.mem_append_right _ (List.mem_filter.mpr ⟨ho, by simpa using hid⟩)
  · exact List.mem_append_left _ hp

/-- Non-vacuity: a live session's registration survives the same sweep. -/
theorem live_registration_kept :
    "B" ∈ (Adapters.sweep (expiredIds (TTL + 2) [recA, { recB with started := 5 }]) true
      { open_ := ["A", "B"], keyed := ["A", "B"], pending := [] }).keyed := by decide

/-! ### Sweep before resolving

`_writeSession` and `_resolveWriteSession` (plur_inject / plur_inject_hybrid)
first run the plur-bearing sweep: expired telemetry is dropped and the expired
sessions' registrations are cleared. `sweepSt` models that sweep for the ids the
TTL picks now; registrations of ids an earlier id-only sweep expired are
Adapters' pending set, which the same call clears
(`expired_registration_cleared`). `writeSession` above is the resolution that
runs on the swept state. -/

def sweepSt (s : St) : St :=
  { s with tel := sweepTel s.now s.tel,
           core := { s.core with keyed := s.core.keyed.filter (fun p => !(expiredIds s.now s.tel).contains p.1) } }

/-- `_writeSession` as the code runs it: sweep, then resolve. -/
def writeSessionNow (res : String → Bool) (s : St) (ctx : Option WS)
    (base explicit : Option String) (free : Bool) : Out :=
  writeSession res (sweepSt s) ctx base explicit free

/-- `_resolveWriteSession` without a FolderScopeContext: sweep; `chosen` if
`_knownSession(chosen, plur, false)`, else NO_SESSION — the rule of `localSess`. -/
def injectLocal (res : String → Bool) (s : St) (explicit : Option String) : Sess :=
  localSess res (sweepSt s) none explicit

theorem lookup_filter_drop (l : List (String × Option String)) (ids : List String) (c : String)
    (hc : ids.contains c = true) : (l.filter (fun p => !ids.contains p.1)).lookup c = none := by
  induction l with
  | nil => rfl
  | cons p t ih =>
    obtain ⟨k, v⟩ := p
    cases hk : ids.contains k
    · have hne : (c == k) = false := by
        cases h : c == k
        · rfl
        · rw [beq_iff_eq.mp h, hk] at hc; cases hc
      simp only [List.filter_cons, hk, Bool.not_false, if_true, List.lookup, hne]; exact ih
    · simp only [List.filter_cons, hk, Bool.not_true, Bool.false_eq_true, if_false]; exact ih

theorem lookup_filter_keep (l : List (String × Option String)) (ids : List String) (c : String)
    (hc : ids.contains c = false) : (l.filter (fun p => !ids.contains p.1)).lookup c = l.lookup c := by
  induction l with
  | nil => rfl
  | cons p t ih =>
    obtain ⟨k, v⟩ := p
    by_cases hck : c = k
    · subst hck; simp only [List.filter_cons, hc, Bool.not_false, if_true, List.lookup, beq_self_eq_true]
    · have hne : (c == k) = false := by simp [hck]
      cases hk : ids.contains k
      · simp only [List.filter_cons, hk, Bool.not_false, if_true, List.lookup, hne]; exact ih
      · simp only [List.filter_cons, hk, Bool.not_true, Bool.false_eq_true, if_false, List.lookup, hne]
        exact ih

theorem lookup_filter_none (l : List (String × Option String)) (ids : List String) (c : String)
    (h : l.lookup c = none) : (l.filter (fun p => !ids.contains p.1)).lookup c = none := by
  cases hc : ids.contains c
  · rw [lookup_filter_keep l ids c hc]; exact h
  · exact lookup_filter_drop l ids c hc

theorem expired_mem_ids (now : Nat) (tel : List Rec) (r : Rec) (hr : r ∈ tel)
    (he : expired now r = true) : (expiredIds now tel).contains r.id = true := by
  have : r.id ∈ expiredIds now tel := List.mem_map.mpr ⟨r, List.mem_filter.mpr ⟨hr, he⟩, rfl⟩
  simpa using this

/-- Sessions stay registered across the sweep: an open session is not expired,
so its id is not among the ones whose registration is cleared. -/
theorem reg_sweep (s : St) (hr : Reg s)
    (hu : ∀ r ∈ s.tel, ∀ r' ∈ s.tel, r.id = r'.id → r = r') : Reg (sweepSt s) := by
  intro r hm
  have hm' := List.mem_filter.mp hm
  have hne : expired s.now r = false := by simpa using hm'.2
  have hc : (expiredIds s.now s.tel).contains r.id = false := by
    cases h : (expiredIds s.now s.tel).contains r.id
    · rfl
    · exfalso
      have hmem : r.id ∈ expiredIds s.now s.tel := by simpa using h
      obtain ⟨r', hr', hid⟩ := List.mem_map.mp hmem
      have hr'' := List.mem_filter.mp hr'
      have := hu r' hr''.1 r hm'.1 hid
      subst this
      simp [hne] at hr''
  show ((s.core.keyed.filter (fun p => !(expiredIds s.now s.tel).contains p.1)).lookup r.id).isSome
  rw [lookup_filter_keep _ _ _ hc]
  exact hr r hm'.1

/-- The write, run after its sweep, still never takes the process slot. -/
theorem write_now_never_process_slot (res : String → Bool) (s : St) (hr : Reg s)
    (hu : ∀ r ∈ s.tel, ∀ r' ∈ s.tel, r.id = r'.id → r = r') (ctx : Option WS)
    (b e : Option String) (free : Bool) (x : Sess)
    (h : writeSessionNow res s ctx b e free = Out.sess x) :
    (sweepSt s).core.get x = (sweepSt s).core.own x :=
  write_never_process_slot res (sweepSt s) (reg_sweep s hr hu) ctx b e free x h

theorem expired_gone (s : St) (c : String)
    (hall : ∀ r ∈ s.tel, r.id = c → expired s.now r = true) : ∀ r ∈ (sweepSt s).tel, r.id ≠ c := by
  intro r hm hid
  have hm' := List.mem_filter.mp hm
  have := hall r hm'.1 hid
  simp [this] at hm'

/-- **An explicit id stops resolving when its TTL is up.** Once every
telemetry entry for `c` is expired (and one exists), a write naming `c` gets no
default from it, through the server or not, with no later sweep needed. -/
theorem explicit_expired_no_default (res : String → Bool) (s : St) (ctx : Option WS) (free : Bool)
    (c : String) (r : Rec) (hr : r ∈ s.tel) (hid : r.id = c) (he : expired s.now r = true)
    (hall : ∀ r ∈ s.tel, r.id = c → expired s.now r = true) :
    writeSessionNow res s ctx none (some c) free ≠ Out.sess (.key c) := by
  have hcore : (sweepSt s).core.keyed.lookup c = none :=
    lookup_filter_drop _ _ _ (hid ▸ expired_mem_ids s.now s.tel r hr he)
  exact unknown_id_no_default res (sweepSt s) ctx none free c (Or.inl rfl) (expired_gone s c hall)
    (fun _ => hcore)

theorem inject_no_session_of (res : String → Bool) (s : St) (c : String)
    (ht : ∀ r ∈ (sweepSt s).tel, r.id ≠ c) (hcore : (sweepSt s).core.keyed.lookup c = none) :
    injectLocal res s (some c) = .noSession := by
  have h := unknown_id_no_default res (sweepSt s) none none true c (Or.inl rfl) ht (fun _ => hcore)
  simp only [writeSession, ne_eq, Out.sess.injEq] at h
  unfold injectLocal
  revert h
  unfold localSess
  split
  · split
    · rename_i c0 hc0 _
      simp only [chosenOf] at hc0
      cases hc0
      intro h; exact absurd rfl h
    · intro _; rfl
  · intro _; rfl

/-- **Outside the server, plur_inject treats an id this process never
registered as no session**, the rule writes use. -/
theorem inject_unknown_id_no_session (res : String → Bool) (s : St) (c : String)
    (ht : ∀ r ∈ s.tel, r.id ≠ c) (hcore : s.core.keyed.lookup c = none) :
    injectLocal res s (some c) = .noSession :=
  inject_no_session_of res s c (fun r hm => ht r (sweepTel_sub _ _ r hm)) (lookup_filter_none _ _ _ hcore)

/-- Outside the server, plur_inject naming a session past its TTL passes no session. -/
theorem inject_expired_no_session (res : String → Bool) (s : St) (c : String) (r : Rec)
    (hr : r ∈ s.tel) (hid : r.id = c) (he : expired s.now r = true)
    (hall : ∀ r ∈ s.tel, r.id = c → expired s.now r = true) :
    injectLocal res s (some c) = .noSession :=
  inject_no_session_of res s c (expired_gone s c hall)
    (lookup_filter_drop _ _ _ (hid ▸ expired_mem_ids s.now s.tel r hr he))

/-- ORIGINAL inject resolution: the explicit id, as given. -/
def injectOrig (explicit : Option String) : Sess :=
  match explicit with
  | some e => .key e
  | none => .noSession

/-- Replayed (formal-mcp-tools-session.test.ts, "without the server, plur_inject
and plur_inject_hybrid…"): the original passes "never-started", which core
answers with the slot B set. -/
theorem orig_inject_unknown_takes_slot : twoOpen.core.get (injectOrig (some "never-started")) = some "project:b" := rfl

/-- Non-vacuity: a session registered in core still counts outside the server. -/
theorem inject_registered_kept :
    injectLocal (fun _ => false) { twoOpen with tel := [] } (some "A") = .key "A" := by decide

/-- Non-vacuity and the boundary: a named session resolves at its TTL and stops
one millisecond after. The original explicit branch did not sweep. -/
def oneOld (now : Nat) : St :=
  { now := now, tel := [recA], core := { keyed := [("A", some "project:a")], slot := none } }
theorem named_at_ttl_resolves :
    writeSessionNow (fun _ => false) (oneOld TTL) none none (some "A") true = Out.sess (.key "A") := by decide
theorem named_past_ttl_none :
    writeSessionNow (fun _ => false) (oneOld (TTL + 1)) none none (some "A") true = Out.sess .noSession := by
  decide
theorem orig_named_past_ttl_resolves :
    writeSession (fun _ => false) (oneOld (TTL + 1)) none none (some "A") true = Out.sess (.key "A") := by decide

/-! ## 3. plur_session_scope: refusals and what op:"clear" restores -/

inductive Op | set | show | clear deriving DecidableEq

/-- `_resolveScopeSession`: target, ambiguous, open count, telemetry after. -/
def resolveScope (now : Nat) (tel : List Rec) (explicit : Option String) :
    Option String × Bool × Nat × List Rec :=
  match explicit with
  | some e => (some e, false, tel.length, tel)
  | none =>
    let t := sweepTel now tel
    match t with
    | [r] => (some r.id, false, 1, t)
    | _ => (none, decide (t.length > 1), t.length, t)

inductive ScopeOut
  | refused
  | shown (target : Option String)
  | set (target : Option String) (scope : String)
  | cleared (target : Option String) (restored : Option String)
deriving DecidableEq

/-- The handler after op validation. `ctx` = a FolderScopeContext is attached;
`proj` = the trusted .plur.yaml scope. -/
def sessionScope (now : Nat) (tel : List Rec) (explicit : Option String) (ctx : Bool)
    (proj : Option String) (op : Op) (scope : String) : ScopeOut :=
  let (target, ambiguous, open_, tel') := resolveScope now tel explicit
  let record := match target with
    | some t => tel'.find? (fun (r : Rec) => r.id == t)
    | none => none
  match op with
  | .show => .shown target
  | _ =>
    if ambiguous then .refused
    else match op with
      | .set => if target.isNone && open_ == 0 then .refused else .set target scope
      | _ => .cleared target (match record with
        | some r => r.dflt
        | none => if ctx then none else proj)

/-- ORIGINAL-shape clear (the variant the inventory rule excludes): no record
falls back to the project config even through the server. -/
def clearRestoredOrig (proj : Option String) : Option String := proj

/-- A scope change with several sessions open and no id is refused. -/
theorem ambiguous_change_refused (now : Nat) (tel : List Rec) (ctx : Bool) (proj : Option String)
    (op : Op) (sc : String) (hop : op ≠ .show) (hn : (sweepTel now tel).length > 1) :
    sessionScope now tel none ctx proj op sc = .refused := by
  unfold sessionScope resolveScope
  cases h : sweepTel now tel with
  | nil => rw [h] at hn; simp at hn
  | cons a t => cases t with
    | nil => rw [h] at hn; simp at hn
    | cons b u => cases op <;> simp_all

/-- An accepted set always names a session: never the process slot. -/
theorem accepted_set_targets_session (now : Nat) (tel : List Rec) (e : Option String) (ctx : Bool)
    (proj : Option String) (sc : String) (t : Option String) (sc' : String)
    (h : sessionScope now tel e ctx proj .set sc = .set t sc') : t.isSome := by
  unfold sessionScope resolveScope at h
  cases e with
  | some x => simp at h; rw [← h.1]; rfl
  | none =>
    cases hs : sweepTel now tel with
    | nil => simp [hs] at h
    | cons a u => cases u with
      | nil => simp [hs] at h; rw [← h.1]; rfl
      | cons b v => simp [hs] at h

/-- Through the server, clearing a session this server did not start restores
nothing: never another session's default, the project config or the slot. -/
theorem clear_unknown_via_server (now : Nat) (tel : List Rec) (c : String) (proj : Option String)
    (sc : String) (ht : ∀ r ∈ tel, r.id ≠ c) :
    sessionScope now tel (some c) true proj .clear sc = .cleared (some c) none := by
  have : tel.find? (fun (r : Rec) => r.id == c) = none := by
    rw [List.find?_eq_none]; intro r hr; simpa using ht r hr
  simp [sessionScope, resolveScope, this]

/-- Non-vacuity: a started session's clear restores its start default; a lone
session's set is accepted. -/
theorem clear_restores_start_default :
    sessionScope 2 [recA, recB] (some "A") true none .clear "" = .cleared (some "A") (some "project:a") := by
  decide
theorem lone_set_accepted :
    sessionScope 2 [recA] none true none .set "project:x" = .set (some "A") "project:x" := by decide
theorem orig_clear_takes_project_config :
    clearRestoredOrig (some "group:team") = some "group:team" := rfl

/-! ## 4. server.ts: tool calls run one at a time

`acquireCall` chains each call behind `callTail`; the handler body is inside
`try … finally { release() }`, so the slot is released whichever way the
call ends. -/

structure Q where
  running : Option Nat
  waiting : List Nat
  started : List Nat   -- calls that reached their handler, in order
  arrived : List Nat   -- calls received, in order

inductive Ev | arrive (c : Nat) | finish (ok : Bool)

/-- `finally { release() }`: released on success and on failure. -/
def releases (_ok : Bool) : Bool := true
/-- The broken variant: release only after a successful return. -/
def releasesOrig (ok : Bool) : Bool := ok

def step (rel : Bool → Bool) (q : Q) : Ev → Q
  | .arrive c => match q.running with
    | none => { q with running := some c, started := q.started ++ [c], arrived := q.arrived ++ [c] }
    | some _ => { q with waiting := q.waiting ++ [c], arrived := q.arrived ++ [c] }
  | .finish ok => match q.running with
    | none => q
    | some _ =>
      if rel ok then match q.waiting with
        | [] => { q with running := none }
        | h :: t => { q with running := some h, waiting := t, started := q.started ++ [h] }
      else q

def run (rel : Bool → Bool) (q : Q) (evs : List Ev) : Q := evs.foldl (step rel) q

/-- Calls reach their handler in arrival order, none is skipped, and nothing
waits while the slot is free. -/
def QInv (q : Q) : Prop := q.started ++ q.waiting = q.arrived ∧ (q.running = none → q.waiting = [])

theorem step_inv (rel : Bool → Bool) (q : Q) (ev : Ev) (h : QInv q) : QInv (step rel q ev) := by
  obtain ⟨h1, h2⟩ := h
  cases ev with
  | arrive c =>
    cases hr : q.running with
    | none => simp [step, hr, QInv, ← h1, h2 hr]
    | some _ => simp [step, hr, QInv, ← h1]
  | finish ok =>
    cases hr : q.running with
    | none => simp [step, hr]; exact ⟨h1, h2⟩
    | some _ =>
      by_cases hk : rel ok = true
      · cases hw : q.waiting with
        | nil => simp [step, hr, hk, hw, QInv]; rw [hw] at h1; simpa using h1
        | cons x t => simp [step, hr, hk, hw, QInv]; rw [hw] at h1; simpa using h1
      · simp [step, hr, hk]; exact ⟨h1, fun h => by simp_all⟩

theorem run_inv (rel : Bool → Bool) (q : Q) (evs : List Ev) (h : QInv q) : QInv (run rel q evs) := by
  induction evs generalizing q with
  | nil => exact h
  | cons e es ih => exact ih _ (step_inv rel q e h)

/-- A call that arrives while another runs does not start. -/
theorem busy_arrival_waits (rel : Bool → Bool) (q : Q) (c d : Nat) (hr : q.running = some d) :
    (step rel q (.arrive c)).running = some d ∧ (step rel q (.arrive c)).started = q.started := by
  simp [step, hr]

/-- A call that fails hands the slot to the next waiting call. -/
theorem failed_call_releases (q : Q) (d n : Nat) (t : List Nat) (hr : q.running = some d)
    (hw : q.waiting = n :: t) : (step releases q (.finish false)).running = some n := by
  simp [step, hr, hw, releases]

/-- The broken variant: after a failure the next call never starts. -/
def q0 : Q := { running := some 1, waiting := [2], started := [1], arrived := [1, 2] }
theorem orig_failure_blocks_next :
    (run releasesOrig q0 [.finish false, .arrive 3, .arrive 4]).started = [1] := by decide

/-- Non-vacuity: two calls, the first failing, both run, in order. -/
theorem both_calls_run :
    (run releases { running := none, waiting := [], started := [], arrived := [] }
      [.arrive 1, .arrive 2, .finish false, .finish true]).started = [1, 2] := by decide

end PlurSpec.McpTools
