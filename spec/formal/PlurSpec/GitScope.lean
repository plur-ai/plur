/-!
# PlurSpec.GitScope — the default scope a git repo gets from its `origin` (#1632)

Model of `gitDefaultScope` in `packages/core/src/git-origin.ts` (2026-10-18). The function
reads the repo's `origin` remote and the company servers' cached `/api/v1/me` answers
(`GitScopeSource`, from `loadGitScopeSources`) and answers a scope, `local`, `unknown` or
`not-git`. Findings and the mutation record: `spec/formal/findings/git-scope.md`.

Abstracted: scopes `S`, server endpoint identities `V` (`normalizeEndpointUrl`), GitLab hosts
`G` (a `gitlab_host` value) and parsed remotes `R` are arbitrary types. `same r g` is
`sameGitlab` (hostname equality, the port for http(s) when `gitlab_host` names one, bracketed
IPv6 in canonical form); `pathOf r` is the parsed project path and `fold` the case fold used to
compare it. Every theorem holds for every such oracle. `disc` is `discovered_at`: `none` absent,
`some none` unparsable, `some (some t)` a parsed time (ms, `Nat`; truncated subtraction gives
"older than" and "in the future" exactly). `pinned` is the entry's `pinned_scopes`, which the
code never reads here; it is in the model so the counterexample can show what reading it did.
Left out: string grammar (`isSafeHost`), git itself (`read` is an input), the TS keep-first
dedup order (only membership and "exactly one" matter).

What is proved:
- `scope_sound`: a scope outcome is a scope a fresh, host-matching source LISTED (`scopes`, not
  `pinned`) and mapped to exactly this project path, from a parsed `origin`.
- `scope_unique`: it is the only (scope, server) pair any host-matching source maps the path to.
- `no_hit_no_scope`, `no_host_local`: no mapping → no scope; no matching GitLab → `local`.
- `problem_unknown`, `stale_never_scope`: one host-matching source with no cache, an unparsable,
  too old or future `discovered_at` → `unknown`, never a scope; `problem_*` give the plan's
  boundaries (older than `maxAge`, more than `skew` in the future).
- Counterexamples (replayed by `decide`): reading `pinned` too, or skipping the freshness check,
  hands out a scope the fixed function refuses.
-/

set_option linter.unusedSimpArgs false
set_option linter.unusedSectionVars false

namespace PlurSpec.GitScope

structure Source (S V G P : Type) where
  server : V
  gitlab : Option G
  paths  : S → Option P            -- `project_paths`
  scopes : List S                  -- what the server listed
  pinned : List S                  -- `pinned_scopes` (never read by the fixed function)
  disc   : Option (Option Nat)     -- `discovered_at`

inductive Read (R : Type) where
  | notGit
  | noRemote
  | error
  | url (r : Option R)             -- `none`: the url does not parse
deriving DecidableEq

inductive Unknown where
  | gitUnreadable | scopesUnavailable | cacheStale | ambiguous
deriving DecidableEq

inductive Local where
  | noRemote | notCompanyGitlab | noScopeForProject
deriving DecidableEq

inductive Outcome (S V : Type) where
  | scope (s : S) (v : V)
  | local (r : Local)
  | unknown (r : Unknown)
  | notGit
deriving DecidableEq

structure Env (R G P : Type) where
  same   : R → G → Bool
  pathOf : R → P
  fold   : P → P
  now    : Nat
  maxAge : Nat                     -- DISCOVERY_MAX_AGE_MS
  skew   : Nat                     -- DISCOVERY_FUTURE_SKEW_MS

variable {S V G R P : Type} [DecidableEq S] [DecidableEq V] [DecidableEq P]

/-- `sameGitlab`: a source with no GitLab host matches nothing. -/
def hostOk (E : Env R G P) (r : R) (s : Source S V G P) : Bool :=
  match s.gitlab with
  | none => false
  | some g => E.same r g

/-- `cacheProblem`. -/
def problem (E : Env R G P) (s : Source S V G P) : Option Unknown :=
  match s.disc with
  | none => some .scopesUnavailable
  | some none => some .cacheStale
  | some (some t) => if E.now - t > E.maxAge ∨ t - E.now > E.skew then some .cacheStale else none

/-- The (scope, server) pairs one source maps this path to, over `cand` (the fixed code: `scopes`). -/
def hitsOver (E : Env R G P) (r : R) (s : Source S V G P) (cand : List S) : List (S × V) :=
  cand.filterMap (fun sc => match s.paths sc with
    | some q => if E.fold q = E.fold (E.pathOf r) then some (sc, s.server) else none
    | none => none)

def hits (E : Env R G P) (r : R) (s : Source S V G P) : List (S × V) := hitsOver E r s s.scopes

def dedup {α : Type} [DecidableEq α] : List α → List α
  | [] => []
  | x :: xs => if x ∈ xs then dedup xs else x :: dedup xs

def firstProblem (E : Env R G P) : List (Source S V G P) → Option Unknown
  | [] => none
  | s :: ss => match problem E s with
    | some u => some u
    | none => firstProblem E ss

def pick (l : List (S × V)) : Outcome S V :=
  match l with
  | [] => .local .noScopeForProject
  | [(sc, v)] => .scope sc v
  | _ :: _ :: _ => .unknown .ambiguous

/-- `gitDefaultScope`, step for step. `fresh = false` and `hitsF` are the mutation hooks used by
the counterexamples only; the function the code implements is `gds`. -/
def gdsWith (E : Env R G P) (fresh : Bool) (hitsF : R → Source S V G P → List (S × V))
    (rd : Read R) (srcs : List (Source S V G P)) : Outcome S V :=
  match rd with
  | .notGit => .notGit
  | .error => .unknown .gitUnreadable
  | .noRemote => .local .noRemote
  | .url none => .local .notCompanyGitlab
  | .url (some r) =>
    let m := srcs.filter (hostOk E r)
    if m.isEmpty then .local .notCompanyGitlab
    else match (if fresh then firstProblem E m else none) with
      | some u => .unknown u
      | none => pick (dedup (m.flatMap (hitsF r)))

def gds (E : Env R G P) (rd : Read R) (srcs : List (Source S V G P)) : Outcome S V :=
  gdsWith E true (hits E) rd srcs

/-! ## Lemmas -/

theorem mem_dedup {α : Type} [DecidableEq α] (x : α) (l : List α) : x ∈ dedup l ↔ x ∈ l := by
  induction l with
  | nil => simp [dedup]
  | cons y ys ih =>
    by_cases h : y ∈ ys
    · simp only [dedup, h, ite_true, ih, List.mem_cons]
      constructor
      · intro hx; exact Or.inr hx
      · rintro (rfl | hx) <;> assumption
    · simp [dedup, h, ih]

theorem mem_hitsOver (E : Env R G P) (r : R) (s : Source S V G P) (cand : List S) (sc : S) (v : V) :
    (sc, v) ∈ hitsOver E r s cand ↔
      sc ∈ cand ∧ s.server = v ∧ ∃ q, s.paths sc = some q ∧ E.fold q = E.fold (E.pathOf r) := by
  unfold hitsOver
  rw [List.mem_filterMap]
  constructor
  · rintro ⟨a, ha, h⟩
    cases hp : s.paths a with
    | none => simp [hp] at h
    | some q =>
      simp only [hp] at h
      by_cases hf : E.fold q = E.fold (E.pathOf r)
      · simp only [hf, ite_true, Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        exact ⟨ha, rfl, q, hp, hf⟩
      · simp [hf] at h
  · rintro ⟨hc, rfl, q, hp, hf⟩
    exact ⟨sc, hc, by simp [hp, hf]⟩

theorem firstProblem_none (E : Env R G P) (l : List (Source S V G P)) :
    firstProblem E l = none ↔ ∀ s ∈ l, problem E s = none := by
  induction l with
  | nil => simp [firstProblem]
  | cons s ss ih =>
    cases h : problem E s with
    | some u => simp [firstProblem, h]
    | none => simp [firstProblem, h, ih]

theorem pick_scope (l : List (S × V)) (sc : S) (v : V) :
    pick l = .scope sc v → ∀ p ∈ l, p = (sc, v) := by
  match l with
  | [] => simp [pick]
  | [(a, b)] => simp only [pick, Outcome.scope.injEq]; rintro ⟨rfl, rfl⟩ p hp; simpa using hp
  | _ :: _ :: _ => simp [pick]

theorem pick_scope_mem (l : List (S × V)) (sc : S) (v : V) : pick l = .scope sc v → (sc, v) ∈ l := by
  match l with
  | [] => simp [pick]
  | [(a, b)] => simp only [pick, Outcome.scope.injEq]; rintro ⟨rfl, rfl⟩; simp
  | _ :: _ :: _ => simp [pick]

/-- The url branch of `gds`, unfolded once. -/
theorem gds_url (E : Env R G P) (r : R) (srcs : List (Source S V G P)) :
    gds E (.url (some r)) srcs =
      if (srcs.filter (hostOk E r)).isEmpty then .local .notCompanyGitlab
      else match firstProblem E (srcs.filter (hostOk E r)) with
        | some u => .unknown u
        | none => pick (dedup ((srcs.filter (hostOk E r)).flatMap (hits E r))) := by
  simp [gds, gdsWith]

theorem hostOk_iff (E : Env R G P) (r : R) (s : Source S V G P) :
    hostOk E r s = true ↔ ∃ g, s.gitlab = some g ∧ E.same r g = true := by
  unfold hostOk
  cases s.gitlab <;> simp

/-! ## Soundness of a scope outcome -/

/-- A default scope comes only from a parsed `origin`, and only from a source whose GitLab host
matches, whose cache is fresh, that LISTED the scope, and that mapped it to exactly this
project path; the outcome names that source's server. -/
theorem scope_sound (E : Env R G P) (rd : Read R) (srcs : List (Source S V G P)) (sc : S) (v : V)
    (h : gds E rd srcs = .scope sc v) :
    ∃ r, rd = .url (some r) ∧ ∃ s ∈ srcs, (∃ g, s.gitlab = some g ∧ E.same r g = true) ∧
      problem E s = none ∧ s.server = v ∧ sc ∈ s.scopes ∧
      ∃ q, s.paths sc = some q ∧ E.fold q = E.fold (E.pathOf r) := by
  match rd with
  | .notGit => simp [gds, gdsWith] at h
  | .error => simp [gds, gdsWith] at h
  | .noRemote => simp [gds, gdsWith] at h
  | .url none => simp [gds, gdsWith] at h
  | .url (some r) =>
    refine ⟨r, rfl, ?_⟩
    rw [gds_url] at h
    split at h
    · cases h
    · split at h
      · cases h
      · rename_i hfp
        have hmem := (mem_dedup _ _).mp (pick_scope_mem _ sc v h)
        obtain ⟨s, hs, hh⟩ := List.mem_flatMap.mp hmem
        obtain ⟨hsrc, hok⟩ := List.mem_filter.mp hs
        obtain ⟨hc, hv, q, hq, hf⟩ := (mem_hitsOver E r s s.scopes sc v).mp hh
        exact ⟨s, hsrc, (hostOk_iff E r s).mp hok, (firstProblem_none E _).mp hfp s hs, hv, hc, q, hq, hf⟩

/-- The default scope is the only pair: every (scope, server) that any host-matching source maps
this path to is the one returned. Two candidates are never resolved by picking one. -/
theorem scope_unique (E : Env R G P) (r : R) (srcs : List (Source S V G P)) (sc : S) (v : V)
    (h : gds E (.url (some r)) srcs = .scope sc v) :
    ∀ s ∈ srcs, hostOk E r s = true → ∀ p ∈ hits E r s, p = (sc, v) := by
  intro s hs hok p hp
  rw [gds_url] at h
  split at h
  · cases h
  · split at h
    · cases h
    · exact pick_scope _ sc v h p ((mem_dedup _ _).mpr
        (List.mem_flatMap.mpr ⟨s, List.mem_filter.mpr ⟨hs, hok⟩, hp⟩))

/-- No mapping for this project path on any host-matching source → no scope. -/
theorem no_hit_no_scope (E : Env R G P) (r : R) (srcs : List (Source S V G P)) (sc : S) (v : V)
    (h : ∀ s ∈ srcs, hostOk E r s = true → hits E r s = []) :
    gds E (.url (some r)) srcs ≠ .scope sc v := by
  intro hg
  obtain ⟨r', hr, s, hs, hg', -, hv, hc, q, hq, hf⟩ := scope_sound E _ srcs sc v hg
  cases hr
  have hok := (hostOk_iff E r s).mpr hg'
  have : (sc, v) ∈ hits E r s := (mem_hitsOver E r s s.scopes sc v).mpr ⟨hc, hv, q, hq, hf⟩
  rw [h s hs hok] at this
  simp at this

/-- No source on this GitLab → `local / not-company-gitlab`. -/
theorem no_host_local (E : Env R G P) (r : R) (srcs : List (Source S V G P))
    (h : ∀ s ∈ srcs, hostOk E r s = false) :
    gds E (.url (some r)) srcs = .local .notCompanyGitlab := by
  have : srcs.filter (hostOk E r) = [] := List.filter_eq_nil_iff.mpr (fun s hs => by simp [h s hs])
  rw [gds_url, this]
  rfl

/-- Anything but a parsed `origin` never yields a scope. -/
theorem read_not_url_no_scope (E : Env R G P) (rd : Read R) (srcs : List (Source S V G P))
    (h : ∀ r, rd ≠ .url (some r)) (sc : S) (v : V) : gds E rd srcs ≠ .scope sc v := by
  intro hg
  obtain ⟨r, hr, -⟩ := scope_sound E rd srcs sc v hg
  exact h r hr

/-! ## Freshness -/

/-- One host-matching source whose cache cannot be used makes the answer `unknown`. -/
theorem problem_unknown (E : Env R G P) (r : R) (srcs : List (Source S V G P))
    (s : Source S V G P) (hs : s ∈ srcs) (hok : hostOk E r s = true) (hp : problem E s ≠ none) :
    ∃ u, gds E (.url (some r)) srcs = .unknown u := by
  have hne : (srcs.filter (hostOk E r)).isEmpty = false := by
    cases hm : srcs.filter (hostOk E r) with
    | nil => have := List.mem_filter.mpr ⟨hs, hok⟩; rw [hm] at this; simp at this
    | cons _ _ => rfl
  have hfp : firstProblem E (srcs.filter (hostOk E r)) ≠ none := by
    intro h0
    exact hp ((firstProblem_none E _).mp h0 s (List.mem_filter.mpr ⟨hs, hok⟩))
  rw [gds_url, hne]
  simp only [Bool.false_eq_true, ite_false]
  cases h : firstProblem E (srcs.filter (hostOk E r)) with
  | none => exact absurd h hfp
  | some u => exact ⟨u, rfl⟩

theorem stale_never_scope (E : Env R G P) (r : R) (srcs : List (Source S V G P))
    (s : Source S V G P) (hs : s ∈ srcs) (hok : hostOk E r s = true) (hp : problem E s ≠ none)
    (sc : S) (v : V) : gds E (.url (some r)) srcs ≠ .scope sc v := by
  obtain ⟨u, hu⟩ := problem_unknown E r srcs s hs hok hp
  rw [hu]; intro h; cases h

theorem problem_absent (E : Env R G P) (s : Source S V G P) (h : s.disc = none) :
    problem E s = some .scopesUnavailable := by simp [problem, h]

theorem problem_unparsable (E : Env R G P) (s : Source S V G P) (h : s.disc = some none) :
    problem E s = some .cacheStale := by simp [problem, h]

theorem problem_too_old (E : Env R G P) (s : Source S V G P) (t : Nat) (h : s.disc = some (some t))
    (hold : t + E.maxAge < E.now) : problem E s = some .cacheStale := by
  simp only [problem, h]
  split
  · rfl
  · rename_i hn; exact absurd (Or.inl (by omega)) hn

theorem problem_future (E : Env R G P) (s : Source S V G P) (t : Nat) (h : s.disc = some (some t))
    (hfut : E.now + E.skew < t) : problem E s = some .cacheStale := by
  simp only [problem, h]
  split
  · rfl
  · rename_i hn; exact absurd (Or.inr (by omega)) hn

theorem problem_fresh (E : Env R G P) (s : Source S V G P) (t : Nat) (h : s.disc = some (some t))
    (h1 : E.now ≤ t + E.maxAge) (h2 : t ≤ E.now + E.skew) : problem E s = none := by
  simp only [problem, h]
  split
  · rename_i hy; exfalso; omega
  · rfl

/-! ## Counterexamples and non-vacuity (concrete, `decide`) -/

/-- Exact host and path equality on `Nat`; now = 100 days, maxAge 7, skew 1 (units: days). -/
def E0 : Env Nat Nat Nat := ⟨fun r g => r == g, id, id, 100, 7, 1⟩

/-- Server 1 on GitLab 5 listed scope 7 for path 5, discovered on day 99. -/
def good : Source Nat Nat Nat Nat :=
  ⟨1, some 5, fun sc => if sc = 7 then some 5 else none, [7], [], some (some 99)⟩

/-- Non-vacuity: the good case is a scope. -/
theorem good_scope : gds E0 (.url (some 5)) [good] = .scope 7 1 := by decide

/-- Non-vacuity: two servers mapping the same path are ambiguous, not a pick. -/
theorem two_servers_ambiguous :
    gds E0 (.url (some 5)) [good, { good with server := 2 }] = .unknown .ambiguous := by decide

/-- REPLAYED counterexample (pinned scopes): the server listed nothing; scope 7 is only pinned
and still in the cached mapping. Reading `scopes ++ pinned` hands it out as the default; the
fixed function answers `local / no-scope-for-project`. -/
def pinnedOnly : Source Nat Nat Nat Nat := { good with scopes := [], pinned := [7] }

theorem pinned_counterexample :
    gdsWith E0 true (fun r s => hitsOver E0 r s (s.scopes ++ s.pinned)) (.url (some 5)) [pinnedOnly]
      = .scope 7 1 ∧
    gds E0 (.url (some 5)) [pinnedOnly] = .local .noScopeForProject := by decide

/-- REPLAYED counterexample (stale cache): discovered on day 60, 40 days before now. Without the
freshness check the old mapping is trusted; the fixed function answers `unknown / cache-stale`. -/
def oldCache : Source Nat Nat Nat Nat := { good with disc := some (some 60) }

theorem stale_counterexample :
    gdsWith E0 false (hits E0) (.url (some 5)) [oldCache] = .scope 7 1 ∧
    gds E0 (.url (some 5)) [oldCache] = .unknown .cacheStale := by decide

/-- REPLAYED counterexample (future `discovered_at`, clock skew or hand edit): day 150. -/
theorem future_counterexample :
    gdsWith E0 false (hits E0) (.url (some 5)) [{ good with disc := some (some 150) }] = .scope 7 1 ∧
    gds E0 (.url (some 5)) [{ good with disc := some (some 150) }] = .unknown .cacheStale := by decide

end PlurSpec.GitScope
