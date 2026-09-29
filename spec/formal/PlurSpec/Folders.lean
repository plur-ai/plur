/-!
# Folders — the folder map (#1347): policy, fail-closed trust, dual-write, nonces

Covers `packages/core/src/folders.ts` and `packages/core/src/trust.ts` (with
`canonicalize` from `project-config.ts` and the remote gate of
`project-remote.ts`). Design note r3 (docs/specs/2026-09-28-folder-map-design.md
on docs/field-report-triage) and owner decision D1 "ignore-ask" (2026-09-29).

Path matching (globs, `~`, win32 case folding) is abstracted: each map entry
carries whether it covers the folder under the loose match `off` uses and under
the fail-closed match everything else uses, plus whether it covers the
directory the `.plur.yaml` lives in. §2 models the fail-closed compare itself on
segment lists. Replays: packages/core/test/formal-fr-c4-folders.test.ts.
-/

namespace PlurSpec.Folders

/-! ## 1. `resolveFolderPolicy`, branch for branch -/

inductive Mode | on | off | ask deriving DecidableEq, Repr
inductive Source | map | plurYaml | mcpConfig | dflt deriving DecidableEq, Repr

structure Entry where
  plur    : Option Mode
  scope   : Option String
  trusted : Bool
  lax     : Bool   -- `entryCovers(e, lax, home, true)`  (the `off` test)
  strict  : Bool   -- `entryCovers(e, strict, home, false)`
  cfgDir  : Bool   -- strict-covers `dirname(configPath)` (the trust test)
  spec    : Nat    -- `folderPatternSpecificity`, flattened lexicographically
deriving DecidableEq

/-- The fail-closed forms are a subset of the loose ones, and the canonical target
is one of the loose targets (`lax = [strict[0], …]`), so strict ⇒ lax. -/
def WF (es : List Entry) : Prop := ∀ e ∈ es, e.strict = true → e.lax = true

/-- What a `.plur.yaml` found by `findProjectConfigPath` requests. -/
structure Yaml where
  scope     : Option String
  domain    : Option String
  remoteUrl : Bool
  remoteTok : Bool

structure Env where
  entries : List Entry
  yaml    : Option Yaml       -- `configPath` found (walk stops at `.git`)
  marker  : Option Source     -- `findPlurMarker` when there is no configPath

structure Policy where
  mode          : Mode
  scope         : Option String
  remoteAllowed : Bool
  source        : Source
  untrustedAsk  : Bool        -- `reason: 'untrusted-plur-yaml'`

/-- One step of `mostSpecific`'s scan: replace on `>=`, so a later entry wins a tie. -/
def pick (best : Option Entry) (e : Entry) : Option Entry :=
  match best with
  | none => some e
  | some b => if b.spec ≤ e.spec then some e else some b

/-- `mostSpecific`: the greatest specificity; a later entry wins a tie. -/
def mostSpecific (es : List Entry) : Option Entry := es.foldl pick none

def trustedCfg (es : List Entry) : Bool := es.any (fun e => e.trusted && e.cfgDir)
def requests (y : Yaml) : Bool := y.scope.isSome || y.domain.isSome || y.remoteUrl

def matching (es : List Entry) : List Entry := es.filter (·.strict)
def mapScope (es : List Entry) : Option String :=
  (mostSpecific ((matching es).filter (·.scope.isSome))).bind (·.scope)
def deciding (es : List Entry) : List Entry :=
  (matching es).filter (fun e => e.plur.isSome || e.scope.isSome || e.trusted)
def untrusted (env : Env) : Bool :=
  match env.yaml with
  | some y => requests y && !trustedCfg env.entries
  | none => false
def markerOf (env : Env) : Option Source :=
  match env.yaml with
  | some _ => some .plurYaml
  | none => env.marker
def hasOff (es : List Entry) : Bool := es.any (fun e => e.plur == some .off && e.lax)

/-- Step 4/5: the most specific deciding entry, else ask. -/
def step4 (es : List Entry) : Policy :=
  match mostSpecific (deciding es) with
  | some b =>
    let m := b.plur.getD .on
    ⟨m, if m == .on then mapScope es else none, false, .map, false⟩
  | none => ⟨.ask, none, false, .dflt, false⟩

/-- The remote gate (`resolveProjectRemoteFromConfig` with the map's trust check). -/
def remoteOf (env : Env) : Bool :=
  match env.yaml with
  | some y => y.remoteUrl && y.remoteTok && trustedCfg env.entries
  | none => false

/-- Step 2/3: a `.plur.yaml` (trusted or requesting nothing) or an MCP config. -/
def markerStep (env : Env) (src : Source) : Policy :=
  if !untrusted env then
    ⟨.on, mapScope env.entries <|> env.yaml.bind (·.scope), remoteOf env, src, false⟩
  else step4 env.entries

def resolve (env : Env) : Policy :=
  if hasOff env.entries then ⟨.off, none, false, .map, false⟩
  else if untrusted env && (deciding env.entries).isEmpty then ⟨.ask, none, false, .plurYaml, true⟩
  else match markerOf env with
    | some src => markerStep env src
    | none => step4 env.entries

theorem pick_cases (acc : Option Entry) (x y : Entry) (h : pick acc x = some y) :
    y = x ∨ acc = some y := by
  cases acc with
  | none => simp [pick] at h; exact Or.inl h.symm
  | some b =>
    simp only [pick] at h
    split at h
    · simp at h; exact Or.inl h.symm
    · simp at h; exact Or.inr (by rw [h])

theorem foldl_pick_mem (es : List Entry) : ∀ (l : List Entry) (acc : Option Entry),
    (∀ x, acc = some x → x ∈ es) → (∀ x ∈ l, x ∈ es) →
    ∀ r, l.foldl pick acc = some r → r ∈ es := by
  intro l
  induction l with
  | nil => intro acc hacc _ r hr; exact hacc r hr
  | cons x xs ih =>
    intro acc hacc hl r hr
    simp only [List.foldl_cons] at hr
    refine ih (pick acc x) ?_ (fun y hy => hl y (by simp [hy])) r hr
    intro y hy
    rcases pick_cases acc x y hy with e | e
    · subst e; exact hl y (by simp)
    · exact hacc y e

theorem mostSpecific_mem (es : List Entry) (b : Entry) (h : mostSpecific es = some b) : b ∈ es :=
  foldl_pick_mem es es none (by simp) (fun x hx => hx) b h

/-- A later entry wins a tie (design r2 §Resolution 4). -/
theorem tie_later_wins (a b : Entry) (h : a.spec = b.spec) : mostSpecific [a, b] = some b := by
  simp [mostSpecific, pick, h]

/-- **Off always wins**: any loosely matching `off` entry, whatever else the map,
the `.plur.yaml` or an MCP config says. -/
theorem off_wins (env : Env) (h : ∃ e ∈ env.entries, e.plur = some .off ∧ e.lax = true) :
    (resolve env).mode = .off := by
  have : hasOff env.entries = true := by
    obtain ⟨e, he, hp, hl⟩ := h
    exact List.any_eq_true.mpr ⟨e, he, by simp [hp, hl]⟩
  simp [resolve, this]

def offP : Policy := ⟨.off, none, false, .map, false⟩
def askUntrustedP : Policy := ⟨.ask, none, false, .plurYaml, true⟩

/-- The four ways `resolve` can answer (one per branch of the code). -/
theorem resolve_branches (env : Env) :
    (hasOff env.entries = true ∧ resolve env = offP) ∨
    (hasOff env.entries = false ∧ untrusted env = true ∧ (deciding env.entries).isEmpty = true ∧
      resolve env = askUntrustedP) ∨
    (hasOff env.entries = false ∧ (untrusted env && (deciding env.entries).isEmpty) = false ∧
      ∃ src, markerOf env = some src ∧ resolve env = markerStep env src) ∨
    (hasOff env.entries = false ∧ (untrusted env && (deciding env.entries).isEmpty) = false ∧
      markerOf env = none ∧ resolve env = step4 env.entries) := by
  by_cases ho : hasOff env.entries = true
  · exact Or.inl ⟨ho, by simp [resolve, ho, offP]⟩
  · have ho' : hasOff env.entries = false := by simpa using ho
    by_cases hq : (untrusted env && (deciding env.entries).isEmpty) = true
    · have hq' := hq
      simp only [Bool.and_eq_true] at hq'
      exact Or.inr (Or.inl ⟨ho', hq'.1, hq'.2, by simp [resolve, ho', hq'.1, hq'.2, askUntrustedP]⟩)
    · have hq' : (untrusted env && (deciding env.entries).isEmpty) = false := by simpa using hq
      cases hm : markerOf env with
      | some src =>
        exact Or.inr (Or.inr (Or.inl ⟨ho', hq', src, rfl, by simp [resolve, ho', hq', hm]⟩))
      | none =>
        exact Or.inr (Or.inr (Or.inr ⟨ho', hq', rfl, by simp [resolve, ho', hq', hm]⟩))

/-- Step 4 never answers `off` when the map is well formed and no loose `off`
matched: a deciding `off` entry matches strictly, hence loosely. -/
theorem step4_not_off (es : List Entry) (hwf : WF es) (ho : hasOff es = false) :
    (step4 es).mode ≠ .off := by
  unfold step4
  cases hm : mostSpecific (deciding es) with
  | none => simp
  | some b =>
    intro hb
    simp only at hb
    have hbm := mostSpecific_mem _ _ hm
    simp only [deciding, matching, List.mem_filter] at hbm
    have hlax := hwf b hbm.1.1 hbm.1.2
    have hoff : b.plur = some .off := by
      cases hp : b.plur with
      | none => simp [hp] at hb
      | some m => simp [hp] at hb; simp [hb]
    have : hasOff es = true := List.any_eq_true.mpr ⟨b, hbm.1.1, by simp [hoff, hlax]⟩
    simp [this] at ho

theorem step4_scope (es : List Entry) :
    ((step4 es).scope = none ∨ (step4 es).scope = mapScope es) ∧ (step4 es).remoteAllowed = false := by
  unfold step4
  cases mostSpecific (deciding es) with
  | none => simp
  | some b => simp only; split <;> simp

/-- And `off` comes only from such an entry. -/
theorem off_only_from_map (env : Env) (hwf : WF env.entries) (h : (resolve env).mode = .off) :
    ∃ e ∈ env.entries, e.plur = some .off ∧ e.lax = true := by
  rcases resolve_branches env with ⟨ho, _⟩ | ⟨_, _, _, hr⟩ | ⟨ho, _, src, _, hr⟩ | ⟨ho, _, _, hr⟩
  · obtain ⟨e, he, hp⟩ := List.any_eq_true.mp ho
    simp at hp
    exact ⟨e, he, hp.1, hp.2⟩
  · rw [hr] at h; simp [askUntrustedP] at h
  · rw [hr] at h
    unfold markerStep at h
    split at h
    · simp at h
    · exact absurd h (step4_not_off _ hwf ho)
  · rw [hr] at h; exact absurd h (step4_not_off _ hwf ho)

/-- **A map scope overrides a `.plur.yaml` hint** (trusted, or requesting nothing). -/
theorem map_scope_overrides_hint (env : Env) (y : Yaml) (s : String)
    (hy : env.yaml = some y) (hoff : hasOff env.entries = false)
    (ht : untrusted env = false) (hs : mapScope env.entries = some s) :
    (resolve env).mode = .on ∧ (resolve env).scope = some s := by
  simp [resolve, hoff, ht, markerOf, hy, hs, markerStep]

/-- Non-vacuity: with no map scope, a trusted hint applies as before. -/
theorem trusted_hint_applies (env : Env) (y : Yaml) (hy : env.yaml = some y)
    (hoff : hasOff env.entries = false) (ht : untrusted env = false)
    (hs : mapScope env.entries = none) : (resolve env).scope = y.scope := by
  simp [resolve, hoff, ht, markerOf, hy, hs, markerStep]

/-- **D1**: an untrusted `.plur.yaml`'s requests never apply — its scope is never
adopted (only a map scope can appear) and its remote is never allowed. -/
theorem untrusted_request_never_applies (env : Env) (hu : untrusted env = true) :
    ((resolve env).scope = none ∨ (resolve env).scope = mapScope env.entries) ∧
    (resolve env).remoteAllowed = false := by
  rcases resolve_branches env with ⟨_, hr⟩ | ⟨_, _, _, hr⟩ | ⟨_, _, src, _, hr⟩ | ⟨_, _, _, hr⟩
  · rw [hr]; simp [offP]
  · rw [hr]; simp [askUntrustedP]
  · rw [hr]; simp only [markerStep, hu, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
    exact step4_scope _
  · rw [hr]; exact step4_scope _

/-- **D1**: with no map decision for the folder, an untrusted request asks. -/
theorem untrusted_asks (env : Env) (hoff : hasOff env.entries = false)
    (hu : untrusted env = true) (hd : deciding env.entries = []) :
    (resolve env).mode = .ask ∧ (resolve env).untrustedAsk = true := by
  simp [resolve, hoff, hu, hd]

/-- **The remote is used only with a covering trusted entry**, and only when the
file names both a url and a token. -/
theorem remote_needs_trust (env : Env) (h : (resolve env).remoteAllowed = true) :
    ∃ y, env.yaml = some y ∧ y.remoteUrl = true ∧ y.remoteTok = true ∧
      ∃ e ∈ env.entries, e.trusted = true ∧ e.cfgDir = true := by
  have hro : remoteOf env = true → ∃ y, env.yaml = some y ∧ y.remoteUrl = true ∧ y.remoteTok = true ∧
      ∃ e ∈ env.entries, e.trusted = true ∧ e.cfgDir = true := by
    intro hr
    unfold remoteOf at hr
    cases hy : env.yaml with
    | none => simp [hy] at hr
    | some y =>
      simp only [hy, Bool.and_eq_true] at hr
      obtain ⟨⟨hu, hk⟩, ht⟩ := hr
      obtain ⟨e, he, hp⟩ := List.any_eq_true.mp ht
      simp at hp
      exact ⟨y, rfl, hu, hk, e, he, hp.1, hp.2⟩
  rcases resolve_branches env with ⟨_, hr⟩ | ⟨_, _, _, hr⟩ | ⟨_, _, src, _, hr⟩ | ⟨_, _, _, hr⟩
  · rw [hr] at h; simp [offP] at h
  · rw [hr] at h; simp [askUntrustedP] at h
  · rw [hr] at h
    unfold markerStep at h
    split at h
    · exact hro h
    · rw [(step4_scope _).2] at h; simp at h
  · rw [hr, (step4_scope _).2] at h; simp at h

/-! Non-vacuity on concrete folders (mirrored by the replay test). -/

def grant (sc : Option String) : Entry := ⟨none, sc, true, true, true, true, 5⟩
def teamYaml : Yaml := ⟨some "group:x/y", none, true, true⟩

/-- Trusted repo with a remote: on, its hint, the remote allowed. -/
theorem trusted_remote_example :
    let p := resolve ⟨[grant none], some teamYaml, none⟩
    p.mode = .on ∧ p.scope = some "group:x/y" ∧ p.remoteAllowed = true := by decide

/-- The same repo untrusted and unmapped: ask, nothing applied. -/
theorem untrusted_example :
    let p := resolve ⟨[], some teamYaml, none⟩
    p.mode = .ask ∧ p.scope = none ∧ p.remoteAllowed = false ∧ p.untrustedAsk = true := by decide

/-- Total and deterministic: `resolve` is a total function of (map, `.plur.yaml`,
marker); an unmapped, unmarked folder (including `$HOME`) asks. -/
theorem unmapped_asks : (resolve ⟨[], none, none⟩).mode = .ask := rfl

/-! ## 2. The fail-closed compare (`entryForms`, `isTrustedInMap`; #778, #1334)

A path is a list of segments; `real` is `canonicalize` on the current filesystem.
A literal entry covers itself and everything below it. The target is ALWAYS
canonical; a stored entry is compared as written (`strictForms`). The loose
forms `off` uses add the entry with its parent, and all of it, canonicalised. -/

abbrev Path := List Nat
def covers (p t : Path) : Bool := p.isPrefixOf t

def strictForms (_real : Path → Path) (p : Path) : List Path := [p]
def laxForms (real : Path → Path) (p : Path) : List Path :=
  [p, real p.dropLast ++ p.drop (p.length - 1), real p]

def trustedBy (forms : (Path → Path) → Path → List Path) (real : Path → Path)
    (grants : List Path) (dir : Path) : Bool :=
  grants.any (fun g => (forms real g).any (fun f => covers f (real dir)))

/-- The fail-closed check: some grant, AS STORED, is a prefix of the canonical target. -/
theorem strict_iff (real : Path → Path) (gs : List Path) (d : Path) :
    trustedBy strictForms real gs d = true ↔ ∃ g ∈ gs, g.isPrefixOf (real d) = true := by
  simp [trustedBy, strictForms, covers]

/-- Trust follows the real location: two spellings of one folder agree. -/
theorem link_invariant (forms : (Path → Path) → Path → List Path) (real : Path → Path)
    (gs : List Path) (d1 d2 : Path) (h : real d1 = real d2) :
    trustedBy forms real gs d1 = trustedBy forms real gs d2 := by
  simp [trustedBy, h]

/-- Non-vacuity: a grant recorded as the canonical path (what `plur trust` stores)
is trusted, and so is everything below it. -/
theorem canonical_grant_trusted (real : Path → Path) (gs : List Path) (d : Path)
    (h : real d ∈ gs) : trustedBy strictForms real gs d = true := by
  rw [strict_iff]; exact ⟨real d, h, List.isPrefixOf_iff_prefix.mpr (List.prefix_refl _)⟩

/-- Filesystems: `[1,2]` = the trusted `/home/work/repo`; `[9]` = a clone elsewhere. -/
def fs0 : Path → Path := id
/-- The trusted folder itself swapped for a link to the clone. -/
def fsTarget (p : Path) : Path := if [1, 2].isPrefixOf p then 9 :: p.drop 2 else p
/-- The trusted folder's PARENT `[1]` swapped for a link to `[8]`, where `[8,2]` is a clone. -/
def fsParent (p : Path) : Path := if [1].isPrefixOf p then 8 :: p.drop 1 else p

theorem granted_before_swap : trustedBy strictForms fs0 [[1, 2]] [1, 2] = true := by decide
/-- **Symlink swap, target**: refused by the fail-closed compare… -/
theorem swap_target_refused : trustedBy strictForms fsTarget [[1, 2]] [1, 2] = false := by decide
/-- …and ACCEPTED if the stored entry were resolved at compare time (the loose forms). -/
theorem swap_target_lax_accepts : trustedBy laxForms fsTarget [[1, 2]] [1, 2] = true := by decide
/-- **Symlink swap, parent**: refused for the old path and for the clone's own path… -/
theorem swap_parent_refused :
    trustedBy strictForms fsParent [[1, 2]] [1, 2] = false ∧
    trustedBy strictForms fsParent [[1, 2]] [8, 2] = false := by decide
/-- …and accepted by the loose forms (the parent canonicalised). -/
theorem swap_parent_lax_accepts : trustedBy laxForms fsParent [[1, 2]] [8, 2] = true := by decide

/-! ## 3. Trust dual-write (`setFolderEntry`, `clearFolderTrust`,
`removeLegacyTrustEntry`, `removeFolderEntry`, `trust.ts`)

A spelling of a folder: canonical (what the CLI records), `~`-relative (hand
written, kept as written by merges and the import), or another inert spelling
(mis-cased or through a link — `other`, which neither reader applies). The new
reader applies `canon` and `tilde`; the pre-#1347 reader and a re-import (after
folders.yaml is lost) turn every `trust.yaml` line back into a grant. The
invariant: every live `trust.yaml` grant is backed by a trusted map entry for the
same folder — otherwise a downgrade or a re-import revives a revoked grant. -/

inductive Form | canon | tilde | other deriving DecidableEq
structure Sp where
  folder : Nat
  form   : Form
deriving DecidableEq

structure St where
  map    : List (Sp × Bool)   -- (entry path, trusted)
  legacy : List Sp            -- trust.yaml

def live (s : Sp) : Bool := s.form != .other
/-- `findEntryIndex` / `clearFolderTrust`: the map entries a CLI edit of `f` names. -/
def mapIs (f : Nat) (s : Sp) : Bool := s.folder == f && live s
/-- `removeLegacyTrustEntryUnlocked`: `t === folder || t === raw || t === target` —
literal spellings only; for a shell-expanded folder that is the canonical one. -/
def legIs (f : Nat) (s : Sp) : Bool := s.folder == f && s.form == .canon

def Inv (st : St) : Prop :=
  ∀ s ∈ st.legacy, live s = true → ∃ p ∈ st.map, p.2 = true ∧ p.1.folder = s.folder

/-- Grant (`trustDirectory` / `set --trusted`): the entry keeps its spelling `sp`
(an existing exact entry's path, else the canonical key); both files get it. -/
def grantOp (sp : Sp) (st : St) : St :=
  ⟨(sp, true) :: st.map.filter (fun p => !mapIs sp.folder p.1), sp :: st.legacy⟩
/-- CODE `untrustDirectory`: clear in the map by folder, in trust.yaml by literal. -/
def untrustOp (f : Nat) (st : St) : St :=
  ⟨st.map.map (fun p => if mapIs f p.1 then (p.1, false) else p), st.legacy.filter (fun s => !legIs f s)⟩
/-- CODE `removeFolderEntry` (`plur folders rm`): the map only. -/
def rmOp (f : Nat) (st : St) : St := ⟨st.map.filter (fun p => !mapIs f p.1), st.legacy⟩
/-- Proposed: remove from trust.yaml by the map's own matcher, in both commands. -/
def untrustFix (f : Nat) (st : St) : St :=
  ⟨st.map.map (fun p => if mapIs f p.1 then (p.1, false) else p), st.legacy.filter (fun s => !mapIs f s)⟩
def rmFix (f : Nat) (st : St) : St :=
  ⟨st.map.filter (fun p => !mapIs f p.1), st.legacy.filter (fun s => !mapIs f s)⟩

theorem grant_keeps_inv (sp : Sp) (st : St) (h : Inv st) : Inv (grantOp sp st) := by
  intro s hs hl
  simp only [grantOp, List.mem_cons] at hs
  rcases hs with rfl | hs
  · exact ⟨(s, true), by simp [grantOp], rfl, rfl⟩
  · by_cases hf : s.folder = sp.folder
    · exact ⟨(sp, true), by simp [grantOp], rfl, hf.symm⟩
    · obtain ⟨p, hp, ht, hpf⟩ := h s hs hl
      refine ⟨p, ?_, ht, hpf⟩
      simp only [grantOp, List.mem_cons, List.mem_filter]
      right; refine ⟨hp, ?_⟩
      simp [mapIs, hpf, hf]

/-- After a grant both files carry it (the dual-write). -/
theorem grant_both (sp : Sp) (st : St) :
    (sp, true) ∈ (grantOp sp st).map ∧ sp ∈ (grantOp sp st).legacy := by simp [grantOp]

theorem untrust_fix_keeps_inv (f : Nat) (st : St) (h : Inv st) : Inv (untrustFix f st) := by
  intro s hs hl
  simp only [untrustFix, List.mem_filter] at hs
  obtain ⟨hs, hn⟩ := hs
  have hsf : s.folder ≠ f := by
    intro e; simp [mapIs, e, hl] at hn
  obtain ⟨p, hp, ht, hpf⟩ := h s hs hl
  refine ⟨p, ?_, ht, hpf⟩
  simp only [untrustFix, List.mem_map]
  exact ⟨p, hp, by simp [mapIs, hpf, hsf]⟩

theorem rm_fix_keeps_inv (f : Nat) (st : St) (h : Inv st) : Inv (rmFix f st) := by
  intro s hs hl
  simp only [rmFix, List.mem_filter] at hs
  obtain ⟨hs, hn⟩ := hs
  have hsf : s.folder ≠ f := by
    intro e; simp [mapIs, e, hl] at hn
  obtain ⟨p, hp, ht, hpf⟩ := h s hs hl
  refine ⟨p, ?_, ht, hpf⟩
  simp only [rmFix, List.mem_filter]
  exact ⟨hp, by simp [mapIs, hpf, hsf]⟩

/-- Both fixed revocations also leave the folder untrusted in the map. -/
theorem untrust_fix_revokes (f : Nat) (st : St) :
    ∀ p ∈ (untrustFix f st).map, mapIs f p.1 = true → p.2 = false := by
  intro p hp hm
  simp only [untrustFix, List.mem_map] at hp
  obtain ⟨q, _, rfl⟩ := hp
  by_cases hq : mapIs f q.1 = true
  · simp [hq]
  · simp [hq] at hm

def canonA : Sp := ⟨1, .canon⟩
def tildeA : Sp := ⟨1, .tilde⟩

/-- **CONFIRMED (replayed)**: `plur folders rm` of a trusted folder leaves the
`trust.yaml` grant with no map entry behind it. -/
theorem rm_breaks_inv : Inv (grantOp canonA ⟨[], []⟩) ∧ ¬ Inv (rmOp 1 (grantOp canonA ⟨[], []⟩)) := by
  refine ⟨grant_keeps_inv _ _ (by intro s hs; simp at hs), ?_⟩
  intro h
  obtain ⟨p, hp, _, _⟩ := h canonA (by decide) (by decide)
  simp [rmOp, grantOp, mapIs, live, canonA] at hp

/-- **CONFIRMED (replayed)**: a `~`-spelled grant survives `plur untrust` in
`trust.yaml` (the literal compare misses it) and the map no longer backs it. -/
theorem tilde_breaks_inv : ¬ Inv (untrustOp 1 (grantOp tildeA ⟨[], []⟩)) := by
  intro h
  obtain ⟨p, hp, ht, _⟩ := h tildeA (by decide) (by decide)
  simp [untrustOp, grantOp, mapIs, live, tildeA] at hp
  subst hp; simp at ht

/-- The fixes remove both. -/
theorem fixes_close_both :
    Inv (rmFix 1 (grantOp canonA ⟨[], []⟩)) ∧ Inv (untrustFix 1 (grantOp tildeA ⟨[], []⟩)) :=
  ⟨rm_fix_keeps_inv _ _ (grant_keeps_inv _ _ (by intro s hs; simp at hs)),
   untrust_fix_keeps_inv _ _ (grant_keeps_inv _ _ (by intro s hs; simp at hs))⟩

/-! ## 4. Nonces (`verifyFolderNonce`, `setFolderEntryUnlocked`, `removeFolderEntryUnlocked`)

A nonce names one folder. A write from the ask flow verifies it (unknown,
expired or another folder → refused, nothing written), saves folders.yaml, then
dual-writes trust.yaml, then consumes. -/

structure NS where
  nonces : Nat → Option Nat        -- nonce ↦ the folder it was issued for
  saved  : List (Nat × Nat)        -- saved folders.yaml writes: (nonce, folder)

inductive Res | ok | refused | failed deriving DecidableEq

def consume (s : NS) (n : Nat) : Nat → Option Nat := fun m => if m = n then none else s.nonces m

/-- CODE order: verify, save, legacy write, consume. -/
def writeCode (s : NS) (n f : Nat) (saveOk legacyOk : Bool) : NS × Res :=
  if s.nonces n = some f then
    if !saveOk then (s, .failed)
    else
      let s1 : NS := ⟨s.nonces, (n, f) :: s.saved⟩
      if !legacyOk then (s1, .failed) else (⟨consume s1 n, s1.saved⟩, .ok)
  else (s, .refused)

/-- Proposed: consume as soon as folders.yaml is saved. -/
def writeFix (s : NS) (n f : Nat) (saveOk legacyOk : Bool) : NS × Res :=
  if s.nonces n = some f then
    if !saveOk then (s, .failed)
    else (⟨consume s n, (n, f) :: s.saved⟩, if legacyOk then .ok else .failed)
  else (s, .refused)

/-- A nonce authorises writes for its own folder only: anything saved names it. -/
theorem nonce_one_folder (s : NS) (n f : Nat) (a b : Bool)
    (h : (writeCode s n f a b).1.saved ≠ s.saved) : s.nonces n = some f := by
  unfold writeCode at h
  split at h
  · assumption
  · exact absurd rfl h

/-- A refused (wrong folder / unknown) or failed-to-save write changes nothing —
the nonce is not burnt. -/
theorem refused_keeps_nonce (s : NS) (n f : Nat) (b : Bool) :
    (writeCode s n f false b).1.nonces = s.nonces ∧ (writeCode s n f false b).1.saved = s.saved := by
  unfold writeCode; split <;> simp

/-- Consumed only after a successful save. -/
theorem consumed_after_save (s : NS) (n f : Nat) (a b : Bool)
    (h : (writeCode s n f a b).1.nonces n ≠ s.nonces n) :
    (writeCode s n f a b).1.saved = (n, f) :: s.saved := by
  unfold writeCode at h ⊢
  split at h
  · cases a <;> cases b <;> simp_all
  · exact absurd rfl h

/-- Once (fixed order): after a saved write the nonce is gone, so any later write
with it — for any folder — is refused. -/
theorem fix_once (s : NS) (n f f' : Nat) (b a' b' : Bool)
    (h : s.nonces n = some f) :
    (writeFix (writeFix s n f true b).1 n f' a' b').2 = .refused := by
  simp [writeFix, h, consume]

/-- **CONFIRMED (replayed)**: in the code's order a failed trust.yaml write after
the map was saved leaves the nonce live, and a second write with it is saved too. -/
def ns0 : NS := ⟨fun m => if m = 7 then some 1 else none, []⟩
theorem legacy_fail_two_writes :
    ((writeCode (writeCode ns0 7 1 true false).1 7 1 true true).1.saved).length = 2 := by
  simp [writeCode, ns0]
theorem fix_one_write :
    ((writeFix (writeFix ns0 7 1 true false).1 7 1 true true).1.saved).length = 1 := by
  simp [writeFix, ns0, consume]

end PlurSpec.Folders
