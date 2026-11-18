/-!
# ScopeInject — injection selection, scope-family predicates, learner, decay

Models of `packages/core/src/{inject,scope-util,scope-target,scope-routing,
learner,decay,memory-block,telemetry-miss-signal}.ts`. Each section follows the
code branch for branch at the level of the property it states; payloads that
the property does not depend on (keyword scoring, token costs, string content)
are parameters, so every theorem holds for every oracle.

Updated for #1633 (owner decision O5, 2026-10-18): decision E4 is amended from containment
to exact match. §3 `isLocalOnly` takes the resolver's `claimed` oracle (RoutingDiscovery §5
proves it is exact match); the 2026-09-26 rule is kept as `isLocalOnlyE4` for the
counterexample `old_e4_containment`.
-/

namespace PlurSpec.ScopeInject

/-! ## 1. Injection visibility (inject.ts `selectAndSpread`)

`scoreEngram` returns 0 both when the engram is excluded by the scope filter
and when it has no keyword hits. Three paths revive a 0: the pinned exemption
(`raw > 0 || pinned`), the semantic-only embedding boost
(`raw === 0 && embBoost > 0.5`), and spreading activation (targets looked up in
a map of every active engram). -/

/-- An engram as selection sees it. `hits` abstracts keyword scoring (0 = none),
`embHigh` is `embBoost > 0.5`, `assoc` the association targets. -/
structure Eng where
  id      : Nat
  scope   : String
  hits    : Nat
  pinned  : Bool
  embHigh : Bool
  assoc   : List Nat
  deriving DecidableEq, Repr

/-- `isInjectVisible` / the scope gate of `scoreEngram`. `vis` is
`makeVisibilityPredicate(filter, grants)` — an arbitrary oracle here, so the
theorems hold for every visibility policy. -/
def injVisible (vis : String → Bool) : Option String → String → Bool
  | none, _ => true
  | some f, s => if f = "global" then s = "global" else vis s

/-- `scoreEngram`'s raw score: 0 if excluded, else keyword hits (pinned with no
hits gets a synthetic positive score). -/
def raw (vis : String → Bool) (flt : Option String) (e : Eng) : Nat :=
  if injVisible vis flt e.scope then
    (if e.hits = 0 then (if e.pinned then 1 else 0) else e.hits)
  else 0

/-- Pre-fix pool membership (inject.ts:660-688 at 6200dbf6). -/
def admitOld (vis : String → Bool) (flt : Option String) (e : Eng) : Bool :=
  let r := raw vis flt e
  (r > 0 || e.embHigh) || e.pinned

/-- Post-fix: the visibility gate runs before scoring. -/
def admitNew (vis : String → Bool) (flt : Option String) (e : Eng) : Bool :=
  injVisible vis flt e.scope && ((raw vis flt e > 0 || e.embHigh) || e.pinned)

/-- The spreading map: pre-fix every active engram; post-fix only visible ones. -/
def mapOld (_vis : String → Bool) (_flt : Option String) (es : List Eng) : List Eng := es
def mapNew (vis : String → Bool) (flt : Option String) (es : List Eng) : List Eng :=
  es.filter (fun e => injVisible vis flt e.scope)

/-- Spreading activation: targets of the selected engrams found in the map
(budget and strength gates only remove candidates, so they are dropped from the
model: the property is about what CAN be delivered). -/
def spread (m : List Eng) (sel : List Eng) : List Eng :=
  m.filter (fun t => sel.any (fun d => d.assoc.contains t.id))

/-- Delivered = a subset of the admitted pool (whatever `fillTokenBudget`
picks) plus its spread. -/
def deliveredNew (vis : String → Bool) (flt : Option String) (es sel : List Eng) : List Eng :=
  sel ++ spread (mapNew vis flt es) sel

def deliveredOld (vis : String → Bool) (flt : Option String) (es sel : List Eng) : List Eng :=
  sel ++ spread (mapOld vis flt es) sel

/-- **Invariant (fixed code):** every delivered engram is visible, for every
visibility oracle, every scope filter, and every subset the budget filler picks. -/
theorem selected_visible (vis : String → Bool) (flt : Option String)
    (es sel : List Eng) (hsel : ∀ e ∈ sel, e ∈ es ∧ admitNew vis flt e = true) :
    ∀ e ∈ deliveredNew vis flt es sel, injVisible vis flt e.scope = true := by
  intro e he
  simp only [deliveredNew, spread, mapNew, List.mem_append, List.mem_filter] at he
  rcases he with h | ⟨⟨_, hv⟩, _⟩
  · have := (hsel e h).2
    simp only [admitNew, Bool.and_eq_true] at this
    exact this.1
  · exact hv

/-- Explicit `scope: 'global'` inject delivers only `global` engrams
(INJECT_GLOBAL_IS_TARGETED), pinned or not. -/
theorem global_is_targeted (vis : String → Bool) (es sel : List Eng)
    (hsel : ∀ e ∈ sel, e ∈ es ∧ admitNew vis (some "global") e = true) :
    ∀ e ∈ deliveredNew vis (some "global") es sel, e.scope = "global" := by
  intro e he
  have := selected_visible vis (some "global") es sel hsel e he
  simpa [injVisible] using this

/-- The model is not vacuous: a visible pinned engram with no hits, a visible
semantic-only engram and a visible association target are all delivered. -/
theorem good_case_reachable :
    let vis : String → Bool := fun s => s = "project:a"
    let src : Eng := ⟨1, "project:a", 2, false, false, [3]⟩
    let pin : Eng := ⟨2, "project:a", 0, true, false, []⟩
    let tgt : Eng := ⟨3, "project:a", 0, false, false, []⟩
    let emb : Eng := ⟨4, "project:a", 0, false, true, []⟩
    admitNew vis (some "project:a") pin = true ∧ admitNew vis (some "project:a") emb = true ∧
    tgt ∈ deliveredNew vis (some "project:a") [src, pin, tgt, emb] [src, pin, emb] := by
  decide

/-- Counterexamples against the PRE-FIX code, replayed in
`test/formal-scopeinject-visibility.test.ts` (and scratchpad replay1.ts):
(a) pinned in an ungranted group scope under `project:a`; (a2) pinned `user:x`
under `global`; (b) semantic-only boost; (c) spreading. -/
theorem old_pinned_leaks :
    let vis : String → Bool := fun s => s = "project:a"
    let pin : Eng := ⟨2, "group:acme/other", 0, true, false, []⟩
    admitOld vis (some "project:a") pin = true ∧ injVisible vis (some "project:a") pin.scope = false := by
  decide

theorem old_global_not_targeted :
    let pin : Eng := ⟨3, "user:x", 0, true, false, []⟩
    admitOld (fun _ => true) (some "global") pin = true ∧ pin.scope ≠ "global" := by
  decide

theorem old_embedding_leaks :
    let vis : String → Bool := fun s => s = "project:a"
    let b : Eng := ⟨5, "group:acme/other", 0, false, true, []⟩
    admitOld vis (some "project:a") b = true ∧ injVisible vis (some "project:a") b.scope = false := by
  decide

theorem old_spread_leaks :
    let vis : String → Bool := fun s => s = "project:a"
    let src : Eng := ⟨7, "project:a", 2, false, false, [6]⟩
    let hid : Eng := ⟨6, "group:acme/other", 0, false, false, []⟩
    hid ∈ deliveredOld vis (some "project:a") [src, hid] [src] ∧
    injVisible vis (some "project:a") hid.scope = false := by
  decide

/-! ## 2. Pinned origin priority (inject.ts `fillTokenBudget` pinned loop)

`rank` is `pinnedOriginRank` (0 primary, 1 stores/remote, 2 pack). The loop
admits greedily, but once a pin is skipped for budget no pin of a LOWER origin
(higher rank) is admitted after it. -/

structure Pin where
  id   : Nat
  rank : Nat
  cost : Nat
  deriving DecidableEq, Repr

structure PSt where
  used    : Nat          -- tokens used in THIS pass
  ledger  : Nat          -- shared pinned spend (pinnedLedger.spent)
  skipped : Option Nat   -- skippedRank
  adm     : List Pin
  om      : List Pin
  deriving Repr

def minOpt : Option Nat → Nat → Nat
  | none, r => r
  | some s, r => min s r

/-- `skippedRank !== null && rank > skippedRank`. -/
def blockedBy : Option Nat → Nat → Bool
  | some s, r => decide (r > s)
  | none, _ => false

/-- One iteration of the pinned loop (inject.ts `fillTokenBudget`). -/
def pstep (total sub : Nat) (st : PSt) (p : Pin) : PSt :=
  if blockedBy st.skipped p.rank then { st with om := p :: st.om }
  else if st.used + p.cost > total then
    { st with om := p :: st.om, skipped := some (minOpt st.skipped p.rank) }
  else if st.ledger + p.cost > sub then
    { st with om := p :: st.om, skipped := some (minOpt st.skipped p.rank) }
  else
    { st with adm := p :: st.adm, used := st.used + p.cost, ledger := st.ledger + p.cost }

def prun (total sub : Nat) (st : PSt) : List Pin → PSt
  | [] => st
  | p :: ps => prun total sub (pstep total sub st p) ps

/-- Priority invariant of a state. -/
def PInv (st : PSt) : Prop :=
  (∀ a ∈ st.adm, ∀ o ∈ st.om, a.rank ≤ o.rank) ∧
  (∀ o ∈ st.om, ∃ s, st.skipped = some s ∧ s ≤ o.rank) ∧
  (∀ s, st.skipped = some s → ∀ a ∈ st.adm, a.rank ≤ s)

theorem pstep_inv (total sub : Nat) (st : PSt) (p : Pin) (h : PInv st)
    (hle : ∀ a ∈ st.adm, a.rank ≤ p.rank) : PInv (pstep total sub st p) := by
  obtain ⟨h1, h2, h3⟩ := h
  -- helper for the "skip for budget" branches
  have skipCase : PInv { st with om := p :: st.om, skipped := some (minOpt st.skipped p.rank) } := by
    refine ⟨?_, ?_, ?_⟩
    · intro a ha o ho
      simp only [List.mem_cons] at ho
      rcases ho with rfl | ho
      · exact hle a ha
      · exact h1 a ha o ho
    · intro o ho
      refine ⟨_, rfl, ?_⟩
      simp only [List.mem_cons] at ho
      rcases ho with rfl | ho
      · cases hs : st.skipped <;> simp [minOpt] <;> omega
      · obtain ⟨s, hs, hso⟩ := h2 o ho
        rw [hs]; simp [minOpt]; omega
    · intro s hs a ha
      simp only [Option.some.injEq] at hs
      subst hs
      cases hsk : st.skipped with
      | none => simpa [minOpt] using hle a ha
      | some s0 =>
        have := h3 s0 hsk a ha
        have := hle a ha
        simp [minOpt]; omega
  unfold pstep
  split
  · -- blocked: rank > s
    rename_i hb
    refine ⟨?_, ?_, h3⟩
    · intro a ha o ho
      simp only [List.mem_cons] at ho
      rcases ho with rfl | ho
      · exact hle a ha
      · exact h1 a ha o ho
    · intro o ho
      simp only [List.mem_cons] at ho
      rcases ho with rfl | ho
      · cases hs : st.skipped with
        | none => simp [hs, blockedBy] at hb
        | some s => simp [hs, blockedBy] at hb; exact ⟨s, rfl, by omega⟩
      · exact h2 o ho
  · split
    · exact skipCase
    · split
      · exact skipCase
      · rename_i hb _ _
        -- admitted: p.rank ≤ skipped (not blocked)
        have hps : ∀ s, st.skipped = some s → p.rank ≤ s := by
          intro s hs; simp [hs, blockedBy] at hb; omega
        refine ⟨?_, ?_, ?_⟩
        · intro a ha o ho
          simp only [List.mem_cons] at ha
          rcases ha with rfl | ha
          · obtain ⟨s, hs, hso⟩ := h2 o ho
            have := hps s hs; omega
          · exact h1 a ha o ho
        · exact h2
        · intro s hs a ha
          simp only [List.mem_cons] at ha
          rcases ha with rfl | ha
          · exact hps s hs
          · exact h3 s hs a ha

theorem prun_inv (total sub : Nat) (ps : List Pin) :
    ∀ st, PInv st → (∀ a ∈ st.adm, ∀ x ∈ ps, a.rank ≤ x.rank) →
      ps.Pairwise (fun a b => a.rank ≤ b.rank) → PInv (prun total sub st ps) := by
  induction ps with
  | nil => intro st h _ _; exact h
  | cons p ps ih =>
    intro st h hord hpw
    rw [List.pairwise_cons] at hpw
    apply ih
    · exact pstep_inv total sub st p h (fun a ha => hord a ha p (List.mem_cons_self ..))
    · intro a ha x hx
      unfold pstep at ha
      split at ha
      · exact hord a ha x (List.mem_cons_of_mem _ hx)
      · split at ha
        · exact hord a ha x (List.mem_cons_of_mem _ hx)
        · split at ha
          · exact hord a ha x (List.mem_cons_of_mem _ hx)
          · simp only [List.mem_cons] at ha
            rcases ha with rfl | ha
            · exact hpw.1 x hx
            · exact hord a ha x (List.mem_cons_of_mem _ hx)
    · exact hpw.2

def pinit : PSt := ⟨0, 0, none, [], []⟩

/-- **Fixed code:** one pinned pass over ALL pins, sorted by origin. Every
admitted pin outranks (or ties) every omitted pin, whatever the costs and
budgets. -/
theorem pinned_priority (total sub : Nat) (ps : List Pin)
    (hs : ps.Pairwise (fun a b => a.rank ≤ b.rank)) :
    let r := prun total sub pinit ps
    ∀ a ∈ r.adm, ∀ o ∈ r.om, a.rank ≤ o.rank :=
  (prun_inv total sub ps pinit ⟨by simp [pinit], by simp [pinit], by simp [pinit]⟩
    (by simp [pinit]) hs).1

/-- Pre-fix selection: constraints floor pass, directives pass, slack pass, each
with a fresh `skippedRank` but one shared ledger (inject.ts:764-785 at 6200dbf6).
`cs`/`ds` are the pinned constraint/directive candidates. -/
def oldThreePass (maxT : Nat) (cs ds : List Pin) : List Pin × List Pin :=
  let sub := maxT / 2
  let floor := maxT * 4 / 10
  let r1 := prun floor sub pinit cs
  let r2 := prun (maxT - r1.used) sub ⟨0, r1.ledger, none, [], []⟩ ds
  let slack := maxT - r1.used - r2.used
  let rest := cs.filter (fun p => !(r1.adm.contains p))
  let r3 := prun slack sub ⟨0, r2.ledger, none, [], []⟩ rest
  (r1.adm ++ r2.adm ++ r3.adm, r3.om)

/-- The replayed counterexample (maxTokens 1000, primary pinned constraint of
450, pack pinned directive of 300): the pack pin is admitted, the primary one
is not. -/
theorem old_pack_pin_displaces_primary :
    let P : Pin := ⟨101, 0, 450⟩
    let Q : Pin := ⟨102, 2, 300⟩
    let r := oldThreePass 1000 [P] [Q]
    Q ∈ r.1 ∧ P ∉ r.1 := by
  decide

/-- Fixed code on the same input: P admitted, Q omitted. -/
theorem new_primary_wins :
    let P : Pin := ⟨101, 0, 450⟩
    let Q : Pin := ⟨102, 2, 300⟩
    let r := prun 1000 500 pinit [P, Q]
    P ∈ r.adm ∧ Q ∈ r.om := by
  decide

/-- Non-vacuity: when both fit, both are admitted. -/
theorem pinned_both_fit :
    let r := prun 1000 500 pinit [⟨103, 0, 300⟩, ⟨104, 2, 150⟩]
    r.om = [] ∧ r.adm.length = 2 := by
  decide

/-! ## 3. Scope-family predicates (scope-util.ts, scope-target.ts, scope-routing.ts)

One classification, each consumer as its own Boolean function over scope
strings (as `List Char`, so the kernel can evaluate them). The question each
consumer answers is "is this scope local / does it leave the machine". -/

abbrev Sc := List Char

def lower (s : Sc) : Sc := s.map Char.toLower

/-- `isSharedScope` (scope-util.ts): case-folded prefix test; `public` exact or delimited. -/
def isShared (s : Sc) : Bool :=
  let l := lower s
  ["group:".toList, "project:".toList, "space:".toList, "team:".toList, "org:".toList].any
      (fun p => p.isPrefixOf l)
    || l == "public".toList || "public:".toList.isPrefixOf l || "public/".toList.isPrefixOf l

def isPersonal (s : Sc) : Bool := !isShared s

/-- `isScopeWithin` (scope-util.ts): equal, or a descendant past a real `:`/`/`. -/
def within (s q : Sc) : Bool :=
  s == q || (q ++ [':']).isPrefixOf s || (q ++ ['/']).isPrefixOf s

/-- The 2026-09-26 reading of decision E4: a configured URL store's scope covers
`s` (equal or segment-contained, compared case-folded). `urls` = the scopes of the
`stores:` entries that carry a `url`. Superseded by owner decision O5 (2026-10-18,
#1633); kept for the counterexample `old_e4_containment`. -/
def covered (urls : List Sc) (s : Sc) : Bool := urls.any (fun u => within (lower s) (lower u))

/-- `isLocalOnlyScope(scope, stores)` (scope-target.ts) after decisions E5 (fold
case like `isShared`) and E4 as amended by owner decision O5 (2026-10-18, #1633:
"Project scopes — Exact match"): `project:*` is local only when the one resolver
keeps a write to it local. `claimed s` is `resolveScopeTarget(s, stores).kind !==
'local'` — an oracle here; RoutingDiscovery §5 proves what it means (a url entry
with exactly this scope, or an org a company server withholds), so this is exact
match, not containment. `fun _ => false` is the config-free call (no stores). -/
def isLocalOnly (claimed : Sc → Bool) (s : Sc) : Bool :=
  let l := lower s
  l == "primary".toList || l == "local".toList || l == "global".toList
    || ("project:".toList.isPrefixOf l && !claimed s)

/-- The 2026-09-26 E4 predicate (containment), for the counterexample. -/
def isLocalOnlyE4 (urls : List Sc) (s : Sc) : Bool :=
  let l := lower s
  l == "primary".toList || l == "local".toList || l == "global".toList
    || ("project:".toList.isPrefixOf l && !covered urls s)

/-- The pre-decision predicate (case-sensitive, config-free) — kept for the
counterexamples the decisions close. -/
def isLocalOnlyOld (s : Sc) : Bool :=
  s == "primary".toList || s == "local".toList || s == "global".toList
    || "project:".toList.isPrefixOf s

/-- `_offendingHitsForScope` guard (plur/scope-guards.ts): scan when shared OR remote-backed.
`remote` is `_isRemoteBackedScope` — config, so an oracle. -/
def leakGuard (remote : Sc → Bool) (s : Sc) : Bool := isShared s || remote s

/-- `decideAutoRoute` (scope-routing.ts, allowSharedScope=false) with decision E1
"me-only" (`refuseScope`): a candidate may be routed to iff it is not shared and,
when a URL store backs it, it is the user's own `/me` namespace (`own`, false when
the identity is unknown). -/
def autoRouteAllowed (remote own : Sc → Bool) (s : Sc) : Bool :=
  !isShared s && (!remote s || own s)

/-- Pre-E1: shared-only refusal. -/
def autoRouteAllowedOld (s : Sc) : Bool := !isShared s

/-- Provenance `withheld` (provenance.ts): private visibility or scope === 'local'. -/
def withheld (priv : Bool) (s : Sc) : Bool := priv || s == "local".toList

/-- Ground truth for "leaves this machine": shared, or held by a url store. -/
def leaves (remote : Sc → Bool) (s : Sc) : Bool := isShared s || remote s

/-- **Consistent:** the leak guard scans exactly what leaves the machine, so an
auto-routed write into a remote-backed personal scope is still scanned. -/
theorem leakGuard_eq_leaves (remote : Sc → Bool) (s : Sc) :
    leakGuard remote s = leaves remote s := rfl

theorem autoRoute_leaving_is_scanned (remote own : Sc → Bool) (s : Sc)
    (_h : autoRouteAllowed remote own s = true) (hl : leaves remote s = true) :
    leakGuard remote s = true := hl

/-- **Decision E1:** anything auto-route admits that leaves the machine is the
user's own `/me` namespace — for every oracle. -/
theorem autoRoute_leaving_is_own (remote own : Sc → Bool) (s : Sc)
    (h : autoRouteAllowed remote own s = true) (hl : leaves remote s = true) : own s = true := by
  unfold autoRouteAllowed at h
  unfold leaves at hl
  cases hs : isShared s <;> cases hr : remote s <;> cases ho : own s <;> simp_all

/-- **Decision E4 (amended, O5)/E5:** a local-only `project:*` scope is never one
the resolver sends anywhere — so a `project:*` a URL store claims exactly is never
refused as "local" and reaches its store. -/
theorem localOnly_project_unclaimed (claimed : Sc → Bool) (s : Sc)
    (hp : "project:".toList.isPrefixOf (lower s) = true) (h : isLocalOnly claimed s = true) :
    claimed s = false := by
  unfold isLocalOnly at h
  cases hc : claimed s
  · rfl
  · simp only [hc, hp, Bool.not_true, Bool.and_false, Bool.or_false, Bool.or_eq_true, beq_iff_eq] at h
    rcases h with (h | h) | h <;> rw [h] at hp <;> exact absurd hp (by decide)

/-- **Consistent:** the three named local targets are personal-family. -/
theorem local_family_personal :
    isPersonal "primary".toList = true ∧ isPersonal "local".toList = true ∧
    isPersonal "global".toList = true := by decide

/-- `project:*` that no store claims is local-only AND shared-family
(unchanged by E4: a local project scope is a team namespace kept on this disk). -/
theorem project_localOnly_and_shared :
    isLocalOnly (fun _ => false) "project:plur".toList = true ∧
    isShared "project:plur".toList = true := by decide

/-- **Decision E4, amended by O5 (exact match):** a URL store at `project:plur`
claims exactly `project:plur` (the resolver's exact rule), so that scope is
non-local, and its segment-descendant and its string-prefix sibling stay local —
as write routing keeps them. -/
theorem project_exact_not_localOnly :
    let claimed : Sc → Bool := fun s => s == "project:plur".toList
    isLocalOnly claimed "project:plur".toList = false ∧
    isLocalOnly claimed "project:plur/sub".toList = true ∧
    isLocalOnly claimed "project:plurx".toList = true ∧
    isLocalOnly claimed "global".toList = true := by decide

/-- **Counterexample the amendment closes (O5, #1633):** under the 2026-09-26
containment rule a URL store at `project:plur` made `project:plur/sub` non-local,
so forget/feedback dialled that server, while write routing (exact match) keeps
`project:plur/sub` on this machine — the two disagreed. -/
theorem old_e4_containment :
    isLocalOnlyE4 ["project:plur".toList] "project:plur/sub".toList = false ∧
    isLocalOnly (fun s => s == "project:plur".toList) "project:plur/sub".toList = true := by decide

/-- **Decision E5:** case no longer drifts — both spellings agree on both predicates.
Pre-decision counterexample: `isLocalOnlyOld`. -/
theorem case_folded :
    isShared "Project:plur".toList = isShared "project:plur".toList ∧
    isLocalOnly (fun _ => false) "Project:plur".toList = isLocalOnly (fun _ => false) "project:plur".toList ∧
    isLocalOnly (fun _ => false) "GLOBAL".toList = true := by decide

theorem old_case_drift :
    isLocalOnlyOld "Project:plur".toList = false ∧ isLocalOnlyOld "project:plur".toList = true ∧
    isLocalOnlyOld "GLOBAL".toList = false := by decide

/-- **Decision E1:** a url-backed personal scope is refused unless `/me` names it
the user's own; non-vacuity: the own one is admitted and does leave. Pre-E1
counterexample: `autoRouteAllowedOld` admitted the foreign one. -/
theorem autoRoute_me_only :
    let remote : Sc → Bool := fun s => s == "user:alice".toList || s == "user:me".toList
    let own : Sc → Bool := fun s => s == "user:me".toList
    autoRouteAllowed remote own "user:alice".toList = false ∧
    autoRouteAllowed remote own "user:me".toList = true ∧ leaves remote "user:me".toList = true ∧
    autoRouteAllowed remote own "user:bob-local".toList = true ∧
    autoRouteAllowedOld "user:alice".toList = true := by
  decide

/-- **Drift:** provenance does not withhold `global` or `user:*`, although
`isLocalOnly` calls `global` local and neither need leave the machine. -/
theorem provenance_global_not_withheld :
    withheld false "global".toList = false ∧ isLocalOnly (fun _ => false) "global".toList = true ∧
    leaves (fun _ => false) "global".toList = false := by decide

/-! ## 4. learner.ts always/never extraction polarity

Sentences as token lists. `whenever` is a word that CONTAINS the substring
`never`; the pre-fix regex matched it. Polarity = parity of negators (`neg`,
`never`) in a statement. -/

inductive Tok | neg | always | never | whenever | word
  deriving DecidableEq, Repr

def isNegator : Tok → Bool
  | .neg => true
  | .never => true
  | _ => false

def pol (s : List Tok) : Nat := (s.countP isNegator) % 2

/-- Pre-fix: unanchored `((?:always|never)\s+.+)` — the first token whose text
contains `always`/`never` (incl. `whenever`, whose capture starts at `never`). -/
def extractOld : List Tok → Option (List Tok)
  | [] => none
  | .always :: r => some (.always :: r)
  | .never :: r => some (.never :: r)
  | .whenever :: r => some (.never :: r)
  | _ :: r => extractOld r

/-- Post-fix: `\b(always|never)\b`, with a directly preceding negation captured. -/
def extractNew : List Tok → Option (List Tok)
  | [] => none
  | .neg :: .always :: r => some (.neg :: .always :: r)
  | .neg :: .never :: r => some (.neg :: .never :: r)
  | .always :: r => some (.always :: r)
  | .never :: r => some (.never :: r)
  | _ :: r => extractNew r

/-- Filler tokens: no negator, no directive word. -/
def filler (t : Tok) : Prop := t = .word ∨ t = .whenever

theorem extractNew_filler (pre s : List Tok) (hp : ∀ t ∈ pre, filler t)
    (hs : ∃ d r, s = d :: r ∧ (d = .always ∨ d = .never ∨ d = .neg)) :
    extractNew (pre ++ s) = extractNew s := by
  induction pre with
  | nil => rfl
  | cons t pre ih =>
    have ht := hp t (List.mem_cons_self ..)
    have ih' := ih (fun x hx => hp x (List.mem_cons_of_mem _ hx))
    obtain ⟨d, r, rfl, hd⟩ := hs
    rcases ht with rfl | rfl
    · cases pre with
      | nil => rcases hd with rfl | rfl | rfl <;> rfl
      | cons u pre' => simpa [extractNew] using ih'
    · cases pre with
      | nil => rcases hd with rfl | rfl | rfl <;> rfl
      | cons u pre' => simpa [extractNew] using ih'

/-- **Fixed code:** for any sentence shaped `filler* [not] (always|never) filler*`,
the extracted statement has the sentence's polarity. -/
theorem extract_preserves_polarity (pre rest : List Tok) (n : Bool) (d : Tok)
    (hp : ∀ t ∈ pre, filler t) (hr : ∀ t ∈ rest, filler t) (hd : d = .always ∨ d = .never) :
    let s := pre ++ ((if n then [Tok.neg] else []) ++ d :: rest)
    ∃ x, extractNew s = some x ∧ pol x = pol s := by
  intro s
  have hrest : rest.countP isNegator = 0 := by
    rw [List.countP_eq_zero]; intro t ht; rcases hr t ht with rfl | rfl <;> simp [isNegator]
  have hpre : pre.countP isNegator = 0 := by
    rw [List.countP_eq_zero]; intro t ht; rcases hp t ht with rfl | rfl <;> simp [isNegator]
  have hs : extractNew s = extractNew ((if n then [Tok.neg] else []) ++ d :: rest) := by
    apply extractNew_filler pre _ hp
    cases n
    · exact ⟨d, rest, rfl, by rcases hd with h | h <;> simp [h]⟩
    · exact ⟨.neg, d :: rest, rfl, by simp⟩
  refine ⟨(if n then [Tok.neg] else []) ++ d :: rest, ?_, ?_⟩
  · rw [hs]; cases n <;> rcases hd with rfl | rfl <;> rfl
  · simp only [s, pol, List.countP_append, hpre]; simp

/-- Replayed counterexamples on the pre-fix extractor. -/
theorem old_drops_negation :
    -- "Don't always rerun the full suite" → "always rerun the full suite"
    extractOld [.neg, .always, .word, .word] = some [.always, .word, .word] ∧
    pol [.neg, .always, .word, .word] ≠ pol [.always, .word, .word] := by decide

theorem old_whenever_is_never :
    -- "Whenever you deploy, run the smoke tests" → "never you deploy, run …"
    extractOld [.whenever, .word, .word] = some [.never, .word, .word] ∧
    pol [.whenever, .word, .word] ≠ pol [.never, .word, .word] := by decide

theorem new_whenever_not_matched : extractNew [.whenever, .word, .word] = none := by decide

/-! ### 4b. Which words the code tokenises as `neg` (audit of #1228, finding 3)

`extract_preserves_polarity` holds for the `neg` TOKEN; it is sound for the code
only if the regex's negation alternation turns every negation word into `neg`.
It did not: only `don't` / `do not` / `not` were, so `cannot`, the contracted
`\w+n't` forms (doesn't, can't, won't, shouldn't, isn't …) and their
apostrophe-less spellings were `word` fillers, and the theorem's premise
`filler* [neg] (always|never)` then matched with the negation in the FILLER —
the extracted statement dropped it. -/

inductive NegForm | dont | doNot | not | cannot | contracted | fused
  deriving DecidableEq, Repr

/-- Before: `(?:don['’]?t|do not|not)`. -/
def tokOld : NegForm → Tok
  | .dont | .doNot | .not => .neg
  | _ => .word

/-- After: `(?:\w+n['’]t|(?:do|does|…)nt|cannot|do not|not)` — every form. -/
def tokNew : NegForm → Tok := fun _ => .neg

/-- Every negation form before always/never keeps the sentence's polarity. -/
theorem every_negform_keeps_polarity (f : NegForm) (d : Tok) (rest : List Tok)
    (hd : d = .always ∨ d = .never) :
    (extractNew (tokNew f :: d :: rest)).map pol = some (pol (.neg :: d :: rest)) := by
  rcases hd with rfl | rfl <;> rfl

/-- Counterexample (replayed in formal-audit-core-learner-negation):
"You cannot always trust the cache" → "always trust the cache". -/
theorem old_cannot_inverts :
    extractNew [.word, tokOld .cannot, .always, .word] = some [.always, .word] ∧
    pol [.always, .word] ≠ pol [.neg, .always, .word] := by decide

/-! ## 5. Token budget: estimator vs formatter, section totals, renderMemoryBlock -/

def ceil4 (n : Nat) : Nat := (n + 3) / 4

/-- Rendered layer-3 entry length, by field (formatLayer3). `marker` is the
soft-expiry prefix, `kind` the `Kind: <claim_class>` field (0 = absent). -/
structure Entry where
  idLen   : Nat
  stmt    : Nat
  marker  : Nat
  kind    : Nat
  metaRest : Nat   -- every other meta field, as rendered
  deriving Repr

def render3 (e : Entry) : Nat :=
  e.idLen + 3 + e.marker + e.stmt + 1 + (if e.kind = 0 then 0 else e.kind + 9) + e.metaRest

/-- Pre-fix field sum: no marker, no Kind. (Meta fields charged ≥ rendered.) -/
def legacy (e : Entry) : Nat := e.idLen + 4 + e.stmt + e.metaRest + 3

/-- Post-fix: the rendered length (richest layer), floored by the legacy sum. -/
def estNew (render1 : Nat) (e : Entry) : Nat := ceil4 (max (max (render3 e) render1 + 1) (legacy e))

/-- **Fixed code:** the charge covers the rendered entry at layer 3 AND layer 1. -/
theorem estimate_covers_render (render1 : Nat) (e : Entry) :
    render3 e ≤ 4 * estNew render1 e ∧ render1 ≤ 4 * estNew render1 e := by
  unfold estNew ceil4
  constructor <;> omega

/-- **Fixed code:** never cheaper than before (budgets calibrated on it stay valid). -/
theorem estimate_ge_legacy (render1 : Nat) (e : Entry) : ceil4 (legacy e) ≤ estNew render1 e := by
  unfold estNew ceil4; omega

/-- Replayed: an inferred, soft-expired engram rendered 202 chars (51 tokens),
estimated 37. -/
theorem old_estimate_undercharges :
    let e : Entry := ⟨17, 21, 38, 8, 90⟩
    ceil4 (legacy e) < ceil4 (render3 e) := by decide

/-- `fillTokenBudget`'s unpinned loop never exceeds its own budget. -/
def fill (budget : Nat) : Nat → List Nat → Nat
  | used, [] => used
  | used, c :: cs => if used + c > budget then fill budget used cs else fill budget (used + c) cs

theorem fill_le (budget : Nat) (cs : List Nat) : ∀ u, u ≤ budget → fill budget u cs ≤ budget := by
  induction cs with
  | nil => intro u h; exact h
  | cons c cs ih =>
    intro u h; unfold fill; split
    · exact ih u h
    · exact ih _ (by omega)

/-- Pre-cap-sum counterexample: the consider pool and spreading had budgets of
their own on top of the sections. Replayed: maxTokens 500 → tokens_used 448 + 375 = 823.
`tokens_used_bound` (§8) is the claim the code makes now. -/
theorem tokens_used_exceeds_budget : fill 500 0 [448] + fill 200 0 [190] + fill 480 0 [185] > 500 := by
  decide

/-- Decision I1 (cap-sum), post-fix `selectAndSpread`: the sections (pinned,
constraints, directives passes) spend `S ≤ maxT` first — unchanged, so they keep
priority; the consider pool gets `min(200, maxT − S)`, spreading gets
`min(spreadB, maxT − S − consider)`. `fill` bounds each pool by its budget
(`fill_le`); the consider pool's slice to 5 only removes entries. -/
def totalNew (maxT spreadB S : Nat) (cons spr : List Nat) : Nat :=
  let rem := maxT - S
  let c := fill (min 200 rem) 0 cons
  let p := fill (min spreadB (rem - c)) 0 spr
  S + c + p

/-- **Fixed code (I1):** `tokens_used` (directives + consider) never exceeds the
injection budget, for every section spend within the budget, every spread
budget and every candidate list. -/
theorem total_le_budget (maxT spreadB S : Nat) (cons spr : List Nat) (hS : S ≤ maxT) :
    totalNew maxT spreadB S cons spr ≤ maxT := by
  unfold totalNew
  simp only
  have hc := fill_le (min 200 (maxT - S)) cons 0 (Nat.zero_le _)
  have hp := fill_le (min spreadB (maxT - S - fill (min 200 (maxT - S)) 0 cons)) spr 0 (Nat.zero_le _)
  have h1 : min 200 (maxT - S) ≤ maxT - S := Nat.min_le_right _ _
  have h2 : min spreadB (maxT - S - fill (min 200 (maxT - S)) 0 cons)
      ≤ maxT - S - fill (min 200 (maxT - S)) 0 cons := Nat.min_le_right _ _
  omega

/-- With the sections selected by one `fill` pass (any section list), the bound
holds outright. -/
theorem total_le_budget_fill (maxT spreadB : Nat) (sec cons spr : List Nat) :
    totalNew maxT spreadB (fill maxT 0 sec) cons spr ≤ maxT :=
  total_le_budget _ _ _ _ _ (fill_le maxT sec 0 (Nat.zero_le _))

/-- The replayed input (448 section tokens, 190 consider, 185 spread at
maxTokens 500) now totals within the budget: consider and spread are dropped. -/
theorem total_replay : totalNew 500 480 (fill 500 0 [448]) [190] [185] = 448 := by decide

/-- Non-vacuity: with room left, consider and spread are still delivered. -/
theorem total_keeps_pools : totalNew 2000 480 (fill 2000 0 [448]) [190] [185] = 448 + 190 + 185 := by
  decide

/-- renderMemoryBlock (memory-block.ts): each section is appended WHOLE when the
remaining budget is positive (directives) or > 100 (constraints, consider);
its own size is never compared. Output tokens as a function of section sizes. -/
def memBlock (instr budget d c k : Nat) : Nat :=
  let rem : Int := (budget : Int) - instr
  let t1 := if d > 0 ∧ rem > 0 then d else 0
  let t2 := if c > 0 ∧ rem - t1 > 100 then c else 0
  let t3 := if k > 0 ∧ rem - t1 - t2 > 100 then k else 0
  instr + t1 + t2 + t3

/-- Replayed: budget 499, instructions 449, a 5000-token directives section is
rendered in full (5469 tokens out). -/
theorem memBlock_exceeds_budget : memBlock 449 499 5000 5000 5000 > 499 := by decide

/-- Decision I2 (drop), post-fix renderMemoryBlock. Tokens are additive here
(`h` heading, `d c k` section costs incl. their labels); `rem = budget − instr`.
Each section is appended whole iff its own gate holds (`g1 g2 g3`: the kept
"> 0" / "> 100 left" slack gates, arbitrary here) AND the block with it fits
`rem`; the block (heading included) is emitted only if it fits. -/
def addIf (rem x b : Nat) (gate : Bool) : Nat :=
  if gate = true ∧ x > 0 ∧ b + x ≤ rem then b + x else b

def memBlockNew (g1 g2 g3 : Bool) (instr budget h d c k : Nat) : Nat :=
  let rem := budget - instr
  let b3 := addIf rem k (addIf rem c (addIf rem d h g1) g2) g3
  instr + (if b3 ≤ rem then b3 else 0)

/-- **Fixed code (I2):** once the instructions fit, the rendered output never
exceeds the budget — for every section size and every slack-gate outcome. -/
theorem memBlockNew_le (g1 g2 g3 : Bool) (instr budget h d c k : Nat) (hi : instr ≤ budget) :
    memBlockNew g1 g2 g3 instr budget h d c k ≤ budget := by
  unfold memBlockNew
  simp only
  split <;> omega

/-- A section never displaces an earlier one: the block only grows. -/
theorem addIf_ge (rem x b : Nat) (gate : Bool) : b ≤ addIf rem x b gate := by
  unfold addIf; split <;> omega

/-- The replayed input now renders within budget (instructions + the heading;
every 5000-token section is dropped). -/
theorem memBlockNew_replay : memBlockNew true true true 449 499 5 5000 5000 5000 = 449 + 5 := by decide

/-- Non-vacuity: an over-size middle section is dropped whole while the
sections around it that fit are rendered. -/
theorem memBlockNew_keeps_fitting :
    memBlockNew true true true 449 1049 5 100 2000 200 = 449 + 5 + 100 + 200 := by decide

/-! ## 6. Miss-signal classification (telemetry-miss-signal.ts `classifyMiss`)

Scores in millionths (Nat), so `1/(k+rank+1)` is `contrib k rank`. -/

inductive Miss | noResults | lowScore
  deriving DecidableEq, Repr

/-- `classifyMiss`, branch for branch. `none` = hit. -/
def classify (count : Nat) (top : Option Nat) (thr : Nat) : Option Miss :=
  if count = 0 then some .noResults
  else match top with
    | none => some .noResults
    | some t => if t < thr then some .lowScore else none

def contrib (k r : Nat) : Nat := 1000000 / (k + r + 1)

def pos : List Nat → Nat → Option Nat
  | [], _ => none
  | x :: xs, d => if x = d then some 0 else (pos xs d).map (· + 1)

/-- `rrfMerge` score of document `d` over the result lists. -/
def rrf (k : Nat) : List (List Nat) → Nat → Nat
  | [], _ => 0
  | l :: ls, d => (match pos l d with | some r => contrib k r | none => 0) + rrf k ls d

/-- The rank-0 document of any result list scores at least `1/(k+1)`. -/
theorem rrf_head_ge (k d : Nat) (sets : List (List Nat)) (l : List Nat)
    (hl : l ∈ sets) (hd : l.head? = some d) : contrib k 0 ≤ rrf k sets d := by
  induction sets with
  | nil => cases hl
  | cons m ms ih =>
    simp only [rrf]
    rcases List.mem_cons.mp hl with rfl | h
    · cases l with
      | nil => cases hd
      | cons x xs =>
        simp only [List.head?, Option.some.injEq] at hd
        subst hd; simp [pos]
    · have := ih h; omega

/-- **Proved (and contrary to the source comment):** with RRF `k = 60` and the
default floor 0.015, a recall that returned anything is never `low_score` —
its top score is at least `1/61 ≈ 0.01639`. `top` is any score ≥ that of a
returned list's head, as the merged list is sorted by score. -/
theorem lowScore_unreachable (sets : List (List Nat)) (l : List Nat) (d top count : Nat)
    (hl : l ∈ sets) (hd : l.head? = some d) (htop : rrf 60 sets d ≤ top) (hc : count ≠ 0) :
    classify count (some top) 15000 ≠ some .lowScore := by
  have h1 := rrf_head_ge 60 d sets l hl hd
  have h2 : contrib 60 0 = 16393 := by decide
  unfold classify
  simp only [hc, ite_false]
  split <;> simp_all <;> omega

/-- `low_score` IS reachable once the floor exceeds 1/61 (non-vacuity). -/
theorem lowScore_reachable_above_floor : classify 1 (some 16393) 20000 = some .lowScore := by decide

/-- Decision I3 (move): the default floor is 0.025 (25000 millionths). -/
def floorNew : Nat := 25000

/-- The new floor lies strictly between a single-leg top hit (1/61) and a top
hit both legs ranked first (2/61). -/
theorem floorNew_between : contrib 60 0 < floorNew ∧ floorNew < 2 * contrib 60 0 := by decide

/-- **Fixed code (I3):** any single-leg score — rank `r` in exactly one result
list, `1/(61 + r)` — classifies as `low_score` at the new default, for every rank. -/
theorem singleLeg_is_lowScore (r count : Nat) (hc : count ≠ 0) :
    classify count (some (contrib 60 r)) floorNew = some .lowScore := by
  have h : contrib 60 r ≤ contrib 60 0 := Nat.div_le_div_left (by omega) (by omega)
  have h0 : contrib 60 0 = 16393 := by decide
  have hl : contrib 60 r < floorNew := by unfold floorNew; omega
  simp only [classify, hc, ↓reduceIte, hl]

/-- Non-vacuity: a top hit both legs ranked first is still a hit. -/
theorem bothLegs_top_is_hit (count : Nat) (hc : count ≠ 0) :
    classify count (some (contrib 60 0 + contrib 60 0)) floorNew = none := by
  have hl : ¬ (contrib 60 0 + contrib 60 0 < floorNew) := by decide
  simp only [classify, hc, ↓reduceIte, hl]

/-- **Pre-I4 counterexample (historical).** Before decision I4, PGLite recall
reported `topScore: null` with results, and every such recall was classified
`no_results` (replayed then). Since I4, `_pgliteHybridRecall` returns a real RRF
score, so the PGLite path now reaches `classify count (some top) thr` like the
other backends; this theorem only documents what a `null` top score still means
(a caller that passes `none` with results gets `no_results`). -/
theorem pglite_null_is_noResults (count thr : Nat) (hc : count ≠ 0) :
    classify count none thr = some .noResults := by
  simp [classify, hc]

/-! ## 7. Decay (decay.ts)

A parsed date is `Option Nat` (`none` = unparseable, i.e. `getTime()` is NaN).
NaN arithmetic is modelled as `none` propagating; a NaN comparison is false. -/

/-- Pre-fix `daysSince`: NaN in, NaN out. -/
def daysOld (now : Nat) (last : Option Nat) : Option Nat := last.map (fun l => now - l)

/-- Post-fix `daysSince`: an unparseable date counts as 0 days. -/
def daysNew (now : Nat) (last : Option Nat) : Nat := match last with
  | some l => now - l
  | none => 0

/-- Admission in `selectAndSpread` for an unpinned engram with keyword hits:
`raw > 0`, where raw = hits × decayed strength; NaN > 0 is false. `pos` is the
(positive) strength after `d` days. -/
def admittedOld (pos : Nat → Nat) (hits now : Nat) (last : Option Nat) : Bool :=
  match daysOld now last with
  | some d => decide (hits * pos d > 0)
  | none => false

def admittedNew (pos : Nat → Nat) (hits now : Nat) (last : Option Nat) : Bool :=
  decide (hits * pos (daysNew now last) > 0)

/-- **Fixed code:** admission no longer depends on whether the timestamp parses:
with a positive strength and a hit, the engram is admitted for every stored string. -/
theorem decay_total (pos : Nat → Nat) (hpos : ∀ d, pos d > 0) (hits now : Nat) (hh : hits > 0)
    (last : Option Nat) : admittedNew pos hits now last = true := by
  simp only [admittedNew, decide_eq_true_eq]; exact Nat.mul_pos hh (hpos _)

/-- Replayed: pre-fix, a malformed `last_accessed` silently drops the engram. -/
theorem old_bad_date_dropped : admittedOld (fun _ => 1) 1 100 none = false := rfl

/-- `confidenceDecay` result (millionths). `none` = NaN. Floor 100000 (0.1). -/
def confOld (mult : Nat → Nat) (rs : Nat) (ref : Option Nat) (now : Nat) : Option Nat :=
  (daysOld now ref).map (fun d => max 100000 (rs * mult d / 1000000))

def confNew (mult : Nat → Nat) (rs : Nat) (ref : Option Nat) (now : Nat) : Nat :=
  match ref with
  | none => rs
  | some r => max 100000 (rs * mult (now - r) / 1000000)

/-- **Fixed code:** "Floor at 0.1" holds whenever the input was at or above it. -/
theorem conf_floor (mult : Nat → Nat) (rs now : Nat) (ref : Option Nat) (h : rs ≥ 100000) :
    confNew mult rs ref now ≥ 100000 := by
  cases ref <;> simp [confNew] <;> omega

theorem old_conf_nan : confOld (fun _ => 1) 800000 none 5 = none := rfl

/-- `decayedStrength` scaled by 10^6: `F + (r − F)·q` with `q = e^{−λd}·10^6 ∈ [0, 10^6]`,
here for `r ≥ F` (Nat subtraction). Decay never raises a strength at or above the floor. -/
theorem decay_nonincreasing_above_floor (F r q : Nat) (hF : F ≤ r) (hq : q ≤ 1000000) :
    F * 1000000 + (r - F) * q ≤ r * 1000000 := by
  have : (r - F) * q ≤ (r - F) * 1000000 := Nat.mul_le_mul_left _ hq
  have e : r * 1000000 = F * 1000000 + (r - F) * 1000000 := by
    rw [← Nat.add_mul, Nat.add_sub_cancel' hF]
  omega

/-- Pre-fix `decayedStrength` (×10^6): `F + (r − F)·q = F·(10^6 − q) + r·q`,
for every `r`, including a strength below the floor. -/
def decOld (F r q : Nat) : Nat := F * (1000000 - q) + r * q

/-- Post-fix (decision I6 above-floor): a strength at or below the floor is
returned unchanged; above it, the formula as before. -/
def decNew (F r q : Nat) : Nat := if r ≤ F then r * 1000000 else decOld F r q

/-- **Fixed code (I6):** decay never raises a strength, for every strength, floor
and decay factor `q = e^{−λd}·10^6 ∈ [0, 10^6]`. -/
theorem decay_never_rises (F r q : Nat) (hq : q ≤ 1000000) : decNew F r q ≤ r * 1000000 := by
  unfold decNew decOld
  by_cases h : r ≤ F
  · simp only [h, ↓reduceIte, Nat.le_refl]
  · simp only [h, ↓reduceIte]
    have h1 : F * (1000000 - q) ≤ r * (1000000 - q) := Nat.mul_le_mul_right _ (by omega)
    have h2 : r * (1000000 - q) + r * q = r * 1000000 := by
      rw [← Nat.mul_add, Nat.sub_add_cancel hq]
    omega

/-- **Fixed code (I6):** above the floor, decay still pulls the strength toward
the floor and never below it (non-vacuity: decay still happens). -/
theorem decay_above_floor_bounded (F r q : Nat) (hF : F < r) (hq : q ≤ 1000000) :
    F * 1000000 ≤ decNew F r q := by
  unfold decNew decOld
  have hn : ¬ r ≤ F := by omega
  simp only [hn, ↓reduceIte]
  have h1 : F * q ≤ r * q := Nat.mul_le_mul_right _ (by omega)
  have h2 : F * (1000000 - q) + F * q = F * 1000000 := by
    rw [← Nat.mul_add, Nat.sub_add_cancel hq]
  omega

theorem decay_still_decays : decNew 50000 800000 223130 < 800000 * 1000000 := by decide

/-- Pre-fix counterexample (replayed): feedback floors strength at 0.0, below the
decay floor 0.05, and decay lifted it: decayedStrength(0, 30) = 0.0388 > 0.
Instance r = 0, q = e^{−1.5}·10^6. -/
theorem sub_floor_rises : decOld 50000 0 223130 > 0 * 1000000 := by decide

/-- The fixed code on the same input: 0 stays 0. -/
theorem sub_floor_stays : decNew 50000 0 223130 = 0 := by decide

/-! ## 8. The whole injection budget, branch for branch (inject.ts `selectAndSpread`)

`total_le_budget` (§5) takes the section spend `S ≤ maxT` as a hypothesis. This
section models how the sections spend it: the tiered pinned pass, the
constraints-floor pass, the directives pass and the slack pass, then the
consider pool (sliced to 5) and spreading activation (stopped at a count cap).
The per-pack / per-domain caps are oracles (`ok*`, given what each pass has
admitted), so every bound holds whatever they decide. Nat subtraction is the
code's `Math.max(0, …)`. -/

def sumL : List Nat → Nat
  | [] => 0
  | x :: xs => x + sumL xs

theorem sumL_append (a b : List Nat) : sumL (a ++ b) = sumL a + sumL b := by
  induction a with
  | nil => simp [sumL]
  | cons x xs ih => simp only [List.cons_append, sumL, ih]; omega

theorem sumL_take_le (k : Nat) (l : List Nat) : sumL (l.take k) ≤ sumL l := by
  induction l generalizing k with
  | nil => simp [sumL]
  | cons x xs ih =>
    cases k with
    | zero => simp [sumL]
    | succ k => simp only [List.take_succ_cons, sumL]; have := ih k; omega

/-- `fillTokenBudget`'s unpinned loop: `tokensUsed + cost > maxTokens` skips;
then the fairness caps (`ok`) may skip; else the engram is appended. -/
def fillS (ok : List Nat → Nat → Bool) (budget : Nat) : List Nat → List Nat → List Nat
  | acc, [] => acc
  | acc, c :: cs =>
    if sumL acc + c > budget then fillS ok budget acc cs
    else if ok acc c = false then fillS ok budget acc cs
    else fillS ok budget (acc ++ [c]) cs

theorem fillS_le (ok : List Nat → Nat → Bool) (budget : Nat) (cs : List Nat) :
    ∀ acc, sumL acc ≤ budget → sumL (fillS ok budget acc cs) ≤ budget := by
  induction cs with
  | nil => intro acc h; exact h
  | cons c cs ih =>
    intro acc h; unfold fillS
    split
    · exact ih acc h
    · split
      · exact ih acc h
      · apply ih; rw [sumL_append]; simp only [sumL]; omega

/-! ### 8a. The pinned pass with two tiers (`fillTokenBudget` pinned loop)

`pinB` = `floor(base × pinnedShareRatio)`, `hardCap` = `pinnedHardCap`,
`R` = `hardPinnedReserve` over every candidate. The ledger's
`spent − hardSpent` is `softS`. Blocking is per tier; a total-budget skip
blocks both. -/

structure TPin where
  rank : Nat
  cost : Nat
  hard : Bool
  deriving DecidableEq, Repr

structure TSt where
  used  : Nat
  hardS : Nat
  softS : Nat
  skH   : Option Nat
  skS   : Option Nat
  adm   : List TPin
  om    : List TPin
  deriving Repr

def tstep (maxT pinB hardCap R : Nat) (st : TSt) (p : TPin) : TSt :=
  if blockedBy (if p.hard then st.skH else st.skS) p.rank then { st with om := p :: st.om }
  else if st.used + p.cost > maxT then
    { st with om := p :: st.om, skS := some (minOpt st.skS p.rank), skH := some (minOpt st.skH p.rank) }
  else if p.hard then
    if st.hardS + p.cost > hardCap ∨ st.hardS + st.softS + p.cost > pinB then
      { st with om := p :: st.om, skH := some (minOpt st.skH p.rank) }
    else { st with adm := p :: st.adm, used := st.used + p.cost, hardS := st.hardS + p.cost }
  else if st.softS + p.cost > pinB - R then
    { st with om := p :: st.om, skS := some (minOpt st.skS p.rank) }
  else { st with adm := p :: st.adm, used := st.used + p.cost, softS := st.softS + p.cost }

def trun (maxT pinB hardCap R : Nat) (st : TSt) : List TPin → TSt
  | [] => st
  | p :: ps => trun maxT pinB hardCap R (tstep maxT pinB hardCap R st p) ps

def hardSum : List TPin → Nat
  | [] => 0
  | p :: ps => (if p.hard then p.cost else 0) + hardSum ps

/-- `hardPinnedReserve`: the hard candidates' cost, up to the hard cap. -/
def reserve (hardCap : Nat) (ps : List TPin) : Nat := min hardCap (hardSum ps)

def tinit : TSt := ⟨0, 0, 0, none, none, [], []⟩

def TInv (maxT pinB hardCap R : Nat) (st : TSt) : Prop :=
  st.used = st.hardS + st.softS ∧ st.used ≤ maxT ∧ st.hardS ≤ hardCap ∧ st.softS ≤ pinB - R

theorem tstep_inv (maxT pinB hardCap R : Nat) (st : TSt) (p : TPin)
    (h : TInv maxT pinB hardCap R st) : TInv maxT pinB hardCap R (tstep maxT pinB hardCap R st p) := by
  unfold TInv at *
  obtain ⟨h1, h2, h3, h4⟩ := h
  unfold tstep
  repeat' split
  all_goals first
    | exact ⟨h1, h2, h3, h4⟩
    | (refine ⟨?_, ?_, ?_, ?_⟩ <;> simp only <;> omega)

theorem tstep_hard (maxT pinB hardCap R : Nat) (st : TSt) (p : TPin) :
    (tstep maxT pinB hardCap R st p).hardS ≤ st.hardS + (if p.hard then p.cost else 0) := by
  unfold tstep
  repeat' split
  all_goals first | (simp only; omega) | simp_all

theorem trun_props (maxT pinB hardCap R : Nat) (ps : List TPin) :
    ∀ st, TInv maxT pinB hardCap R st →
      TInv maxT pinB hardCap R (trun maxT pinB hardCap R st ps) ∧
      (trun maxT pinB hardCap R st ps).hardS ≤ st.hardS + hardSum ps := by
  induction ps with
  | nil => intro st h; exact ⟨h, by simp [trun, hardSum]⟩
  | cons p ps ih =>
    intro st h
    have ⟨hi, hh⟩ := ih _ (tstep_inv maxT pinB hardCap R st p h)
    refine ⟨hi, ?_⟩
    have := tstep_hard maxT pinB hardCap R st p
    simp only [trun, hardSum]
    omega

/-- **INJ-6, pinned share:** the pinned pass never spends more than the
injection budget, never more than the pinned share in total, and the hard
tier never more than its sub-cap — for every pin list, order and cost. Needs
`hardCap ≤ pinB`, which `pinnedHardCap` guarantees by clamping the hard ratio
to [0, 1]. -/
theorem pinned_within_share (maxT pinB hardCap : Nat) (ps : List TPin) (hcap : hardCap ≤ pinB) :
    let st := trun maxT pinB hardCap (reserve hardCap ps) tinit ps
    st.used ≤ maxT ∧ st.hardS + st.softS ≤ pinB ∧ st.hardS ≤ hardCap := by
  dsimp only
  have h0 : TInv maxT pinB hardCap (reserve hardCap ps) tinit := by
    simp [TInv, tinit]
  have ⟨⟨_, h2, h3, h4⟩, hh⟩ := trun_props maxT pinB hardCap (reserve hardCap ps) ps tinit h0
  have ht : tinit.hardS = 0 := rfl
  rw [ht, Nat.zero_add] at hh
  generalize trun maxT pinB hardCap (reserve hardCap ps) tinit ps = st at *
  have hR : st.hardS ≤ reserve hardCap ps := Nat.le_min.mpr ⟨h3, hh⟩
  have hR2 : reserve hardCap ps ≤ hardCap := Nat.min_le_left _ _
  exact ⟨h2, by omega, h3⟩

/-- Non-vacuity: a hard and a soft pin that fit are both admitted. -/
theorem pinned_tiers_admitted :
    let ps := [TPin.mk 0 200 true, TPin.mk 0 250 false]
    (trun 1000 500 250 (reserve 250 ps) tinit ps).adm.length = 2 := by decide

/-- A soft pin of a higher origin cannot spend what the hard tier holds back:
soft 400 at origin 0, hard 200 at origin 1, share 500 (reserve 200): the soft
pin is omitted, the hard pin admitted. -/
theorem soft_cannot_spend_reserve :
    let ps := [TPin.mk 0 400 false, TPin.mk 1 200 true]
    let st := trun 1000 500 250 (reserve 250 ps) tinit ps
    st.adm = [TPin.mk 1 200 true] ∧ st.om = [TPin.mk 0 400 false] := by decide

/-! ### 8b. The section passes after the pins -/

/-- Pre-fix: the constraints-floor pass got `floor − pc` whatever the pins left. -/
def sectionsOld (ok1 ok2 ok3 : List Nat → Nat → Bool) (maxT floor p pc : Nat)
    (cs ds rest : List Nat) : Nat :=
  let f := sumL (fillS ok1 (floor - pc) [] cs)
  let d := sumL (fillS ok2 (maxT - p - f) [] ds)
  let sl := maxT - p - f - d
  let s := if sl > 0 then sumL (fillS ok3 sl [] rest) else 0
  p + f + d + s

/-- Post-fix: the floor pass gets `min(floor − pc, maxT − p)`; directives get
what pins and floor left; the slack pass what directives left. `p` is the
pinned pass's spend, `pc` the part of it on pinned constraints. -/
def sectionsNew (ok1 ok2 ok3 : List Nat → Nat → Bool) (maxT floor p pc : Nat)
    (cs ds rest : List Nat) : Nat :=
  let f := sumL (fillS ok1 (min (floor - pc) (maxT - p)) [] cs)
  let d := sumL (fillS ok2 (maxT - p - f) [] ds)
  let sl := maxT - p - f - d
  let s := if sl > 0 then sumL (fillS ok3 sl [] rest) else 0
  p + f + d + s

/-- Replayed (formal-inject-budget-sections.test.ts, pre-fix: 1341 tokens at
maxTokens 1000 with `pinned_ratio: 1`): pins spend the whole budget and the
floor pass still adds its 400. -/
theorem old_sections_exceed :
    sectionsOld (fun _ _ => true) (fun _ _ => true) (fun _ _ => true) 1000 400 1000 0 [400] [] [] = 1400 := by
  decide

/-- **Fixed code:** the sections never spend more than the budget, once the
pins are within it — for every floor, every cap decision and every list. -/
theorem sections_le_budget (ok1 ok2 ok3 : List Nat → Nat → Bool) (maxT floor p pc : Nat)
    (cs ds rest : List Nat) (hp : p ≤ maxT) :
    sectionsNew ok1 ok2 ok3 maxT floor p pc cs ds rest ≤ maxT := by
  unfold sectionsNew
  simp only
  have hf := fillS_le ok1 (min (floor - pc) (maxT - p)) cs [] (by simp [sumL])
  have hm : min (floor - pc) (maxT - p) ≤ maxT - p := Nat.min_le_right _ _
  have hd := fillS_le ok2 (maxT - p - sumL (fillS ok1 (min (floor - pc) (maxT - p)) [] cs)) ds []
    (by simp [sumL])
  split
  · have hs := fillS_le ok3 (maxT - p - sumL (fillS ok1 (min (floor - pc) (maxT - p)) [] cs)
      - sumL (fillS ok2 (maxT - p - sumL (fillS ok1 (min (floor - pc) (maxT - p)) [] cs)) [] ds))
      rest [] (by simp [sumL])
    omega
  · omega

theorem sections_replay :
    sectionsNew (fun _ _ => true) (fun _ _ => true) (fun _ _ => true) 1000 400 1000 0 [400] [] [] = 1000 := by
  decide

/-- Non-vacuity: with room, the floor, directives and slack passes all deliver. -/
theorem sections_keep :
    sectionsNew (fun _ _ => true) (fun _ _ => true) (fun _ _ => true) 2000 800 500 0 [300, 900] [400] [600]
      = 500 + 300 + 400 + 600 := by
  decide

/-! ### 8c. Consider pool and spreading activation -/

/-- The spreading loop: over the budget → skip (`continue`); at the count cap → stop. -/
def spreadRun (eff cap : Nat) : Nat → Nat → List Nat → Nat
  | _, t, [] => t
  | n, t, c :: cs =>
    if t + c > eff then spreadRun eff cap n t cs
    else if n ≥ cap then t
    else spreadRun eff cap (n + 1) (t + c) cs

theorem spreadRun_le (eff cap : Nat) (cs : List Nat) :
    ∀ n t, t ≤ eff → spreadRun eff cap n t cs ≤ eff := by
  induction cs with
  | nil => intro n t h; exact h
  | cons c cs ih =>
    intro n t h; unfold spreadRun
    split
    · exact ih n t h
    · split
      · exact h
      · exact ih _ _ (by omega)

/-- The consider pool gets `min(200, rem)` and is sliced to its first 5;
spreading gets `min(spread_budget, rem − pool)`. -/
def poolsNew (okC : List Nat → Nat → Bool) (maxT spreadB cap S : Nat) (cons spr : List Nat) : Nat :=
  let rem := maxT - S
  let pool := sumL ((fillS okC (min 200 rem) [] cons).take 5)
  let sp := spreadRun (min spreadB (rem - pool)) cap 0 0 spr
  S + pool + sp

theorem pools_le_budget (okC : List Nat → Nat → Bool) (maxT spreadB cap S : Nat)
    (cons spr : List Nat) (hS : S ≤ maxT) : poolsNew okC maxT spreadB cap S cons spr ≤ maxT := by
  unfold poolsNew
  simp only
  have hc := fillS_le okC (min 200 (maxT - S)) cons [] (by simp [sumL])
  have ht := sumL_take_le 5 (fillS okC (min 200 (maxT - S)) [] cons)
  have hm : min 200 (maxT - S) ≤ maxT - S := Nat.min_le_right _ _
  have hp := spreadRun_le (min spreadB (maxT - S - sumL ((fillS okC (min 200 (maxT - S)) [] cons).take 5)))
    cap spr 0 0 (Nat.zero_le _)
  have hm2 : min spreadB (maxT - S - sumL ((fillS okC (min 200 (maxT - S)) [] cons).take 5))
      ≤ maxT - S - sumL ((fillS okC (min 200 (maxT - S)) [] cons).take 5) := Nat.min_le_right _ _
  omega

/-- **INJ-2, the claim the code makes (`InternalInjectionResult.tokens_used`,
`selectAndSpread` CAP-SUM):** the whole injection — pins, constraints floor,
directives, constraints slack, consider pool and spreading — never exceeds
`maxTokens`, for every pinned share, hard cap, floor, spread budget, count cap,
fairness-cap decision and candidate list. -/
theorem tokens_used_bound (ok1 ok2 ok3 okC : List Nat → Nat → Bool)
    (maxT floor pinB hardCap spreadB cap pc : Nat) (pins : List TPin)
    (cs ds rest cons spr : List Nat) (hcap : hardCap ≤ pinB) :
    let pst := trun maxT pinB hardCap (reserve hardCap pins) tinit pins
    poolsNew okC maxT spreadB cap (sectionsNew ok1 ok2 ok3 maxT floor pst.used pc cs ds rest) cons spr
      ≤ maxT := by
  intro pst
  have hp := (pinned_within_share maxT pinB hardCap pins hcap).1
  exact pools_le_budget _ _ _ _ _ _ _ (sections_le_budget _ _ _ _ _ _ _ _ _ _ hp)

end PlurSpec.ScopeInject
