/-!
# PlurSpec.RoutingDiscovery — where a write goes, and what a /me answer may change (#1631)

Models of `packages/core/src/store-resolver.ts` (resolveScopeTarget, urlGroupsForScope,
remoteOf), the write paths in `packages/core/src/index.ts` that read it (the router
`_resolveRemoteStoreForScope`, the scan gate `_hasUrlStoreForScope`, the outbox flush
`routeFor`), `packages/core/src/server-discovery.ts` (acceptDiscoveredScopes) and the cache
write of `Plur.refreshServerScopes` (index.ts, with `discoveryChanged`). Findings, verdicts and
replays: `spec/formal/findings/routing-discovery.md`. Checked against branch formal2/epic-1797
(b22f01d0) plus the fixes in this round.

Abstracted: scopes `S`, server endpoint identities `U` (the canonical identity of a configured
url; see §Endpoint identity for the spelling → identity map) and orgs `O` are arbitrary types with
decidable equality. `personal s` is "starts with `user:`", `orgOf` is `scopeOrg`, `inOrg o x` is
`orgRejection(x, o, username) === null`, `shared` is `isSharedScope`, `hit` is the secret/policy
scan's verdict on the content. Every theorem holds for every such oracle. The personal selection
(`personalStoreEntry`'s first-minimum-rank reduce) is modelled by the equivalent cascade of
`find?` per rank. Left out: string grammar of scopes, the cooldown/held-back filters of the flush
(they only skip), YAML key order.

Checked against #1521 (remote-only folders, merged onto development 2026-10-18): still holds.
The resolver (§1) is unchanged and is now also what a remote-only folder calls deliverable
(`_isDeliverableTeamScope` = shared, not local-only, not `user:`, resolver `remote` and
writable). The remote-only gate runs before the leak guard and the write paths of §2 and only
refuses (WritePath §3d); discovery and the cache write (§3, §4) are not touched.

Checked against registerEnterpriseServer (#1631 plan B Task 5, branch agent/efi-b05, 2026-10-18): still holds.
Rechecked after the gate review and Codex audit rounds 1-2 on the same branch (2026-10-18): still holds.
index.ts changed only inside registerEnterpriseServer (error wording); server-discovery.ts only in the
registration/fold functions, which StoreEntry §6/§6b model.
index.ts gains `registerEnterpriseServer`, a new public method that writes config.yaml through
`_updateRawStores` (config lock, atomic write) and reads `listOutbox`; no existing branch modelled
here changed. The registration and fold are modelled in StoreEntry §6.
server-discovery.ts gains `foldStoresIntoServerEntry` and `registerServerEntry` beside
`acceptDiscoveredScopes`, which is unchanged. A registration refuses two server entries on one
url, like the cache write (D4), and never writes `scopes` or `discovery`.

Rechecked after Codex audit rounds 3-5 on branch agent/efi-b05 (2026-10-18): still holds. The changes are
refusals and eligibility checks inside registerEnterpriseServer/registerServerEntry/foldStoresIntoServerEntry
(nothing is written on a refusal), the outbox read moved before the write, and config.ts's unset-token_env
warning naming the url by origin; no modelled branch changed.

Checked against #1631 background discovery (PR gate, 2026-10-18): still holds.
index.ts only adds `_serverDiscoveryEndpoints()`, a read of config.yaml that lists the
urls `refreshServerScopes` probes (the same `isEnterpriseServerEntry` filter). It
writes nothing and is read only by the MCP server; routing and the refresh's cache write are untouched.
-/

set_option linter.unusedSimpArgs false
set_option linter.unusedSectionVars false

namespace PlurSpec.RoutingDiscovery

/-! ## 1. The resolver (candidate 1) -/

structure Entry (S U O : Type) where
  scope    : S
  url      : Option U      -- the endpoint identity `normalizeEndpointUrl(url)` (§Endpoint identity); `none` = a path store
  readonly : Bool
  org      : Option O      -- an `enterprise` object with a string `discovery.org_id` (case-folded)
deriving DecidableEq

inductive Target (S U O : Type) where
  | remote (e : Entry S U O) (writable : Bool)
  | conflict (servers : List U)
  | unauthorized (server : U)
  | local (e : Option (Entry S U O))
deriving DecidableEq

variable {S U O : Type} [DecidableEq S] [DecidableEq U] [DecidableEq O]

/-- `personalStoreEntry` on the exact entries: local first, then writable url, then readonly. -/
def pick (xs : List (Entry S U O)) : Option (Entry S U O) :=
  (xs.find? (fun e => e.url.isNone)).or
    ((xs.find? (fun e => e.url.isSome && !e.readonly)).or (xs.find? (fun e => e.url.isSome)))

/-- The urls of the exact-scope url entries, in config order. -/
def exactUrls (s : S) (l : List (Entry S U O)) : List U :=
  l.filterMap (fun e => if e.scope = s then e.url else none)

def dedupAux : List U → List U → List U
  | acc, [] => acc
  | acc, u :: us => dedupAux (if u ∈ acc then acc else acc ++ [u]) us

/-- `urlGroupsForScope(...).map(server)`: one name per distinct server. -/
def servers (s : S) (l : List (Entry S U O)) : List U := dedupAux [] (exactUrls s l)

def group (s : S) (u : U) (l : List (Entry S U O)) : List (Entry S U O) :=
  l.filter (fun e => decide (e.scope = s) && decide (e.url = some u))

/-- `remoteOf`: the first writable entry of the group, else its first entry. -/
def remoteOf (g : List (Entry S U O)) : Target S U O :=
  match g.find? (fun e => !e.readonly) with
  | some e => .remote e true
  | none => match g.head? with
    | some e => .remote e false
    | none => .local none

def personalHit (personal : S → Bool) (s : S) (l : List (Entry S U O)) : Bool :=
  personal s && l.any (fun e => decide (e.scope = s))

/-- `resolveScopeTarget`, rule for rule (store-resolver.ts:96–121). -/
def resolve (personal : S → Bool) (orgOf : S → Option O) (s : S) (l : List (Entry S U O)) :
    Target S U O :=
  if personalHit personal s l then
    match pick (l.filter (fun e => decide (e.scope = s))) with
    | some e => if e.url.isSome then .remote e (!e.readonly) else .local (some e)
    | none => .local none
  else match servers s l with
    | u :: v :: rest => .conflict (u :: v :: rest)
    | [u] => remoteOf (group s u l)
    | [] =>
      let pathHit := l.find? (fun e => e.url.isNone && decide (e.scope = s))
      match orgOf s with
      | some o => match l.find? (fun e => e.url.isSome && decide (e.org = some o)) with
        | some e => match e.url with
          | some u => .unauthorized u
          | none => .local pathHit
        | none => .local pathHit
      | none => .local pathHit

/-! ### Facts about the url groups -/

theorem mem_dedupAux (u : U) : ∀ (acc xs : List U), u ∈ dedupAux acc xs ↔ u ∈ acc ∨ u ∈ xs := by
  intro acc xs
  induction xs generalizing acc with
  | nil => simp [dedupAux]
  | cons x xs ih =>
    simp only [dedupAux]; rw [ih]
    by_cases hx : x ∈ acc
    · simp only [hx, ite_true, List.mem_cons]
      constructor
      · rintro (h | h)
        · exact Or.inl h
        · exact Or.inr (Or.inr h)
      · rintro (h | h | h)
        · exact Or.inl h
        · subst h; exact Or.inl hx
        · exact Or.inr h
    · simp only [hx, ite_false, List.mem_append, List.mem_singleton, List.mem_cons, List.not_mem_nil, or_false]
      constructor
      · rintro ((h | h) | h)
        · exact Or.inl h
        · exact Or.inr (Or.inl h)
        · exact Or.inr (Or.inr h)
      · rintro (h | h | h)
        · exact Or.inl (Or.inl h)
        · exact Or.inl (Or.inr h)
        · exact Or.inr h

theorem nodup_dedupAux : ∀ (acc xs : List U), acc.Nodup → (dedupAux acc xs).Nodup := by
  intro acc xs
  induction xs generalizing acc with
  | nil => intro h; simpa [dedupAux] using h
  | cons x xs ih =>
    intro h; simp only [dedupAux]; apply ih
    by_cases hx : x ∈ acc
    · simpa [hx] using h
    · simp only [hx, ite_false]
      rw [List.nodup_append]
      exact ⟨h, by simp, by intro a ha b hb; simp at hb; subst hb; intro he; subst he; exact hx ha⟩

theorem mem_servers (s : S) (l : List (Entry S U O)) (u : U) :
    u ∈ servers s l ↔ ∃ e ∈ l, e.scope = s ∧ e.url = some u := by
  simp only [servers, mem_dedupAux, exactUrls, List.mem_filterMap]
  simp only [List.not_mem_nil, false_or]
  constructor
  · rintro ⟨e, he, h⟩
    by_cases hs : e.scope = s
    · simp [hs] at h; exact ⟨e, he, hs, h⟩
    · simp [hs] at h
  · rintro ⟨e, he, hs, hu⟩; exact ⟨e, he, by simp [hs, hu]⟩

theorem nodup_servers (s : S) (l : List (Entry S U O)) : (servers s l).Nodup :=
  nodup_dedupAux [] _ (by simp)

/-- Two members of a list of length ≤ 1 are equal. -/
theorem eq_of_len_le_one {α : Type} {L : List α} {a b : α} (h : L.length ≤ 1)
    (ha : a ∈ L) (hb : b ∈ L) : a = b := by
  match L, h with
  | [], _ => simp at ha
  | [x], _ => simp at ha hb; rw [ha, hb]
  | _ :: _ :: _, h => simp at h

/-- Two servers claim `s` exactly. -/
def TwoServers (s : S) (l : List (Entry S U O)) : Prop :=
  ∃ e₁ ∈ l, ∃ e₂ ∈ l, e₁.scope = s ∧ e₂.scope = s ∧ e₁.url.isSome ∧ e₂.url.isSome ∧ e₁.url ≠ e₂.url

theorem two_le_servers_iff (s : S) (l : List (Entry S U O)) :
    2 ≤ (servers s l).length ↔ TwoServers s l := by
  constructor
  · intro h
    have hn := nodup_servers s l
    match hl : servers s l, h with
    | u :: v :: rest, _ =>
      rw [hl] at hn
      have huv : u ≠ v := by
        intro he; subst he; simp [List.nodup_cons] at hn
      obtain ⟨e₁, h1, hs1, hu1⟩ := (mem_servers s l u).mp (by rw [hl]; simp)
      obtain ⟨e₂, h2, hs2, hu2⟩ := (mem_servers s l v).mp (by rw [hl]; simp)
      exact ⟨e₁, h1, e₂, h2, hs1, hs2, by simp [hu1], by simp [hu2],
        by rw [hu1, hu2]; intro h; exact huv (Option.some.inj h)⟩
  · rintro ⟨e₁, h1, e₂, h2, hs1, hs2, hu1, hu2, hne⟩
    obtain ⟨u, hu⟩ := Option.isSome_iff_exists.mp hu1
    obtain ⟨v, hv⟩ := Option.isSome_iff_exists.mp hu2
    have m1 := (mem_servers s l u).mpr ⟨e₁, h1, hs1, hu⟩
    have m2 := (mem_servers s l v).mpr ⟨e₂, h2, hs2, hv⟩
    false_or_by_contra
    rename_i hlt
    have := eq_of_len_le_one (by omega) m1 m2
    subst this; exact hne (by rw [hu, hv])

theorem servers_nil_iff (s : S) (l : List (Entry S U O)) :
    servers s l = [] ↔ ∀ e ∈ l, e.scope = s → e.url = none := by
  constructor
  · intro h e he hs
    cases hu : e.url with
    | none => rfl
    | some u =>
      have := (mem_servers s l u).mpr ⟨e, he, hs, hu⟩
      rw [h] at this; simp at this
  · intro h
    cases hl : servers s l with
    | nil => rfl
    | cons u _ =>
      obtain ⟨e, he, hs, hu⟩ := (mem_servers s l u).mp (by rw [hl]; simp)
      rw [h e he hs] at hu; cases hu

/-! ### The resolver's answers -/

theorem pick_mem {xs : List (Entry S U O)} {e : Entry S U O} (h : pick xs = some e) : e ∈ xs := by
  unfold pick at h
  cases h1 : xs.find? (fun e => e.url.isNone) with
  | some a => rw [h1] at h; simp at h; subst h; exact List.mem_of_find?_eq_some h1
  | none =>
    rw [h1] at h
    cases h2 : xs.find? (fun e => e.url.isSome && !e.readonly) with
    | some a => rw [h2] at h; simp at h; subst h; exact List.mem_of_find?_eq_some h2
    | none =>
      rw [h2] at h; simp at h; exact List.mem_of_find?_eq_some h

theorem remoteOf_mem {g : List (Entry S U O)} {e : Entry S U O} {w : Bool}
    (h : remoteOf g = .remote e w) : e ∈ g ∧ w = !e.readonly := by
  unfold remoteOf at h
  cases h1 : g.find? (fun e => !e.readonly) with
  | some a =>
    rw [h1] at h; simp at h; obtain ⟨rfl, rfl⟩ := h
    have := List.find?_some h1; simp at this
    exact ⟨List.mem_of_find?_eq_some h1, by simp [this]⟩
  | none =>
    rw [h1] at h
    cases h2 : g.head? with
    | none => rw [h2] at h; cases h
    | some a =>
      rw [h2] at h; simp at h; obtain ⟨rfl, rfl⟩ := h
      have hm := List.mem_of_mem_head? h2
      have := List.find?_eq_none.mp h1 _ hm
      exact ⟨hm, by simpa using this⟩

/-- Candidate 1: a `remote` answer names an exact-scope url entry of the config, and
`writable` is exactly "that entry is not readonly". -/
theorem remote_is_exact_url (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (e : Entry S U O) (w : Bool)
    (h : resolve personal orgOf s l = .remote e w) :
    e ∈ l ∧ e.scope = s ∧ e.url.isSome ∧ w = !e.readonly := by
  unfold resolve at h
  split at h
  · split at h
    · rename_i a ha
      split at h
      · rename_i hu
        simp at h; obtain ⟨rfl, hw⟩ := h
        have hm := pick_mem ha; simp at hm
        exact ⟨hm.1, hm.2, hu, by rw [hw]; simp⟩
      · cases h
    · cases h
  · split at h
    · cases h
    · rename_i u _
      obtain ⟨hm, hw⟩ := remoteOf_mem h
      simp [group] at hm
      exact ⟨hm.1, hm.2.1, by simp [hm.2.2], hw⟩
    · split at h <;> (try split at h) <;> (try split at h) <;> cases h

/-- Candidate 1: outside the personal rule, `conflict` exactly when two servers claim the
exact scope. -/
theorem conflict_iff (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (hp : personalHit personal s l = false) :
    (∃ xs, resolve personal orgOf s l = .conflict xs) ↔ TwoServers s l := by
  rw [← two_le_servers_iff]
  unfold resolve; rw [hp]; simp only [Bool.false_eq_true, ite_false]
  match servers s l with
  | u :: v :: rest => simp
  | [u] => simp [remoteOf]; split <;> (try split) <;> simp
  | [] =>
    simp only [List.length_nil]
    constructor
    · rintro ⟨xs, h⟩
      revert h; split <;> (try split) <;> (try split) <;> simp
    · intro h; omega

/-- Candidate 1: outside the personal rule, `unauthorized` exactly when no url entry claims
the scope and a company server's org is the scope's org. -/
theorem unauthorized_iff (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (hp : personalHit personal s l = false) :
    (∃ u, resolve personal orgOf s l = .unauthorized u) ↔
      ((∀ e ∈ l, e.scope = s → e.url = none) ∧
        ∃ o e, orgOf s = some o ∧ e ∈ l ∧ e.url.isSome ∧ e.org = some o) := by
  rw [← servers_nil_iff]
  unfold resolve; rw [hp]; simp only [Bool.false_eq_true, ite_false]
  match hs : servers s l with
  | u :: v :: rest => simp
  | [u] =>
    simp only [reduceCtorEq, false_and, iff_false]
    rintro ⟨x, hx⟩
    unfold remoteOf at hx; revert hx; split <;> (try split) <;> simp
  | [] =>
    simp only [true_and]
    cases ho : orgOf s with
    | none => simp
    | some o =>
      simp only
      cases hf : l.find? (fun e => e.url.isSome && decide (e.org = some o)) with
      | none =>
        simp only [reduceCtorEq, exists_false, false_iff]
        rintro ⟨o', e, ho', he, hu, heo⟩
        cases ho'
        have := List.find?_eq_none.mp hf e he
        simp [hu, heo] at this
      | some e =>
        have hp' := List.find?_some hf
        simp at hp'
        obtain ⟨hu, heo⟩ := hp'
        obtain ⟨u, hu'⟩ := Option.isSome_iff_exists.mp hu
        simp only [hu']
        simp only [Target.unauthorized.injEq, exists_eq', true_iff]
        exact ⟨o, e, rfl, List.mem_of_find?_eq_some hf, by simp [hu'], heo⟩

/-- Non-vacuity: every kind of answer is reachable. -/
theorem answers_reachable :
    let a : Entry Nat Nat Nat := ⟨1, some 10, false, none⟩
    let b : Entry Nat Nat Nat := ⟨1, some 11, false, none⟩
    let c : Entry Nat Nat Nat := ⟨2, some 10, false, some 7⟩
    let no : Nat → Bool := fun _ => false
    resolve no (fun _ => none) 1 [a] = .remote a true ∧
    resolve no (fun _ => none) 1 [a, b] = .conflict [10, 11] ∧
    resolve no (fun _ => some 7) 3 [c] = .unauthorized 10 ∧
    resolve no (fun _ => none) 3 [c] = .local none := by decide

/-- REPLAYED counterexample (NEEDS-OWNER Q1): the personal rule runs first, so a `user:`
scope that two servers claim answers the first writable one, not `conflict`. -/
theorem personal_two_servers_not_conflict :
    let a : Entry Nat Nat Nat := ⟨1, some 10, false, none⟩
    let b : Entry Nat Nat Nat := ⟨1, some 11, false, none⟩
    resolve (fun _ => true) (fun _ => none) 1 [a, b] = .remote a true ∧ TwoServers 1 [a, b] :=
  ⟨by decide, (two_le_servers_iff 1 _).mp (by decide)⟩

/-! ### Endpoint identity (Codex round 3, finding 2)

Everything above groups by `U`, the endpoint identity. The config holds the user's spellings
`R`; the code maps each to its identity with `normalizeEndpointUrl` (URL-parsed: scheme and host
case-folded, default port dropped, userinfo removed, base path kept less a trailing `/sse` and
slash). Here that map is an arbitrary `canon : R → U`, so the theorems hold for any identity
function, and the counterexample shows what grouping by the raw spelling (`canon = id`) did. -/

structure RawEntry (S R O : Type) where
  scope    : S
  url      : Option R      -- the url as written in config.yaml; `none` = a path store
  readonly : Bool
  org      : Option O
deriving DecidableEq

/-- The entry the resolver sees: the url replaced by its identity, nothing else changed. -/
def RawEntry.ident {R : Type} (canon : R → U) (e : RawEntry S R O) : Entry S U O :=
  ⟨e.scope, e.url.map canon, e.readonly, e.org⟩

/-- Two exact-scope url entries whose spellings have different identities. -/
def TwoServersRaw {R : Type} (canon : R → U) (s : S) (l : List (RawEntry S R O)) : Prop :=
  ∃ e₁ ∈ l, ∃ e₂ ∈ l, e₁.scope = s ∧ e₂.scope = s ∧ e₁.url.isSome ∧ e₂.url.isSome ∧
    e₁.url.map canon ≠ e₂.url.map canon

/-- FIXED (Codex round 3, finding 2): outside the personal rule, `conflict` exactly when two
exact-scope entries name servers with different IDENTITIES — never because two spellings of
one server differ as strings. -/
theorem conflict_iff_identity {R : Type} (canon : R → U) (personal : S → Bool)
    (orgOf : S → Option O) (s : S) (l : List (RawEntry S R O))
    (hp : personalHit personal s (l.map (RawEntry.ident canon)) = false) :
    (∃ xs, resolve personal orgOf s (l.map (RawEntry.ident canon)) = .conflict xs) ↔
      TwoServersRaw canon s l := by
  rw [conflict_iff personal orgOf s _ hp]
  constructor
  · rintro ⟨e₁, h1, e₂, h2, hs1, hs2, hu1, hu2, hne⟩
    obtain ⟨r₁, hr1, rfl⟩ := List.mem_map.mp h1
    obtain ⟨r₂, hr2, rfl⟩ := List.mem_map.mp h2
    simp only [RawEntry.ident, Option.isSome_map] at hs1 hs2 hu1 hu2 hne
    exact ⟨r₁, hr1, r₂, hr2, hs1, hs2, hu1, hu2, hne⟩
  · rintro ⟨r₁, hr1, r₂, hr2, hs1, hs2, hu1, hu2, hne⟩
    exact ⟨r₁.ident canon, List.mem_map_of_mem hr1, r₂.ident canon, List.mem_map_of_mem hr2,
      hs1, hs2, by simp [RawEntry.ident, hu1], by simp [RawEntry.ident, hu2], hne⟩

/-- Spellings of one server never conflict: when every exact-scope url entry's identity is
`u`, the resolver does not answer `conflict`, however differently the urls are written. -/
theorem one_identity_no_conflict {R : Type} (canon : R → U) (personal : S → Bool)
    (orgOf : S → Option O) (s : S) (l : List (RawEntry S R O)) (u : U)
    (hp : personalHit personal s (l.map (RawEntry.ident canon)) = false)
    (h : ∀ e ∈ l, e.scope = s → ∀ r, e.url = some r → canon r = u) :
    ¬ ∃ xs, resolve personal orgOf s (l.map (RawEntry.ident canon)) = .conflict xs := by
  rw [conflict_iff_identity canon personal orgOf s l hp]
  rintro ⟨r₁, hr1, r₂, hr2, hs1, hs2, hu1, hu2, hne⟩
  obtain ⟨a, ha⟩ := Option.isSome_iff_exists.mp hu1
  obtain ⟨b, hb⟩ := Option.isSome_iff_exists.mp hu2
  apply hne
  rw [ha, hb]
  simp [h r₁ hr1 hs1 a ha, h r₂ hr2 hs2 b hb]

/-- REPLAYED counterexample (pre-fix): spellings 10 and 11 of one server (identity `n / 10`,
e.g. `https://plur.example.com` and `https://plur.example.com:443`). Grouping by the raw
spelling (`canon = id`) reports a conflict, so the save is refused; grouping by identity
routes it to the server. -/
theorem raw_spelling_grouping_conflicts :
    let l : List (RawEntry Nat Nat Nat) := [⟨1, some 10, false, none⟩, ⟨1, some 11, false, none⟩]
    let no : Nat → Bool := fun _ => false
    resolve no (fun _ => none) 1 (l.map (RawEntry.ident id)) = .conflict [10, 11] ∧
    resolve no (fun _ => none) 1 (l.map (RawEntry.ident (· / 10))) =
      .remote ⟨1, some 1, false, none⟩ true := by decide

/-- Non-vacuity: different identities (another port or base path) still conflict. -/
theorem distinct_identities_conflict :
    let l : List (RawEntry Nat Nat Nat) := [⟨1, some 10, false, none⟩, ⟨1, some 20, false, none⟩]
    resolve (fun _ => false) (fun _ => none) 1 (l.map (RawEntry.ident (· / 10))) =
      .conflict [1, 2] := by decide

/-! ## 2. The leak guard and the write paths (candidate 1) -/

theorem find?_congr' {α : Type} {p q : α → Bool} : ∀ {l : List α},
    (∀ x ∈ l, p x = q x) → l.find? p = l.find? q
  | [], _ => rfl
  | x :: xs, h => by
    simp only [List.find?_cons, h x (by simp)]
    rw [find?_congr' (fun y hy => h y (by simp [hy]))]

/-- `_resolveRemoteStoreForScope`: a driver only for `remote && writable` (a conflict throws). -/
def route (personal : S → Bool) (orgOf : S → Option O) (s : S) (l : List (Entry S U O)) :
    Option (Entry S U O) :=
  match resolve personal orgOf s l with
  | .remote e true => some e
  | _ => none

/-- The outbox flush's store (index.ts `routeFor`): after the conflict hold, the first
writable url entry with exactly the queued scope. `target_url` is not consulted. -/
def flushPick (personal : S → Bool) (orgOf : S → Option O) (s : S) (l : List (Entry S U O)) :
    Option (Entry S U O) :=
  match resolve personal orgOf s l with
  | .conflict _ => none
  | _ => l.find? (fun e => e.url.isSome && decide (e.scope = s) && !e.readonly)

/-- The scan gate (`_offendingHitsForScope`: shared scope OR `_hasUrlStoreForScope`). -/
def scanGate (shared : S → Bool) (s : S) (l : List (Entry S U O)) : Bool :=
  shared s || !(servers s l).isEmpty

/-- Every url entry that names `s` exactly opens the scan gate for `s`. -/
theorem gate_open (shared : S → Bool) (s : S) (l : List (Entry S U O)) (e : Entry S U O)
    (he : e ∈ l) (hs : e.scope = s) (hu : e.url.isSome) : scanGate shared s l = true := by
  obtain ⟨u, hu'⟩ := Option.isSome_iff_exists.mp hu
  have := (mem_servers s l u).mpr ⟨e, he, hs, hu'⟩
  unfold scanGate
  cases h : servers s l with
  | nil => rw [h] at this; simp at this
  | cons _ _ => simp

/-- A guarded write path: the scan runs first and a hit keeps the write on this machine;
otherwise the path's own choice of entry (`choose`) is dialled. -/
def guarded (shared : S → Bool) (hit : Bool) (choose : S → List (Entry S U O) → Option (Entry S U O))
    (s : S) (l : List (Entry S U O)) : Option (Entry S U O) :=
  if scanGate shared s l && hit then none else choose s l

/-- The leak guard, for ANY write path whose chosen entry is an exact-scope url entry
(router, outbox flush, update walk, rescope): content the scan flags never leaves. -/
theorem no_flagged_content_leaves (shared : S → Bool) (hit : Bool)
    (choose : S → List (Entry S U O) → Option (Entry S U O))
    (hc : ∀ s l e, choose s l = some e → e ∈ l ∧ e.scope = s ∧ e.url.isSome)
    (s : S) (l : List (Entry S U O)) (e : Entry S U O) (h : guarded shared hit choose s l = some e) :
    hit = false := by
  unfold guarded at h
  obtain ⟨he, hs, hu⟩ := hc s l e (by split at h <;> first | exact h | cases h)
  rw [gate_open shared s l e he hs hu] at h
  cases hit
  · rfl
  · simp at h

theorem route_exact (personal : S → Bool) (orgOf : S → Option O) :
    ∀ (s : S) (l : List (Entry S U O)) (e : Entry S U O), route personal orgOf s l = some e → e ∈ l ∧ e.scope = s ∧ e.url.isSome := by
  intro s l e h
  unfold route at h
  split at h
  · rename_i e' hr
    cases h
    have := remote_is_exact_url personal orgOf s l _ _ hr
    exact ⟨this.1, this.2.1, this.2.2.1⟩
  · cases h

theorem flushPick_exact (personal : S → Bool) (orgOf : S → Option O) :
    ∀ (s : S) (l : List (Entry S U O)) (e : Entry S U O), flushPick personal orgOf s l = some e → e ∈ l ∧ e.scope = s ∧ e.url.isSome := by
  intro s l e h
  unfold flushPick at h
  split at h
  · cases h
  · have hp := List.find?_some h
    simp at hp
    exact ⟨List.mem_of_find?_eq_some h, hp.1.2, hp.1.1⟩

/-- The router dials only an entry the resolver answered `remote`, writable, for. -/
theorem route_only_remote (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (e : Entry S U O) (h : route personal orgOf s l = some e) :
    resolve personal orgOf s l = .remote e true := by
  unfold route at h; split at h
  · rename_i hr; cases h; exact hr
  · cases h

/-- Outside the personal rule, the flush and the router dial the same entry. -/
theorem flush_agrees_with_router (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (hp : personalHit personal s l = false) (e : Entry S U O)
    (h : route personal orgOf s l = some e) : flushPick personal orgOf s l = some e := by
  have hr := route_only_remote personal orgOf s l e h
  unfold flushPick; rw [hr]; simp only
  unfold resolve at hr; rw [hp] at hr; simp only [Bool.false_eq_true, ite_false] at hr
  match hs : servers s l, hr with
  | u :: v :: rest, hr => cases hr
  | [], hr => revert hr; simp only; split <;> (try split) <;> (try split) <;> simp
  | [u], hr =>
    simp only at hr
    unfold remoteOf at hr
    split at hr
    · rename_i a ha
      simp at hr; subst hr
      -- every exact url entry is on server `u`
      have hall : ∀ x ∈ l, x.scope = s → x.url.isSome → x.url = some u := by
        intro x hx hsx hux
        obtain ⟨w, hw⟩ := Option.isSome_iff_exists.mp hux
        have := (mem_servers s l w).mpr ⟨x, hx, hsx, hw⟩
        rw [hs] at this; simp at this; rw [hw, this]
      unfold group at ha
      rw [List.find?_filter] at ha
      rw [← ha]
      apply find?_congr'
      intro x hx
      by_cases hsx : x.scope = s
      · cases hux : x.url with
        | none => simp [hsx, hux]
        | some w =>
          have := hall x hx hsx (by simp [hux]); rw [hux] at this
          simp [hsx, hux, this]
      · simp [hsx]
    · split at hr <;> cases hr

/-- REPLAYED counterexample (NEEDS-OWNER Q2): a personal row queued for the url store is
pushed by the flush after a path store took the same scope, while the resolver (and so the
router and the delivery report) now answers `local`. -/
theorem flush_pushes_when_local :
    let p : Entry Nat Nat Nat := ⟨1, none, false, none⟩
    let a : Entry Nat Nat Nat := ⟨1, some 10, false, none⟩
    resolve (fun _ => true) (fun _ => none) 1 [p, a] = .local (some p) ∧
    flushPick (fun _ => true) (fun _ => none) 1 [p, a] = some a := by decide

/-- REPLAYED counterexample (NEEDS-OWNER Q3): a row queued for server 10 is pushed to server
11 once 11 replaced 10 for the same scope — `target_url` is never read. -/
theorem flush_ignores_target_url :
    let b : Entry Nat Nat Nat := ⟨1, some 11, false, none⟩
    flushPick (fun _ => false) (fun _ => none) 1 [b] = some b ∧ b.url ≠ some 10 := by decide

/-- `_reconcileQueuedScope` (fixed this round, D6): where an update that moves a queued row
retargets it. `none` = the update is refused (ScopeConflictError) before anything is written;
`some none` = the delivery is cancelled. -/
def retarget (personal : S → Bool) (orgOf : S → Option O) (s : S) (l : List (Entry S U O)) :
    Option (Option (Entry S U O)) :=
  match resolve personal orgOf s l with
  | .conflict _ => none
  | .remote e true => some (some e)
  | _ => some none

/-- Pre-fix: the first writable url entry with the scope (no conflict check). -/
def retargetOld (s : S) (l : List (Entry S U O)) : Option (Entry S U O) :=
  l.find? (fun e => e.url.isSome && decide (e.scope = s) && !e.readonly)

/-- D6: a queued row is retargeted only to the entry the router would dial, and never into a
scope two servers claim. -/
theorem retarget_is_router (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (e : Entry S U O)
    (h : retarget personal orgOf s l = some (some e)) : route personal orgOf s l = some e := by
  unfold retarget at h; unfold route
  split at h
  · cases h
  · rename_i hr; rw [hr]; cases h; rfl
  · cases h

theorem retarget_refuses_conflict (personal : S → Bool) (orgOf : S → Option O) (s : S)
    (l : List (Entry S U O)) (hp : personalHit personal s l = false) (h2 : TwoServers s l) :
    retarget personal orgOf s l = none := by
  obtain ⟨xs, hx⟩ := (conflict_iff personal orgOf s l hp).mpr h2
  unfold retarget; rw [hx]

/-- REPLAYED (pre-fix): moving a queued row into a conflicted scope retargeted it to the
first-listed server. -/
theorem old_retarget_picks_first :
    let a : Entry Nat Nat Nat := ⟨1, some 11, false, none⟩
    let b : Entry Nat Nat Nat := ⟨1, some 10, false, none⟩
    retargetOld 1 [a, b] = some a ∧ retarget (fun _ => false) (fun _ => none) 1 [a, b] = none := by
  decide

/-! ## 3. acceptDiscoveredScopes (candidate 2) -/

inductive ServerStatus where | ok | notSynced | absent
deriving DecidableEq

inductive Status where | ok | notSynced | failed | authFailed | degraded
deriving DecidableEq

structure Me (S O : Type) where
  org    : Option O        -- `none` = empty org_id
  status : ServerStatus
  scopes : List S
  /-- `!scopes_malformed`: the body's `scopes` was an array whose every member passed the
  grammar (an explicit `[]` included). Missing, null, non-array or any rejected member is
  `false` (remote-store.ts `me()`, Codex round 2 finding 2). -/
  wellFormed : Bool := true

structure Acc (S : Type) where
  status  : Status
  replace : Bool
  scopes  : List S
deriving DecidableEq

/-- `filterScopes`: inside the org (`orgRejection` null) and not served by another server. -/
def filt (inOrg : O → S → Bool) (claimed : S → Bool) (m : Me S O) : List S :=
  m.scopes.filter (fun x => match m.org with
    | some o => inOrg o x && !claimed x
    | none => false)

/-- `acceptDiscoveredScopes` (server-discovery.ts). A malformed scope list is checked first. `err = some auth` is a thrown
answer, `auth` = its status was 401/403. -/
def accept (inOrg : O → S → Bool) (claimed : S → Bool) (me : Option (Me S O))
    (err : Option Bool) (cached : List S) : Acc S :=
  let keep := fun st => ({ status := st, replace := false, scopes := cached } : Acc S)
  let empty := fun st => ({ status := st, replace := true, scopes := [] } : Acc S)
  match err, me with
  | some auth, _ => keep (if auth then .authFailed else .failed)
  | none, none => keep .failed
  | none, some m =>
    if !m.wellFormed then
      (if cached.isEmpty then empty .degraded else keep .degraded)
    else if m.org.isNone && m.status ≠ .notSynced then
      (if cached.isEmpty then empty .degraded else keep .degraded)
    else match m.status with
      | .ok => { status := .ok, replace := true, scopes := filt inOrg claimed m }
      | .notSynced => if cached.isEmpty then empty .notSynced else keep .notSynced
      | .absent =>
        if !m.scopes.isEmpty then { status := .ok, replace := true, scopes := filt inOrg claimed m }
        else if cached.isEmpty then empty .degraded else keep .degraded

/-- Candidate 2: only an error-free `ok` answer that names an org ever replaces a non-empty
cache; a failed, unauthorised, not-synced, degraded or org-less answer never does. -/
theorem nonempty_cache_replaced_only_by_ok (inOrg : O → S → Bool) (claimed : S → Bool)
    (me : Option (Me S O)) (err : Option Bool) (cached : List S) (hc : cached ≠ [])
    (h : (accept inOrg claimed me err cached).replace = true) :
    (accept inOrg claimed me err cached).status = .ok ∧ err = none ∧
      ∃ m, me = some m ∧ m.org.isSome := by
  have hce : cached.isEmpty = false := by cases cached <;> simp_all
  unfold accept at h ⊢
  match err, me with
  | some auth, _ => simp at h
  | none, none => simp at h
  | none, some m =>
    simp only at h ⊢
    cases hw : m.wellFormed
    · simp [hw, hce] at h
    simp only [hw, Bool.not_true, Bool.false_eq_true, ite_false] at h ⊢
    by_cases hd : m.org.isNone && decide (m.status ≠ .notSynced)
    · simp only [hd, ite_true, hce] at h; simp at h
    · simp only [hd, ite_false] at h ⊢
      have horg : m.status ≠ .notSynced → m.org.isSome := by
        intro hn; cases ho : m.org <;> simp_all
      cases hs : m.status with
      | ok => simp [hs] at horg; simp [hs, horg]
      | notSynced => simp [hs, hce] at h
      | absent =>
        simp only [hs] at h ⊢
        by_cases he : m.scopes.isEmpty
        · simp [he, hce] at h
        · simp [hs] at horg; simp [he, horg]

/-- Candidate 2: a kept cache is the cache, unchanged. -/
theorem kept_is_cached (inOrg : O → S → Bool) (claimed : S → Bool) (me : Option (Me S O))
    (err : Option Bool) (cached : List S) (h : (accept inOrg claimed me err cached).replace = false) :
    (accept inOrg claimed me err cached).scopes = cached := by
  unfold accept at h ⊢
  match err, me with
  | some _, _ => rfl
  | none, none => rfl
  | none, some m =>
    simp only at h ⊢
    cases hw : m.wellFormed
    · simp only [hw, Bool.not_false, ite_true] at h ⊢; split <;> simp_all
    simp only [hw, Bool.not_true, Bool.false_eq_true, ite_false] at h ⊢
    split
    · split <;> simp_all
    · rename_i hd; simp only [hd, ite_false] at h
      cases hs : m.status <;> simp only [hs] at h ⊢
      · simp at h
      · split <;> simp_all
      · split
        · simp_all
        · split <;> simp_all

/-- Candidate 2: every accepted scope is one the server listed, inside its org, and not
served by another server. -/
theorem accepted_within_org (inOrg : O → S → Bool) (claimed : S → Bool) (me : Option (Me S O))
    (err : Option Bool) (cached : List S) (x : S)
    (h : (accept inOrg claimed me err cached).replace = true)
    (hx : x ∈ (accept inOrg claimed me err cached).scopes) :
    ∃ m o, me = some m ∧ m.org = some o ∧ x ∈ m.scopes ∧ inOrg o x = true ∧ claimed x = false := by
  have key : ∀ m : Me S O, x ∈ filt inOrg claimed m →
      ∃ o, m.org = some o ∧ x ∈ m.scopes ∧ inOrg o x = true ∧ claimed x = false := by
    intro m hm
    unfold filt at hm; rw [List.mem_filter] at hm
    obtain ⟨hm, hp⟩ := hm
    cases ho : m.org with
    | none => rw [ho] at hp; simp at hp
    | some o => rw [ho] at hp; simp at hp; exact ⟨o, rfl, hm, hp.1, hp.2⟩
  unfold accept at h hx
  match err, me with
  | some _, _ => simp at h
  | none, none => simp at h
  | none, some m =>
    simp only at h hx
    cases hw : m.wellFormed
    · simp only [hw, Bool.not_false, ite_true] at h hx; split at hx <;> simp_all
    simp only [hw, Bool.not_true, Bool.false_eq_true, ite_false] at h hx
    split at hx
    · split at hx <;> simp_all
    · rename_i hd
      simp only [hd, ite_false] at h
      cases hs : m.status <;> simp only [hs] at h hx
      · obtain ⟨o, h1, h2, h3, h4⟩ := key m hx; exact ⟨m, o, rfl, h1, h2, h3, h4⟩
      · split at hx <;> simp_all
      · split at hx
        · obtain ⟨o, h1, h2, h3, h4⟩ := key m hx; exact ⟨m, o, rfl, h1, h2, h3, h4⟩
        · split at hx <;> simp_all

/-- Non-vacuity: an `ok` answer replaces a non-empty cache with the in-org scopes; the same
answer without an org keeps it (owner decision 16). -/
theorem accept_reachable :
    let inOrg : Nat → Nat → Bool := fun o x => decide (x / 10 = o)
    let m : Me Nat Nat := ⟨some 1, .ok, [10, 21, 12], true⟩
    accept inOrg (fun _ => false) (some m) none [99] = ⟨.ok, true, [10, 12]⟩ ∧
    accept inOrg (fun _ => false) (some { m with org := none }) none [99] = ⟨.degraded, false, [99]⟩ := by
  decide

/-- Codex round 2 finding 2 FIXED: a malformed scope list (`scopes` missing, null, not an array
or with a rejected member) never replaces a non-empty cache, whatever `scopes_status` says.
Before the fix `me()` turned it into `[]` and an `ok` answer cleared the cache. -/
theorem malformed_keeps_cache (inOrg : O → S → Bool) (claimed : S → Bool) (m : Me S O)
    (cached : List S) (hw : m.wellFormed = false) (hc : cached ≠ []) :
    accept inOrg claimed (some m) none cached = ⟨.degraded, false, cached⟩ := by
  have hce : cached.isEmpty = false := by cases cached <;> simp_all
  simp [accept, hw, hce]

/-- Non-vacuity: an explicit, well-formed `[]` with `ok` is the valid clearing case (plan B
Task 4 table); the same answer marked malformed keeps the cache. -/
theorem malformed_reachable :
    let inOrg : Nat → Nat → Bool := fun o x => decide (x / 10 = o)
    accept inOrg (fun _ => false) (some ⟨some 1, .ok, [], true⟩) none [99] = ⟨.ok, true, []⟩ ∧
    accept inOrg (fun _ => false) (some ⟨some 1, .ok, [], false⟩) none [99] = ⟨.degraded, false, [99]⟩ := by
  decide

/-! ## 4. The cache write of refreshServerScopes (candidate 3) -/

/-- One server entry's cache as the write sees it: `body` is everything but the two stamps
(`scope`, `scopes`, the other `discovery` fields; abstract). -/
structure Cache (B : Type) where
  body     : B
  discAt   : Option Nat
  checkAt  : Option Nat
deriving DecidableEq

def DAY : Nat := 24 * 60 * 60 * 1000

/-- `discoveryChanged`'s stamp test: the stamp is missing, unparsable, in the future or a day old. -/
def stale (prev : Option Nat) (now : Nat) : Bool :=
  match prev with
  | none => true
  | some t => decide (t > now) || decide (now - t ≥ DAY)

variable {B : Type} [DecidableEq B]

/-- The next cache for one answer: an accepted answer writes the new body and both stamps; a
refused one refreshes only the status (inside `body`) and `checked_at`. -/
def nextCache (replace : Bool) (newBody : B) (refusedBody : B → B) (c : Cache B) (now : Nat) : Cache B :=
  if replace then ⟨newBody, some now, some now⟩
  else ⟨refusedBody c.body, c.discAt, some now⟩

/-- `discoveryChanged`: anything but the stamps differs, or the stamp this answer refreshes is stale. -/
def wcond (replace : Bool) (newBody : B) (refusedBody : B → B) (c : Cache B) (now : Nat) : Bool :=
  decide ((nextCache replace newBody refusedBody c now).body ≠ c.body) ||
    stale (if replace then c.discAt else c.checkAt) now

/-- What is on disk after the locked step: written only when `discoveryChanged`. -/
def written (replace : Bool) (newBody : B) (refusedBody : B → B) (c : Cache B) (now : Nat) : Cache B :=
  if wcond replace newBody refusedBody c now then nextCache replace newBody refusedBody c now else c

/-- Candidate 3: a refused answer never touches `discovered_at`. -/
theorem refused_keeps_discovered_at (newBody : B) (refusedBody : B → B) (c : Cache B) (now : Nat) :
    (written false newBody refusedBody c now).discAt = c.discAt := by
  unfold written; split
  · simp [nextCache]
  · rfl

/-- Candidate 3: an unchanged answer whose stamp is fresh writes nothing at all. -/
theorem unchanged_fresh_writes_nothing (replace : Bool) (newBody : B) (refusedBody : B → B)
    (c : Cache B) (now : Nat)
    (hb : (nextCache replace newBody refusedBody c now).body = c.body)
    (hf : stale (if replace then c.discAt else c.checkAt) now = false) :
    written replace newBody refusedBody c now = c := by
  unfold written wcond; simp [hb, hf]

/-- Candidate 3: after a write at `t`, the same answer writes nothing again until a day has
passed — at most one timestamp-only write per 24 h. -/
theorem same_answer_within_a_day (replace : Bool) (newBody : B) (refusedBody : B → B)
    (hidem : ∀ b, refusedBody (refusedBody b) = refusedBody b)
    (c : Cache B) (t t' : Nat) (ht : t ≤ t') (hd : t' - t < DAY)
    (hw : written replace newBody refusedBody c t ≠ c) :
    let c1 := written replace newBody refusedBody c t
    written replace newBody refusedBody c1 t' = c1 := by
  intro c1
  have hc1 : c1 = nextCache replace newBody refusedBody c t := by
    show written replace newBody refusedBody c t = _
    unfold written at hw ⊢
    cases h : wcond replace newBody refusedBody c t <;> simp_all
  apply unchanged_fresh_writes_nothing
  · rw [hc1]; unfold nextCache; cases replace <;> simp [hidem]
  · rw [hc1]; unfold nextCache stale
    have : ¬ (t > t') := by omega
    have : ¬ (t' - t ≥ DAY) := by omega
    cases replace <;> simp_all

/-- Non-vacuity: the first answer writes; a stale stamp writes again. -/
theorem refresh_reachable :
    written true 5 id (⟨4, some 0, some 0⟩ : Cache Nat) 1 = ⟨5, some 1, some 1⟩ ∧
    written true 4 id (⟨4, some 0, some 0⟩ : Cache Nat) DAY = ⟨4, some DAY, some DAY⟩ ∧
    written true 4 id (⟨4, some 0, some 0⟩ : Cache Nat) 1 = ⟨4, some 0, some 0⟩ := by decide

/-! ### Which entry an answer is written to (D4; credential binding, Codex round 2 finding 1)

An entry is abstracted to its identity: the normalized url and the credential revision the
request used (`credentialRevision` in index.ts: the source, `token` or `token_env:<NAME>`, plus
a sha256 fingerprint of the resolved token; never the token). `p` is the entry as read before
the request; `l` is the `stores` list as it is under the config lock, which another process may
have changed in between in any way. Nothing is assumed about `l`. -/

structure Srv (U : Type) where
  url  : U
  cred : Nat
deriving DecidableEq

/-- Before D4: the first server entry with the answer's url. -/
def targetOld (l : List (Srv U)) (u : U) : Option (Srv U) := l.find? (fun e => decide (e.url = u))

/-- D4: only when exactly one server entry has that url; otherwise nothing is written. -/
def targetNew (l : List (Srv U)) (u : U) : Option (Srv U) :=
  if (l.filter (fun e => decide (e.url = u))).length = 1 then l.find? (fun e => decide (e.url = u))
  else none

/-- Finding 1 fixed: the single entry on the url must still carry the credential revision the
request was made with; otherwise the answer is discarded ("entry changed during refresh"). -/
def targetBound (l : List (Srv U)) (p : Srv U) : Option (Srv U) :=
  match targetNew l p.url with
  | some e => if e.cred = p.cred then some e else none
  | none => none

/-- FIXED (D4 + finding 1): an answer obtained with `p`'s url and credential is written to an
entry with that same url and credential, or to nothing — whatever happened to the list while
the request was in flight. (The pre-fix theorem needed `p ∈ l`, which the code did not
establish: the entry could be rotated in between.) -/
theorem answer_lands_on_its_entry (l : List (Srv U)) (p e : Srv U)
    (h : targetBound l p = some e) : e = p := by
  unfold targetBound at h
  split at h
  · rename_i e' he'
    split at h
    · rename_i hc
      cases h
      unfold targetNew at he'
      split at he'
      · have hu := List.find?_some he'; simp at hu
        cases e; cases p; simp_all
      · cases he'
    · cases h
  · cases h

/-- REPLAYED (pre-D4): bob's answer (credential 2) lands on alice's entry (credential 1). -/
theorem old_answer_mistargets :
    targetOld [(⟨10, 1⟩ : Srv Nat), ⟨10, 2⟩] 10 = some ⟨10, 1⟩ ∧
    targetNew [(⟨10, 1⟩ : Srv Nat), ⟨10, 2⟩] 10 = none := by decide

/-- REPLAYED (finding 1, pre-fix): alice's request (credential 1) was in flight when the entry
was rotated to credential 2; the url-only target writes alice's answer onto the rotated entry,
the bound target discards it. -/
theorem rotated_answer_mistargets :
    targetNew [(⟨10, 2⟩ : Srv Nat)] 10 = some ⟨10, 2⟩ ∧
    targetBound [(⟨10, 2⟩ : Srv Nat)] ⟨10, 1⟩ = none := by decide

/-- Non-vacuity: an unchanged entry still receives its answer. -/
theorem target_good_case :
    targetBound [(⟨10, 1⟩ : Srv Nat), ⟨11, 2⟩] ⟨11, 2⟩ = some ⟨11, 2⟩ := by decide

end PlurSpec.RoutingDiscovery
