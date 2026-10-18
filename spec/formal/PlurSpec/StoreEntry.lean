/-!
# PlurSpec.StoreEntry — server store entries: expand at load, collapse on writeback, rotation

Checked against #1631 (config.yaml owner-only, 2026-10-18): still holds. `persistStores`
and `_updateRawStores` write the same bytes under the same lock, now through
`writeConfigFile` (owner-only protection, modelled in Persistence §AtomicTemp); the
expand/collapse/rotation logic is unchanged.

Models of `packages/core/src/store-expand.ts` (expandServerEntry, collapseExpandedStores,
serverEntryIdentities), `packages/core/src/sensitivity-writeback.ts`
(mergeSensitivityForWriteback) and the store parts of `packages/core/src/index.ts`
(persistStores, addStore's server-entry rotation). Findings, verdicts and replays:
`spec/formal/findings/store-entry.md`. Checked against branch formal/epic-1797 (5a0dedc3)
plus the fix in this round (legacy top-level metadata is shape-checked), and owner decision 17
(2026-10-18, §3 `findIdFixed`: no write for an identity base two entries share).
§6 (2026-10-18, #1631 plan B Task 5): registration and the fold of per-scope entries
(`registerServerEntry`, `foldStoresIntoServerEntry` in server-discovery.ts,
`Plur.registerEnterpriseServer` in index.ts).

What is abstracted: metadata values are an arbitrary type `V` with a parse oracle `norm`
(`none` = the schema drops the value); the per-key writeback merge is an oracle `wb`. The
theorems hold for every oracle that satisfies the stated hypotheses, and §2 shows the
sensitivity merge satisfies them. Left out: YAML key order, `storeEntryForDisk`'s token_env
rule (#1561, modelled elsewhere), non-server entries in §3.

Rechecked after Codex audit rounds 3-5 on branch agent/efi-b05 (2026-10-18): still holds. The changes are
refusals and eligibility checks inside registerEnterpriseServer/registerServerEntry/foldStoresIntoServerEntry
(nothing is written on a refusal), the outbox read moved before the write, and config.ts's unset-token_env
warning naming the url by origin; no modelled branch changed.

Checked against #1631 background discovery (PR gate, 2026-10-18): still holds.
index.ts only adds `_serverDiscoveryEndpoints()`, a read of config.yaml that lists the
urls `refreshServerScopes` probes (the same `isEnterpriseServerEntry` filter). It
writes nothing and is read only by the MCP server; expand, collapse and rotation are untouched.
-/

set_option linter.deprecated false
set_option linter.unusedSimpArgs false
set_option linter.unusedSectionVars false

namespace PlurSpec.StoreEntry

/-! ## 1. Expand / collapse of one server entry's metadata (candidates 1 and 2)

`Disk` is one server entry on disk. `top k` is a top-level metadata key (written there by an
older client for the compat `scope`), `set s k` is `scope_settings[s][k]`. A present but
malformed value is `some w` with `norm k w = none`. -/

structure Disk (I K V : Type) where
  ident  : I                 -- url, token, token_env, readonly, scopes, … (never touched)
  compat : Option Nat
  top    : K → Option V
  set    : Nat → K → Option V

variable {I K V : Type} [DecidableEq K]

/-- The typed value of key `k` for scope `s` after load (store-expand.ts:91–100, fixed):
`{...legacy, ...settings}` where both sides went through the shape-tolerant schema
and undefined values were filtered out by `metadataOnly`. -/
def typed (norm : K → V → Option V) (d : Disk I K V) (s : Nat) (k : K) : Option V :=
  match (d.set s k).bind (norm k) with
  | some v => some v
  | none => if d.compat = some s then (d.top k).bind (norm k) else none

/-- Pre-fix load: the legacy top level was copied without the schema (store-expand.ts:97 before
this round), so a malformed value reached the outer `StoreEntrySchema` parse. -/
def typedOld (norm : K → V → Option V) (d : Disk I K V) (s : Nat) (k : K) : Option V :=
  match (d.set s k).bind (norm k) with
  | some v => some v
  | none => if d.compat = some s then d.top k else none

/-- The outer `PlurConfigSchema.parse` (config.ts:72) succeeds iff no expanded value of a key
without `.catch` (`fatal`, i.e. `description`) is malformed; otherwise the whole config falls
back to defaults. -/
def loadOk (norm : K → V → Option V) (fatal : K → Bool)
    (tv : Nat → K → Option V) (scopes : List Nat) : Prop :=
  ∀ s ∈ scopes, ∀ k v, tv s k = some v → fatal k = true → (norm k v).isSome

/-- Parsing is idempotent on its output (Zod preprocess/catch of an already-parsed value). -/
def NormIdem (norm : K → V → Option V) : Prop := ∀ k v w, norm k v = some w → norm k w = some w

theorem typed_normal {norm : K → V → Option V} (hn : NormIdem norm) (d : Disk I K V) s k v
    (h : typed norm d s k = some v) : norm k v = some v := by
  unfold typed at h
  cases hs : (d.set s k).bind (norm k) with
  | some w =>
    rw [hs] at h; cases h
    cases hd : d.set s k with
    | none => rw [hd] at hs; cases hs
    | some x => rw [hd] at hs; exact hn k x _ hs
  | none =>
    rw [hs] at h
    by_cases hc : d.compat = some s
    · rw [if_pos hc] at h
      cases ht : d.top k with
      | none => rw [ht] at h; cases h
      | some x => rw [ht] at h; exact hn k x _ h
    · rw [if_neg hc] at h; cases h

/-- FIXED: no server entry's metadata can make the whole config fall back to defaults. -/
theorem load_ok_fixed {norm : K → V → Option V} (hn : NormIdem norm) (fatal : K → Bool)
    (d : Disk I K V) (scopes : List Nat) : loadOk norm fatal (typed norm d) scopes := by
  intro s _ k v h _
  rw [typed_normal hn d s k v h]; rfl

/-- The pre-fix counterexample, replayed in formal-store-entry.test.ts (`description:` empty):
one key, value 0 = YAML null, which the `description` schema rejects. -/
def nullDesc : Disk Unit Unit Nat := { ident := (), compat := some 1, top := fun _ => some 0, set := fun _ _ => none }
def normDesc : Unit → Nat → Option Nat := fun _ v => if v = 0 then none else some v

theorem old_load_falls_back : ¬ loadOk normDesc (fun _ => true) (typedOld normDesc nullDesc) [1] := by
  intro h
  have := h 1 (by simp) () 0 (by simp [typedOld, nullDesc, normDesc]) rfl
  simp [normDesc] at this

/-- Where collapse writes key `k` of scope `s` (store-expand.ts:211): the top level iff `s`
is the compat scope, the key is not in its scope_settings and is already at the top level. -/
def toTop (d : Disk I K V) (s : Nat) (k : K) : Bool :=
  decide (d.compat = some s) && (d.set s k).isNone && (d.top k).isSome

/-- collapseExpandedStores for one entry: `t s k` is the typed value of each expanded scope
(`inScope`), `none` = absent = keep what is on disk (209). `wb` is the per-key writeback. -/
def collapse (wb : K → Option V → V → V) (d : Disk I K V) (inScope : Nat → Bool)
    (t : Nat → K → Option V) : Disk I K V :=
  { ident := d.ident, compat := d.compat,
    top := fun k => match d.compat with
      | some c => if inScope c && toTop d c k then
          (match t c k with | some v => some (wb k (d.top k) v) | none => d.top k) else d.top k
      | none => d.top k,
    set := fun s k => if inScope s && !toTop d s k then
          (match t s k with | some v => some (wb k (d.set s k) v) | none => d.set s k) else d.set s k }

/-- What a writeback merge must satisfy: writing the typed value `v` over an on-disk value that
parses to `v` (or does not parse) reloads as `v`. §2 proves it for `sensitivity`; for
dial/description/covers `wb k _ v = v` and it is `NormIdem`. -/
def WbOk (norm : K → V → Option V) (wb : K → Option V → V → V) : Prop :=
  ∀ k o v, norm k v = some v → (∀ w, o = some w → norm k w = none ∨ norm k w = some v) →
    norm k (wb k o v) = some v

theorem collapse_ident (wb : K → Option V → V → V) d inScope (t : Nat → K → Option V) :
    (collapse wb d inScope t : Disk I K V).ident = d.ident ∧ (collapse wb d inScope t).compat = d.compat :=
  ⟨rfl, rfl⟩

/-- Candidate 1 (REFUTED = holds): an ordinary writeback of the unchanged loaded state reloads
to the same typed metadata for every expanded scope and key. -/
theorem roundtrip_load {norm : K → V → Option V} {wb : K → Option V → V → V}
    (hn : NormIdem norm) (hw : WbOk norm wb) (d : Disk I K V) (inScope : Nat → Bool)
    (s : Nat) (hs : inScope s = true) (k : K) :
    typed norm (collapse wb d inScope (typed norm d)) s k = typed norm d s k := by
  have hcomp : (collapse wb d inScope (typed norm d)).compat = d.compat := rfl
  cases htt : toTop d s k
  · -- written to scope_settings[s] (or unchanged)
    have hset : (collapse wb d inScope (typed norm d)).set s k =
        (match typed norm d s k with | some v => some (wb k (d.set s k) v) | none => d.set s k) := by
      simp [collapse, hs, htt]
    have htop : d.compat = some s → (collapse wb d inScope (typed norm d)).top k = d.top k := by
      intro hc; simp [collapse, hc, htt]
    cases hv : typed norm d s k with
    | some v =>
      rw [hv] at hset
      have hvn := typed_normal hn d s k v hv
      have hcond : ∀ w, d.set s k = some w → norm k w = none ∨ norm k w = some v := by
        intro w hw'
        cases hnw : norm k w with
        | none => exact Or.inl rfl
        | some x =>
          right; unfold typed at hv; rw [hw'] at hv; simp [hnw] at hv; rw [hv]
      have hwb := hw k (d.set s k) v hvn hcond
      generalize collapse wb d inScope (typed norm d) = d' at hset ⊢
      unfold typed; rw [hset]; simp [hwb]
    | none =>
      rw [hv] at hset
      have hv' := hv
      unfold typed at hv'
      cases hb : (d.set s k).bind (norm k) with
      | some w => rw [hb] at hv'; cases hv'
      | none =>
        rw [hb] at hv'
        have hb' : (d.set s k).bind (norm k) = none := hb
        generalize collapse wb d inScope (typed norm d) = d' at hset htop hcomp ⊢
        unfold typed; rw [hset, hb']
        show (if d'.compat = some s then (d'.top k).bind (norm k) else none) = none
        rw [hcomp]
        by_cases hc : d.compat = some s
        · rw [if_pos hc] at hv' ⊢; rw [htop hc]; exact hv'
        · rw [if_neg hc]
  · -- written to the top level: compat scope, not in scope_settings, already at top
    have htt0 := htt
    simp [toTop] at htt0
    obtain ⟨⟨hc, hsn⟩, htp⟩ := htt0
    obtain ⟨w, hwt⟩ := Option.isSome_iff_exists.mp htp
    have hsn' : d.set s k = none := hsn
    have hty : typed norm d s k = norm k w := by simp [typed, hsn', hc, hwt]
    have hset : (collapse wb d inScope (typed norm d)).set s k = none := by
      simp [collapse, htt, hsn']
    have htop : (collapse wb d inScope (typed norm d)).top k =
        (match norm k w with | some v => some (wb k (some w) v) | none => some w) := by
      simp [collapse, hc, hs, htt, hty, hwt]
    rw [hty]
    generalize collapse wb d inScope (typed norm d) = d' at hset htop hcomp ⊢
    unfold typed; rw [hset]; simp only [Option.bind_none]
    rw [hcomp, if_pos hc, htop]
    cases hnw : norm k w with
    | none => simp [hnw]
    | some v =>
      have hvn := hn k w v hnw
      have := hw k (some w) v hvn (by intro w' h; cases h; exact Or.inr hnw)
      simp [this]

/-- Candidate 2: legacy top-level metadata reaches the compat scope, and only it. -/
theorem legacy_reaches_compat (norm : K → V → Option V) (d : Disk I K V) c k
    (hc : d.compat = some c) (hs : (d.set c k).bind (norm k) = none) :
    typed norm d c k = (d.top k).bind (norm k) := by
  simp [typed, hs, hc]

theorem legacy_not_other (norm : K → V → Option V) (d : Disk I K V) s k
    (hc : d.compat ≠ some s) (hs : (d.set s k).bind (norm k) = none) : typed norm d s k = none := by
  simp [typed, hs, hc]

/-- Candidate 2: a valid scope_settings value takes precedence over the top level. -/
theorem settings_precede (norm : K → V → Option V) (d : Disk I K V) s k v
    (h : (d.set s k).bind (norm k) = some v) : typed norm d s k = some v := by
  simp [typed, h]

/-- Candidate 2: a changed value of a key held at the top level is written there, and the
reload sees it (for a key whose merge is "typed wins", e.g. dial/description). -/
theorem update_compat_top {norm : K → V → Option V} (wb : K → Option V → V → V)
    (hwb : ∀ o v, wb k o v = v) (d : Disk I K V) (inScope : Nat → Bool) (t : Nat → K → Option V)
    c u (hc : d.compat = some c) (hin : inScope c = true) (htt : toTop d c k = true)
    (hu : t c k = some u) (hnu : norm k u = some u) :
    (collapse wb d inScope t).top k = some u ∧ typed norm (collapse wb d inScope t) c k = some u := by
  have htop : (collapse wb d inScope t).top k = some u := by simp [collapse, hc, hin, htt, hu, hwb]
  have hsn : d.set c k = none := by
    simp [toTop] at htt; exact htt.1.2
  have hset : (collapse wb d inScope t).set c k = none := by simp [collapse, htt, hsn]
  have hcomp : (collapse wb d inScope t).compat = d.compat := rfl
  refine ⟨htop, ?_⟩
  generalize collapse wb d inScope t = d' at htop hset hcomp ⊢
  simp [typed, hset, hcomp, hc, htop, hnu]

/-! ## 1b. A compat-scope change (discovery, Codex round 4 finding 2)

`refreshServerScopes` sets the compat `scope` to the personal scope `/me` lists. The old
compat scope's top-level metadata belongs to that scope, so `withCompatScope`
(store-expand.ts) moves it into `scope_settings[old]` first (a key already there wins)
and clears the top level, so it cannot attach to the new compat scope. -/

/-- Fixed (`withCompatScope`). -/
def recompat (d : Disk I K V) (n : Nat) : Disk I K V :=
  match d.compat with
  | none => { d with compat := some n }
  | some c =>
    if c = n then d
    else { ident := d.ident, compat := some n, top := fun _ => none,
           set := fun s k => if s = c then (d.set c k).or (d.top k) else d.set s k }

/-- Original: only the compat field changed; the top level stayed and followed it. -/
def recompatOld (d : Disk I K V) (n : Nat) : Disk I K V := { d with compat := some n }

/-- The old compat scope keeps every metadata value it had (when its own scope_settings
value for the key, if any, is well-formed: a malformed one wins on disk as it did before
and the schema drops it, see findings/store-entry.md). -/
theorem recompat_keeps_old (norm : K → V → Option V) (d : Disk I K V) c n k
    (hc : d.compat = some c) (hne : c ≠ n)
    (hwf : ∀ w, d.set c k = some w → (norm k w).isSome) :
    typed norm (recompat d n) c k = typed norm d c k := by
  have hne' : ¬ (n = c) := fun h => hne h.symm
  cases hs : d.set c k with
  | none =>
    simp [typed, recompat, hc, hne, hs, hne']
    cases (d.top k).bind (norm k) <;> rfl
  | some w =>
    have hw := hwf w hs
    cases hnw : norm k w with
    | none => simp [hnw] at hw
    | some v => simp [typed, recompat, hc, hne, hs, hnw]

/-- The new compat scope gets exactly its own scope_settings: no top-level metadata. -/
theorem recompat_new_own_only (norm : K → V → Option V) (d : Disk I K V) c n k
    (hc : d.compat = some c) (hne : c ≠ n) :
    typed norm (recompat d n) n k = (d.set n k).bind (norm k) := by
  have hne' : ¬ (n = c) := fun h => hne h.symm
  cases h : (d.set n k).bind (norm k) <;> simp [typed, recompat, hc, hne, hne', h]

/-- Every other scope is untouched. -/
theorem recompat_others (norm : K → V → Option V) (d : Disk I K V) c n s k
    (hc : d.compat = some c) (hne : c ≠ n) (hsc : s ≠ c) (hsn : s ≠ n) :
    typed norm (recompat d n) s k = typed norm d s k := by
  have h1 : ¬ (c = s) := fun h => hsc h.symm
  have h2 : ¬ (n = s) := fun h => hsn h.symm
  cases h : (d.set s k).bind (norm k) <;> simp [typed, recompat, hc, hne, hsc, hsn, h, h1, h2]

/-- A team entry (scope 1) with top-level `dial: never` (value 0). -/
def teamNever : Disk Unit Unit Nat :=
  { ident := (), compat := some 1, top := fun _ => some 0, set := fun _ _ => none }
def normId : Unit → Nat → Option Nat := fun _ v => some v

/-- Counterexample for the original (replayed: codex4-compat-scope-metadata.test.ts):
discovery makes the personal scope (2) the compat scope; the team loses `dial: never`
and the personal scope inherits it. -/
theorem old_moves_metadata_to_personal :
    typed normId (recompatOld teamNever 2) 1 () = none ∧
    typed normId (recompatOld teamNever 2) 2 () = some 0 := by decide

/-- Non-vacuity: with the fix the team keeps it and the personal scope has none. -/
theorem fixed_team_keeps_dial :
    typed normId (recompat teamNever 2) 1 () = some 0 ∧
    typed normId (recompat teamNever 2) 2 () = none := by decide

/-! ## 2. Sensitivity writeback (candidate 5) — `mergeSensitivityForWriteback`

`forbid`/`allow` absent = `none`. Parsing keeps the `known` categories, and an empty or absent
result is the default; `allow` defaults to `[]`; `extra` stands for nested unknown keys
(passthrough). -/

structure Sens where
  forbid : Option (List Nat)
  allow  : Option (List Nat)
  extra  : Option Nat
deriving DecidableEq

def parseForbid (known : Nat → Bool) (dflt : List Nat) : Option (List Nat) → List Nat
  | some l => if l.filter known = [] then dflt else l.filter known
  | none => dflt

def parseS (known : Nat → Bool) (dflt : List Nat) (r : Sens) : Sens :=
  { forbid := some (parseForbid known dflt r.forbid), allow := some (r.allow.getD []), extra := r.extra }

/-- sensitivity-writeback.ts:24–33: `{...raw, ...typed, forbid: raw.forbid if present and not
authoritative}`. A typed key overrides the raw one when present. -/
def mergeS (raw : Option Sens) (t : Sens) (auth : Bool) : Sens :=
  match raw with
  | none => t
  | some r => { forbid := if r.forbid.isSome && !auth then r.forbid else t.forbid.or r.forbid,
                allow := t.allow.or r.allow, extra := t.extra.or r.extra }

theorem ordinary_keeps_forbid (r t : Sens) l (h : r.forbid = some l) :
    (mergeS (some r) t false).forbid = some l := by simp [mergeS, h]

theorem authoritative_replaces (r t : Sens) l (h : t.forbid = some l) :
    (mergeS (some r) t true).forbid = some l := by simp [mergeS, h]

theorem parseForbid_idem (known : Nat → Bool) (dflt : List Nat) (hd : dflt.filter known = dflt)
    (hne : dflt ≠ []) (o : Option (List Nat)) :
    parseForbid known dflt (some (parseForbid known dflt o)) = parseForbid known dflt o := by
  cases o with
  | none => simp [parseForbid, hd, hne]
  | some l =>
    by_cases h : l.filter known = []
    · simp [parseForbid, h, hd, hne]
    · simp [parseForbid, h, List.filter_filter]

/-- The `WbOk` hypothesis of §1 for the sensitivity key (ordinary writeback). -/
theorem sens_wbOk (known : Nat → Bool) (dflt : List Nat) (hd : dflt.filter known = dflt)
    (hne : dflt ≠ []) (o : Option Sens) (t : Sens) (ht : parseS known dflt t = t)
    (ho : ∀ w, o = some w → parseS known dflt w = t) :
    parseS known dflt (mergeS o t false) = t := by
  cases o with
  | none => simpa [mergeS] using ht
  | some r =>
    have hr := ho r rfl
    subst hr
    cases hf : r.forbid with
    | none =>
      simp [mergeS, parseS, hf, parseForbid_idem known dflt hd hne]
    | some l =>
      simp [mergeS, parseS, hf, parseForbid_idem known dflt hd hne]

/-- Non-vacuity: a forward-compatible category (5) that load drops survives the writeback. -/
theorem fwd_category_survives :
    let known := fun n => decide (n < 3)
    let r : Sens := { forbid := some [0, 5], allow := none, extra := some 1 }
    (parseS known [0, 1] r).forbid = some [0] ∧
    (mergeS (some r) (parseS known [0, 1] r) false).forbid = some [0, 5] := by
  decide

/-- Mutation (round-1 finding 5): writing the parsed value over the raw one loses it. -/
theorem replace_loses_category :
    let known := fun n => decide (n < 3)
    let r : Sens := { forbid := some [0, 5], allow := none, extra := none }
    (parseS known [0, 1] r).forbid ≠ r.forbid := by decide

/-! ## 3. Stable identity (candidate 3) — `serverEntryIdentities`

An entry has an identity base `base` (JSON of the url's canonical endpoint identity
`normalizeEndpointUrl`, scope, scopes, pinned_scopes, readonly, token_env; Codex round 3 finding 2:
two spellings of one server are one base) and a ghost `tag` naming which physical entry it is. The identity of position i is
`(base, number of earlier entries with that base)`. Collapse and rotation write to the first
entry whose identity equals the one recorded at load. -/

structure Ent where
  base : Nat
  tag  : Nat
deriving DecidableEq

def idsAux (seen : Nat → Nat) : List Ent → List (Nat × Nat)
  | [] => []
  | e :: es => (e.base, seen e.base) ::
      idsAux (fun b => if b = e.base then seen e.base + 1 else seen b) es

def findAux (seen : Nat → Nat) (x : Nat × Nat) : List Ent → Option Ent
  | [] => none
  | e :: es => if (e.base, seen e.base) = x then some e else
      findAux (fun b => if b = e.base then seen e.base + 1 else seen b) x es

/-- The entry a writeback lands on (persistStores' `indexById` / collapse's `ids[i] === id`). -/
def findId (l : List Ent) (x : Nat × Nat) : Option Ent := findAux (fun _ => 0) x l

theorem findAux_filter (l : List Ent) : ∀ (seen : Nat → Nat) (b n : Nat),
    findAux seen (b, seen b + n) l = (l.filter (fun e => e.base = b))[n]? := by
  induction l with
  | nil => intro _ _ _; rfl
  | cons e es ih =>
    intro seen b n
    by_cases hb : e.base = b
    · subst hb
      cases n with
      | zero => simp [findAux]
      | succ m =>
        have := ih (fun b' => if b' = e.base then seen e.base + 1 else seen b') e.base m
        simp only [ite_true] at this
        simp [findAux, List.filter_cons]
        rw [show seen e.base + (m + 1) = seen e.base + 1 + m by omega]; exact this
    · have := ih (fun b' => if b' = e.base then seen e.base + 1 else seen b') b n
      have hne : ¬ (b = e.base) := fun h => hb h.symm
      simp only [hne, if_false] at this
      simp [findAux, List.filter_cons, hb]
      exact this

theorem findId_filter (l : List Ent) (b n : Nat) :
    findId l (b, n) = (l.filter (fun e => e.base = b))[n]? := by
  have := findAux_filter l (fun _ => 0) b n; simpa [findId] using this

/-- Candidate 3: if the other process kept the entries with this base in the same order (it may
insert, remove and reorder entries with any OTHER base), the write lands on the same entry. -/
theorem identity_stable (l0 l1 : List Ent) (b n : Nat)
    (h : l1.filter (fun e => e.base = b) = l0.filter (fun e => e.base = b)) :
    findId l1 (b, n) = findId l0 (b, n) := by
  rw [findId_filter, findId_filter, h]

theorem insert_other_base (pre post : List Ent) (e : Ent) (b : Nat) (he : e.base ≠ b) :
    (pre ++ e :: post).filter (fun x => x.base = b) = (pre ++ post).filter (fun x => x.base = b) := by
  simp [List.filter_append, List.filter_cons, he]

/-- The reachable good case: the identity recorded at load finds its own entry. -/
theorem good_case : findId [⟨7, 1⟩, ⟨9, 2⟩] (9, 0) = some ⟨9, 2⟩ := by decide

/-- CONFIRMED, pre-fix lookup: an entry with the SAME base (same url/scopes/readonly/token_env,
another token) inserted before ours takes `#0`, so `findId` alone lands our metadata on it
(replayed). Fixed by owner decision 17: the collapse uses `findIdFixed` below. -/
theorem same_base_insert_mistargets :
    findId [⟨9, 1⟩] (9, 0) = some ⟨9, 1⟩ ∧ findId [⟨9, 2⟩, ⟨9, 1⟩] (9, 0) = some ⟨9, 2⟩ := by decide

/-! ### Owner decision 17 (fixed, 2026-10-18): collapse writes nothing for an ambiguous base

`typed` are the identities the loaded (typed) entries carry. A base is ambiguous when two entries
on disk now share it, or a typed entry came from `#1` or later (two shared it at load).
store-expand.ts `collapseExpandedStores` (`ambiguous`). -/

def ambiguousB (l1 : List Ent) (typed : List (Nat × Nat)) (b : Nat) : Bool :=
  decide (1 < (l1.filter (fun e => e.base = b)).length) || typed.any (fun x => x.1 = b && x.2 ≠ 0)

/-- The entry a typed identity's metadata is written to after the fix. -/
def findIdFixed (l1 : List Ent) (typed : List (Nat × Nat)) (x : Nat × Nat) : Option Ent :=
  if ambiguousB l1 typed x.1 then none else findId l1 x

theorem len_le_one_eq {L : List Ent} {a b : Ent} (h : L.length ≤ 1) (ha : a ∈ L) (hb : b ∈ L) :
    a = b := by
  match L, h with
  | [], _ => simp at ha
  | [x], _ => simp at ha hb; rw [ha, hb]
  | _ :: _ :: _, h => simp at h

/-- FIXED: metadata recorded at load for entry `e0` is written to `e0` (if it is still on
disk) or to nothing — never to another entry, whatever the other process inserted or removed. -/
theorem mistarget_impossible (l0 l1 : List Ent) (typed : List (Nat × Nat)) (b n : Nat)
    (e0 e1 : Ent) (hx : (b, n) ∈ typed) (h0 : findId l0 (b, n) = some e0) (hmem : e0 ∈ l1)
    (h1 : findIdFixed l1 typed (b, n) = some e1) : e1 = e0 := by
  unfold findIdFixed at h1
  split at h1
  · cases h1
  · rename_i hna
    simp only [ambiguousB, Bool.or_eq_true, decide_eq_true_eq, List.any_eq_true, not_or,
      not_exists, not_and, Bool.and_eq_true, ne_eq, decide_not, Bool.not_eq_true',
      decide_eq_false_iff_not, Classical.not_not] at hna
    obtain ⟨hlen, hn⟩ := hna
    have hn0 : n = 0 := by
      have := hn (b, n) hx; simp at this; exact this
    subst hn0
    rw [findId_filter] at h0 h1
    have he0 : e0 ∈ l0.filter (fun e => e.base = b) := List.mem_of_getElem? h0
    have hb0 : e0.base = b := by simpa using (List.mem_filter.mp he0).2
    have he1 : e1 ∈ l1.filter (fun e => e.base = b) := List.mem_of_getElem? h1
    exact len_le_one_eq (by omega) he1 (List.mem_filter.mpr ⟨hmem, by simp [hb0]⟩)

/-- FIXED: the C3 counterexample now writes nothing (neither the inserted entry nor ours). -/
theorem fixed_same_base_insert :
    findIdFixed [⟨9, 2⟩, ⟨9, 1⟩] [(9, 0)] (9, 0) = none := by decide

/-- FIXED: loaded as two, one removed since: the survivor is not written either. -/
theorem fixed_removed_twin : findIdFixed [⟨9, 2⟩] [(9, 0), (9, 1)] (9, 0) = none := by decide

/-- Non-vacuity: an unambiguous identity is still written to its own entry. -/
theorem fixed_good_case : findIdFixed [⟨7, 1⟩, ⟨9, 2⟩] [(9, 0)] (9, 0) = some ⟨9, 2⟩ := by decide

/-! ## 4. Rotation (candidate 4) — persistStores `serverEntryToken`

Under the lock: the entries whose base equals the selected entry's base; exactly one → its
token is replaced, otherwise refused (throw before atomicWrite: the file is unchanged). -/

structure Srv where
  base  : Nat
  token : Nat
deriving DecidableEq

def rotate (l : List Srv) (b tok : Nat) : Except String (List Srv) :=
  if (l.filter (fun e => e.base = b)).length = 1 then
    .ok (l.map (fun e => if e.base = b then { e with token := tok } else e))
  else .error "refused"

/-- The file after the locked step: on refusal it is the file as read. -/
def fileAfter (l : List Srv) (b tok : Nat) : List Srv :=
  match rotate l b tok with | .ok l' => l' | .error _ => l

theorem rotate_only_selected (l l' : List Srv) (b tok : Nat) (h : rotate l b tok = .ok l') :
    l'.length = l.length ∧ ∀ i (hi : i < l.length) (hi' : i < l'.length),
      (l[i].base ≠ b → l'[i] = l[i]) ∧ (l[i].base = b → l'[i] = { l[i] with token := tok }) := by
  unfold rotate at h
  split at h
  · cases h
    refine ⟨by simp, fun i hi hi' => ⟨fun hne => by simp [hne], fun heq => by simp [heq]⟩⟩
  · cases h

theorem rotate_two_refused (l : List Srv) (b tok : Nat)
    (h : 2 ≤ (l.filter (fun e => e.base = b)).length) : fileAfter l b tok = l := by
  have : (l.filter (fun e => e.base = b)).length ≠ 1 := by omega
  simp [fileAfter, rotate, this]

theorem rotate_none_refused (l : List Srv) (b tok : Nat)
    (h : (l.filter (fun e => e.base = b)).length = 0) : fileAfter l b tok = l := by
  simp [fileAfter, rotate, h]

theorem rotate_good_case :
    rotate [⟨1, 10⟩, ⟨2, 20⟩] 1 99 = .ok [⟨1, 99⟩, ⟨2, 20⟩] := rfl

/-! ## 5. Metadata never sets identity or credentials (candidate 6)

An expanded entry is a map Key → value. Reserved keys (store-expand.ts:130–133) come from the
server entry; metadata (`{...legacy, ...settings}`) is filtered to non-reserved keys. -/

inductive Key where
  | url | token | tokenEnv | scope | readonly | shared | path | md (n : Nat)
deriving DecidableEq

def reserved : Key → Bool
  | .md _ => false
  | _ => true

structure SrvEntry where
  url : Nat
  token : Option Nat
  tokenEnv : Option Nat
  readonly : Nat

/-- The value the server entry gives a reserved key (url/readonly/shared/scope always, token and
token_env only when the entry has them, path never). -/
def idField (e : SrvEntry) (s : Nat) : Key → Option Nat
  | .url => some e.url | .token => e.token | .tokenEnv => e.tokenEnv | .scope => some s
  | .readonly => some e.readonly | .shared => some s | .path => none | .md _ => none

def spread (base over : Key → Option Nat) : Key → Option Nat := fun k => (over k).or (base k)
def metaOnly (m : Key → Option Nat) : Key → Option Nat := fun k => if reserved k then none else m k

/-- expandServerEntry (fixed, #1639 review item 2). -/
def expand (e : SrvEntry) (s : Nat) (legacy settings : Key → Option Nat) : Key → Option Nat :=
  fun k => if reserved k then idField e s k else spread (metaOnly legacy) (metaOnly settings) k

theorem metadata_never_sets_identity (e : SrvEntry) s legacy settings k (hk : reserved k = true) :
    expand e s legacy settings k = idField e s k := by simp [expand, hk]

theorem metadata_meta_keys (e : SrvEntry) s legacy settings n :
    expand e s legacy settings (.md n) = (settings (.md n)).or (legacy (.md n)) := by
  simp [expand, reserved, spread, metaOnly]

/-- Mutation (pre-review code): settings spread after the identity fields, unfiltered. -/
def expandOld (e : SrvEntry) (s : Nat) (settings : Key → Option Nat) : Key → Option Nat :=
  spread (idField e s) settings

theorem old_settings_redirects :
    expandOld ⟨1, some 2, none, 0⟩ 5 (fun k => if k = .url then some 666 else none) .url = some 666 := by
  decide

/-! ## 6. Registration and fold (#1631, plan B Task 5; 2026-10-18)

`registerServerEntry` / `foldStoresIntoServerEntry` (server-discovery.ts), called by
`Plur.registerEnterpriseServer` (index.ts) inside `_updateRawStores` (config lock, atomic
write). Urls are their canonical endpoint identity (`normalizeEndpointUrl`, the url part of
§3's identity base), so `u` is a number. `c` is the stored credential (`token_env`, then
`token`, as on disk); `ro` is `readonly`. Metadata of a per-scope entry is `md k`, the
server entry's `scope_settings[s][k]` is `set s k`. `ok` is the code's other eligibility
checks (grammar and `__proto__`, `shared`, `scope-served-elsewhere`, `metadata-differs`),
decided before the fold; `fmatch` requires it. Left out: the compat-scope metadata move (§1b),
order (§6b).

A scope's *routes* are the (url, credential, readonly) triples of the entries that serve it:
a per-scope entry serves its scope, a server entry its `scopes`, `pinned_scopes` and compat
`scope`. Routing is what a write to a scope uses (url and key), so "routing preserved" is:
every scope has the same routes before and after. -/

structure PerScope where
  u : Nat
  s : Nat
  c : Nat
  ro : Bool
  md : Nat → Option Nat
  ok : Bool := true

structure Server where
  u : Nat
  c : Nat
  ro : Bool
  compat : Option Nat
  scopes : List Nat
  pinned : List Nat
  set : Nat → Nat → Option Nat

/-- The fold condition (server-discovery.ts `keptReason` returns null). -/
def fmatch (v : Server) (p : PerScope) : Bool := p.u == v.u && p.c == v.c && p.ro == v.ro && p.ok

/-- One folded entry: its scope joins `pinned_scopes`, its metadata goes to
`scope_settings[scope]` over a value already there for the same key. -/
def foldOne (v : Server) (p : PerScope) : Server :=
  { v with pinned := if p.s ∈ v.pinned then v.pinned else v.pinned ++ [p.s],
           set := fun s k => if s = p.s then (p.md k).or (v.set s k) else v.set s k }

/-- foldStoresIntoServerEntry: the server entry after the fold, and the entries kept. -/
def fold (v : Server) : List PerScope → Server × List PerScope
  | [] => (v, [])
  | p :: ps => if fmatch v p then fold (foldOne v p) ps else ((fold v ps).1, p :: (fold v ps).2)

def serves (v : Server) (s : Nat) : Prop := s ∈ v.scopes ∨ s ∈ v.pinned ∨ v.compat = some s

def Routes (v : Server) (ps : List PerScope) (s : Nat) (t : Nat × Nat × Bool) : Prop :=
  (serves v s ∧ t = (v.u, v.c, v.ro)) ∨ ∃ p ∈ ps, p.s = s ∧ t = (p.u, p.c, p.ro)

theorem foldOne_keeps (v : Server) (p : PerScope) :
    (foldOne v p).u = v.u ∧ (foldOne v p).c = v.c ∧ (foldOne v p).ro = v.ro ∧
    (foldOne v p).compat = v.compat ∧ (foldOne v p).scopes = v.scopes := ⟨rfl, rfl, rfl, rfl, rfl⟩

theorem fmatch_foldOne (v : Server) (p q : PerScope) : fmatch (foldOne v p) q = fmatch v q := rfl

theorem serves_foldOne (v : Server) (p : PerScope) (s : Nat) : serves (foldOne v p) s ↔ serves v s ∨ s = p.s := by
  unfold serves foldOne
  by_cases h : p.s ∈ v.pinned
  · simp only [h, if_true]
    constructor
    · intro hh; exact Or.inl hh
    · intro hh
      rcases hh with hh | hh
      · exact hh
      · subst hh; exact Or.inr (Or.inl h)
  · simp only [h, if_false, List.mem_append, List.mem_singleton]
    constructor
    · intro hh
      rcases hh with hh | (hh | hh) | hh
      · exact Or.inl (Or.inl hh)
      · exact Or.inl (Or.inr (Or.inl hh))
      · exact Or.inr hh
      · exact Or.inl (Or.inr (Or.inr hh))
    · intro hh
      rcases hh with (hh | hh | hh) | hh
      · exact Or.inl hh
      · exact Or.inr (Or.inl (Or.inl hh))
      · exact Or.inr (Or.inr hh)
      · exact Or.inr (Or.inl (Or.inr hh))

theorem fmatch_eq {v : Server} {p : PerScope} (h : fmatch v p = true) : (p.u, p.c, p.ro) = (v.u, v.c, v.ro) := by
  simp [fmatch] at h
  obtain ⟨⟨⟨hu, hc⟩, hr⟩, _⟩ := h
  rw [hu, hc, hr]

/-- The server entry keeps its url, key, readonly, compat scope and scopes. -/
theorem fold_keeps_server (ps : List PerScope) : ∀ v : Server,
    (fold v ps).1.u = v.u ∧ (fold v ps).1.c = v.c ∧ (fold v ps).1.ro = v.ro ∧
    (fold v ps).1.compat = v.compat ∧ (fold v ps).1.scopes = v.scopes := by
  induction ps with
  | nil => intro v; exact ⟨rfl, rfl, rfl, rfl, rfl⟩
  | cons p ps ih =>
    intro v
    by_cases hm : fmatch v p = true
    · simp only [fold, hm, if_true]; exact ih (foldOne v p)
    · simp only [fold, hm]; exact ih v

/-- THEOREM (routing): the fold preserves every scope's routing — the same (url, key,
readonly) triples serve every scope before and after; in particular no scope is dropped. -/
theorem fold_preserves_routing (ps : List PerScope) : ∀ (v : Server) (s : Nat) (t : Nat × Nat × Bool),
    Routes v ps s t ↔ Routes (fold v ps).1 (fold v ps).2 s t := by
  induction ps with
  | nil => intro v s t; exact Iff.rfl
  | cons p ps ih =>
    intro v s t
    by_cases hm : fmatch v p = true
    · have hf : fold v (p :: ps) = fold (foldOne v p) ps := by simp [fold, hm]
      rw [hf, ← ih (foldOne v p) s t]
      have heq := fmatch_eq hm
      have hk := foldOne_keeps v p
      unfold Routes
      rw [serves_foldOne, hk.1, hk.2.1, hk.2.2.1]
      constructor
      · intro h
        rcases h with ⟨hs, ht⟩ | ⟨q, hq, hqs, hqt⟩
        · exact Or.inl ⟨Or.inl hs, ht⟩
        · rcases List.mem_cons.mp hq with hq | hq
          · subst hq; exact Or.inl ⟨Or.inr hqs.symm, hqt.trans heq⟩
          · exact Or.inr ⟨q, hq, hqs, hqt⟩
      · intro h
        rcases h with ⟨hs | hs, ht⟩ | ⟨q, hq, hqs, hqt⟩
        · exact Or.inl ⟨hs, ht⟩
        · exact Or.inr ⟨p, List.mem_cons_self .., hs.symm, ht.trans heq.symm⟩
        · exact Or.inr ⟨q, List.mem_cons_of_mem _ hq, hqs, hqt⟩
    · have hf : fold v (p :: ps) = ((fold v ps).1, p :: (fold v ps).2) := by simp [fold, hm]
      rw [hf]
      have ih' := ih v s t
      unfold Routes at ih' ⊢
      constructor
      · intro h
        rcases h with ⟨hs, ht⟩ | ⟨q, hq, hqs, hqt⟩
        · rcases ih'.mp (Or.inl ⟨hs, ht⟩) with h' | ⟨q', hq', h1, h2⟩
          · exact Or.inl h'
          · exact Or.inr ⟨q', List.mem_cons_of_mem _ hq', h1, h2⟩
        · rcases List.mem_cons.mp hq with hq | hq
          · subst hq; exact Or.inr ⟨q, List.mem_cons_self .., hqs, hqt⟩
          · rcases ih'.mp (Or.inr ⟨q, hq, hqs, hqt⟩) with h' | ⟨q', hq', h1, h2⟩
            · exact Or.inl h'
            · exact Or.inr ⟨q', List.mem_cons_of_mem _ hq', h1, h2⟩
      · intro h
        rcases h with ⟨hs, ht⟩ | ⟨q, hq, hqs, hqt⟩
        · rcases ih'.mpr (Or.inl ⟨hs, ht⟩) with h' | ⟨q', hq', h1, h2⟩
          · exact Or.inl h'
          · exact Or.inr ⟨q', List.mem_cons_of_mem _ hq', h1, h2⟩
        · rcases List.mem_cons.mp hq with hq | hq
          · subst hq; exact Or.inr ⟨q, List.mem_cons_self .., hqs, hqt⟩
          · rcases ih'.mpr (Or.inr ⟨q, hq, hqs, hqt⟩) with h' | ⟨q', hq', h1, h2⟩
            · exact Or.inl h'
            · exact Or.inr ⟨q', List.mem_cons_of_mem _ hq', h1, h2⟩

/-- The entries kept separate are exactly the ones that do not match, unchanged
(their key, readonly and metadata included). -/
theorem fold_kept (ps : List PerScope) : ∀ v : Server, (fold v ps).2 = ps.filter (fun p => !fmatch v p) := by
  induction ps with
  | nil => intro v; rfl
  | cons p ps ih =>
    intro v
    by_cases hm : fmatch v p = true
    · simp only [fold, hm, if_true, List.filter_cons, Bool.not_true]
      rw [ih (foldOne v p)]
      simp [fmatch_foldOne]
    · simp only [fold, hm, List.filter_cons]
      simp [ih v, hm]

/-- The metadata of scope `s` after the fold: each matching entry for `s`, in order, sets
the keys it has over what is there (`{...existing, ...md}`). -/
def mdAfter (v : Server) (ps : List PerScope) (s k : Nat) : Option Nat :=
  ps.foldl (fun acc p => if fmatch v p && p.s == s then (p.md k).or acc else acc) (v.set s k)

theorem fold_md (ps : List PerScope) : ∀ (v : Server) (s k : Nat), (fold v ps).1.set s k = mdAfter v ps s k := by
  induction ps with
  | nil => intro v s k; rfl
  | cons p ps ih =>
    intro v s k
    by_cases hm : fmatch v p = true
    · have hf : fold v (p :: ps) = fold (foldOne v p) ps := by simp [fold, hm]
      rw [hf, ih (foldOne v p) s k]
      unfold mdAfter
      simp only [List.foldl_cons, hm, Bool.true_and, fmatch_foldOne]
      by_cases hs : p.s = s
      · subst hs; simp [foldOne]
      · have hs' : ¬ (s = p.s) := fun h => hs h.symm
        simp [foldOne, hs, hs']
    · have hf : fold v (p :: ps) = ((fold v ps).1, p :: (fold v ps).2) := by simp [fold, hm]
      rw [hf, ih v s k]
      unfold mdAfter
      simp [List.foldl_cons, hm]

theorem mdAfter_skip (v : Server) (ps : List PerScope) (s k : Nat) (acc : Option Nat)
    (h : ∀ p ∈ ps, ¬ (fmatch v p = true ∧ p.s = s)) :
    ps.foldl (fun acc p => if fmatch v p && p.s == s then (p.md k).or acc else acc) acc = acc := by
  induction ps generalizing acc with
  | nil => rfl
  | cons q qs ih =>
    have hq := h q (List.mem_cons_self ..)
    have hc : (fmatch v q && q.s == s) = false := by
      cases h1 : fmatch v q <;> cases h2 : (q.s == s) <;> simp_all
    simp only [List.foldl_cons, hc]
    exact ih acc (fun p hp => h p (List.mem_cons_of_mem _ hp))

/-- THEOREM (metadata): a scope listed once among the matching entries keeps every
metadata value its per-scope entry had, and every other key of its scope_settings. -/
theorem fold_preserves_metadata (v : Server) (pre post : List PerScope) (p : PerScope) (k : Nat)
    (hp : fmatch v p = true)
    (hpre : ∀ q ∈ pre, ¬ (fmatch v q = true ∧ q.s = p.s))
    (hpost : ∀ q ∈ post, ¬ (fmatch v q = true ∧ q.s = p.s)) :
    (fold v (pre ++ p :: post)).1.set p.s k = (p.md k).or (v.set p.s k) := by
  rw [fold_md]
  unfold mdAfter
  rw [List.foldl_append, mdAfter_skip v pre p.s k _ hpre, List.foldl_cons]
  simp only [hp, Bool.true_and, beq_self_eq_true, if_true]
  exact mdAfter_skip v post p.s k _ hpost

/-- A scope no matching entry names keeps its scope_settings unchanged. -/
theorem fold_md_untouched (v : Server) (ps : List PerScope) (s k : Nat)
    (h : ∀ p ∈ ps, ¬ (fmatch v p = true ∧ p.s = s)) : (fold v ps).1.set s k = v.set s k := by
  rw [fold_md]; exact mdAfter_skip v ps s k _ h

/-- THEOREM (metadata in force, `metadata-differs`): when every entry that folds into scope `s`
agrees with the server entry's value for key `k` or has none (the code's eligibility check),
a value the server entry already had for `s`/`k` is the value after the fold. -/
theorem fold_md_keeps_set (v : Server) (s k x : Nat) : ∀ ps : List PerScope,
    (∀ p ∈ ps, fmatch v p = true → p.s = s → p.md k = some x ∨ p.md k = none) →
    v.set s k = some x → (fold v ps).1.set s k = some x := by
  intro ps h hv
  rw [fold_md]
  unfold mdAfter
  rw [hv]
  clear hv
  induction ps with
  | nil => rfl
  | cons q qs ih =>
    simp only [List.foldl_cons]
    have hq := h q (List.mem_cons_self ..)
    have ih' := ih (fun p hp => h p (List.mem_cons_of_mem _ hp))
    by_cases hc : (fmatch v q && q.s == s) = true
    · simp only [hc, if_true]
      have ⟨h1, h2⟩ := Bool.and_eq_true_iff.mp hc
      rcases hq h1 (beq_iff_eq.mp h2) with hm | hm <;> rw [hm] <;> exact ih'
    · simp only [hc]; exact ih'

/-! ### Mutation: fold without the key check (the bug `keptReason` prevents)

Folding every per-scope entry on the server, whatever its key, moves a scope served with
another key (k0) onto the server entry's key (k1): a write to it would go out under a key
the user never gave it. -/

def foldAll (v : Server) : List PerScope → Server × List PerScope
  | [] => (v, [])
  | p :: ps => if p.u = v.u then foldAll (foldOne v p) ps else ((foldAll v ps).1, p :: (foldAll v ps).2)

def srv0 : Server := { u := 1, c := 1, ro := false, compat := some 9, scopes := [], pinned := [], set := fun _ _ => none }
def perK0 : PerScope := { u := 1, s := 5, c := 0, ro := false, md := fun _ => none }

/-- Counterexample: before, scope 5 is served only with key 0; after the mutant, with key 1.
Replayed: register-enterprise-server.test.ts, "keeps an entry with a different token separate". -/
theorem foldAll_breaks_routing :
    Routes srv0 [perK0] 5 (1, 0, false) ∧ ¬ Routes (foldAll srv0 [perK0]).1 (foldAll srv0 [perK0]).2 5 (1, 0, false) := by
  constructor
  · exact Or.inr ⟨perK0, List.mem_cons_self .., rfl, rfl⟩
  · intro h
    have hf : foldAll srv0 [perK0] = (foldOne srv0 perK0, []) := by
      simp [foldAll, srv0, perK0]
    rw [hf] at h
    rcases h with ⟨_, ht⟩ | ⟨q, hq, _, _⟩
    · simp [foldOne, srv0] at ht
    · simp at hq

/-- The real fold keeps it separate, so the route survives (non-vacuity of the theorem). -/
theorem fold_keeps_other_key : (fold srv0 [perK0]).2 = [perK0] := by
  simp [fold, fmatch, srv0, perK0]

/-! ### Registration: the key is replaced only on the selected entry

`register` is registerServerEntry on the server entries: none for the url → one added with
the compat scope; exactly one → its key and compat scope set; more → refused (the caller
writes nothing, so the file is as read). PerScope-scope entries are not touched by this step;
the fold above then keeps every non-matching one unchanged (`fold_kept`). -/

/-- The selected entry after registration: the new key and compat scope `p`; an old compat
scope nothing else on the entry lists is pinned, so it stays served (Codex audit round 1). -/
def rekey (v : Server) (c p : Nat) : Server :=
  { v with c := c, compat := some p,
           pinned := match v.compat with
             | some o => if o = p ∨ o ∈ v.scopes ∨ o ∈ v.pinned then v.pinned else v.pinned ++ [o]
             | none => v.pinned }

/-- THEOREM: registration keeps every scope the selected entry served (its old compat scope
included), and adds the new compat scope. -/
theorem rekey_keeps_served (v : Server) (c p s : Nat) (h : serves v s) : serves (rekey v c p) s := by
  unfold serves rekey at *
  cases hc : v.compat with
  | none =>
    rw [hc] at h
    rcases h with h | h | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · cases h
  | some o =>
    rw [hc] at h
    simp only
    by_cases hk : o = p ∨ o ∈ v.scopes ∨ o ∈ v.pinned
    · simp only [hk, if_true]
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · cases h
        rcases hk with hk | hk | hk
        · subst hk; exact Or.inr (Or.inr rfl)
        · exact Or.inl hk
        · exact Or.inr (Or.inl hk)
    · simp only [hk, if_false]
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl (List.mem_append_left _ h))
      · cases h; exact Or.inr (Or.inl (List.mem_append_right _ (List.mem_singleton_self _)))

/-- Mutation: replacing the compat scope without pinning the old one drops its route. -/
theorem rekey_unpinned_drops :
    serves srv0 9 ∧ ¬ serves { srv0 with c := 2, compat := some 8 } 9 := by
  refine ⟨Or.inr (Or.inr rfl), ?_⟩
  intro h; rcases h with h | h | h <;> simp [srv0] at h

def register (vs : List Server) (u c p : Nat) : Except Unit (List Server) :=
  match (vs.filter (fun v => v.u = u)).length with
  | 0 => .ok (vs ++ [{ u := u, c := c, ro := false, compat := some p, scopes := [], pinned := [], set := fun _ _ => none }])
  | 1 => .ok (vs.map (fun v => if v.u = u then rekey v c p else v))
  | _ => .error ()

/-- THEOREM: on success every server entry for another url is unchanged, and the one for `u`
carries the new key and the compat scope `p` — never an entry without one. -/
theorem register_only_selected (vs vs' : List Server) (u c p : Nat) (h : register vs u c p = .ok vs') :
    (∀ v ∈ vs', v.u ≠ u → v ∈ vs) ∧ (∀ v ∈ vs', v.u = u → v.c = c ∧ v.compat = some p) ∧
    (∃ v ∈ vs', v.u = u) := by
  unfold register at h
  split at h
  · rename_i h0
    cases h
    refine ⟨?_, ?_, ⟨_, List.mem_append_right _ (List.mem_singleton_self _), rfl⟩⟩
    · intro v hv hne
      rcases List.mem_append.mp hv with hv | hv
      · exact hv
      · simp at hv; subst hv; exact absurd rfl hne
    · intro v hv hu
      rcases List.mem_append.mp hv with hv | hv
      · have : v ∈ vs.filter (fun v => v.u = u) := List.mem_filter.mpr ⟨hv, by simp [hu]⟩
        rw [List.length_eq_zero_iff.mp h0] at this; simp at this
      · simp at hv; subst hv; exact ⟨rfl, rfl⟩
  · rename_i h1
    cases h
    obtain ⟨w, hw⟩ : ∃ w, w ∈ vs.filter (fun v => v.u = u) := by
      cases hl : vs.filter (fun v => v.u = u) with
      | nil => rw [hl] at h1; simp at h1
      | cons a _ => exact ⟨a, List.mem_cons_self ..⟩
    have ⟨hwm, hwu⟩ := List.mem_filter.mp hw
    refine ⟨?_, ?_, ⟨rekey w c p, List.mem_map.mpr ⟨w, hwm, by simp at hwu; simp [hwu]⟩, by simp at hwu; exact hwu⟩⟩
    · intro v hv hne
      obtain ⟨x, hx, hxv⟩ := List.mem_map.mp hv
      by_cases hxu : x.u = u
      · simp [hxu] at hxv; subst hxv; exact absurd (by simp [rekey, hxu]) hne
      · simp [hxu] at hxv; subst hxv; exact hx
    · intro v hv hu
      obtain ⟨x, hx, hxv⟩ := List.mem_map.mp hv
      by_cases hxu : x.u = u
      · simp [hxu] at hxv; subst hxv; exact ⟨rfl, rfl⟩
      · simp [hxu] at hxv; subst hxv; exact absurd hu hxu
  · cases h

theorem register_two_refused (vs : List Server) (u c p : Nat)
    (h : 2 ≤ (vs.filter (fun v => v.u = u)).length) : register vs u c p = .error () := by
  unfold register
  split
  · rename_i h0; omega
  · rename_i h1; omega
  · rfl

/-- Mutation: rekeying every entry on the url (per-scope ones too) moves a per-scope entry
that holds the old key onto the new one — the code keeps it separate instead
(`kept_separate`, why `different-token`). -/
def rekeyAllPer (ps : List PerScope) (u c : Nat) : List PerScope := ps.map (fun q => if q.u = u then { q with c := c } else q)

theorem rekeyAll_changes_other_route :
    Routes srv0 [perK0] 5 (1, 0, false) ∧ ¬ Routes srv0 (rekeyAllPer [perK0] 1 1) 5 (1, 0, false) := by
  refine ⟨Or.inr ⟨perK0, List.mem_cons_self .., rfl, rfl⟩, ?_⟩
  intro h
  rcases h with ⟨hs, _⟩ | ⟨q, hq, _, ht⟩
  · rcases hs with hs | hs | hs <;> simp [srv0] at hs
  · simp [rekeyAllPer, perK0] at hq; subst hq; simp at ht

/-! ### 6b. Order: the entry a write takes (gate review, 2026-10-18)

The routes above are a set, and order is left out. But a write takes the FIRST entry in
config order that serves its scope (store-resolver.ts `remoteOf`; `personalStoreEntry` breaks
ties by order). With order, two folds move a scope onto another key although every route
triple survives (so `fold_preserves_routing` still holds for them):
- folding an entry while an entry that stays serves the same scope with another key ahead of
  the server entry (`fold_moves_first_route`);
- moving the server entry ahead of an entry that serves one of its scopes with another key
  (`move_server_moves_first_route`).
The code keeps the server entry in place (a new one is appended) and keeps such an entry
separate (`scope-served-elsewhere`). `ordered_fold_preserves_first` proves that then the entry
a write to any scope takes has the same route before and after. `R` is the set of folded
scopes; `hnoother` is the `scope-served-elsewhere` rule; `hroute` is `fmatch`. -/

structure OEnt where
  srv : Bool
  rm : Bool
  claims : Nat → Bool
  route : Nat × Nat × Bool

/-- The route of the first entry that serves `s`. -/
def firstOn (s : Nat) : List OEnt → Option (Nat × Nat × Bool)
  | [] => none
  | e :: es => if e.claims s = true then some e.route else firstOn s es

/-- The fold, in place: the server entry gains the folded scopes `R`; folded entries leave. -/
def stepE (R : Nat → Bool) (e : OEnt) : Option OEnt :=
  if e.srv = true then some { e with claims := fun s => e.claims s || R s }
  else if e.rm = true then none else some e

def foldOrdered (R : Nat → Bool) (es : List OEnt) : List OEnt := es.filterMap (stepE R)

theorem firstOn_all (s : Nat) (r : Nat × Nat × Bool) : ∀ l : List OEnt,
    (∀ e ∈ l, e.claims s = true → e.route = r) → (∃ e ∈ l, e.claims s = true) → firstOn s l = some r := by
  intro l
  induction l with
  | nil => intro _ hx; obtain ⟨e, he, _⟩ := hx; simp at he
  | cons e es ih =>
    intro h hx
    by_cases hc : e.claims s = true
    · simp [firstOn, hc, h e (List.mem_cons_self ..) hc]
    · simp only [firstOn, hc, if_false]
      apply ih (fun x hx' => h x (List.mem_cons_of_mem _ hx'))
      obtain ⟨x, hx1, hx2⟩ := hx
      rcases List.mem_cons.mp hx1 with hx1 | hx1
      · subst hx1; exact absurd hx2 hc
      · exact ⟨x, hx1, hx2⟩

theorem firstOn_unclaimed (R : Nat → Bool) (s : Nat) (hR : R s = false) : ∀ l : List OEnt,
    (∀ e ∈ l, e.srv = false → e.rm = true → e.claims s = false) →
    firstOn s (foldOrdered R l) = firstOn s l := by
  intro l
  induction l with
  | nil => intro _; rfl
  | cons e es ih =>
    intro h
    have ih' := ih (fun x hx => h x (List.mem_cons_of_mem _ hx))
    unfold foldOrdered at ih' ⊢
    cases hs : e.srv
    · cases hr : e.rm
      · simp [List.filterMap_cons, stepE, hs, hr, firstOn, ih']
      · have hc := h e (List.mem_cons_self ..) hs hr
        simp [List.filterMap_cons, stepE, hs, hr, firstOn, hc, ih']
    · simp [List.filterMap_cons, stepE, hs, firstOn, hR, ih']

/-- THEOREM (order): with the server entry kept in place and no entry that stays serving a
folded scope, a write to every scope takes an entry with the same route as before. -/
theorem ordered_fold_preserves_first (R : Nat → Bool) (r0 : Nat × Nat × Bool) (es : List OEnt)
    (hsrv : ∃ e ∈ es, e.srv = true)
    (hroute : ∀ e ∈ es, (e.srv = true ∨ e.rm = true) → e.route = r0)
    (hcover : ∀ e ∈ es, e.srv = false → e.rm = true → ∀ s, e.claims s = true → R s = true)
    (hsound : ∀ s, R s = true → ∃ e ∈ es, e.rm = true ∧ e.claims s = true)
    (hnoother : ∀ s, R s = true → ∀ e ∈ es, e.claims s = true → e.srv = true ∨ e.rm = true)
    (s : Nat) : firstOn s (foldOrdered R es) = firstOn s es := by
  cases hRs : R s
  · apply firstOn_unclaimed R s hRs es
    intro e he hs hr
    cases hc : e.claims s
    · rfl
    · have := hcover e he hs hr s hc
      simp [hRs] at this
  · have hb : firstOn s es = some r0 := by
      apply firstOn_all s r0 es
      · intro e he hc; exact hroute e he (hnoother s hRs e he hc)
      · obtain ⟨e, he, _, hc⟩ := hsound s hRs; exact ⟨e, he, hc⟩
    rw [hb]
    apply firstOn_all s r0
    · intro e' he' hc'
      obtain ⟨e, he, hst⟩ := List.mem_filterMap.mp he'
      unfold stepE at hst
      by_cases hs : e.srv = true
      · simp [hs] at hst; subst hst; exact hroute e he (Or.inl hs)
      · by_cases hr : e.rm = true
        · simp [hs, hr] at hst
        · simp [hs, hr] at hst; subst hst
          rcases hnoother s hRs e he hc' with h | h
          · exact absurd h hs
          · exact absurd h hr
    · obtain ⟨e, he, hs⟩ := hsrv
      refine ⟨{ e with claims := fun s => e.claims s || R s }, ?_, by simp [hRs]⟩
      exact List.mem_filterMap.mpr ⟨e, he, by simp [stepE, hs]⟩

def eSrv : OEnt := { srv := true, rm := false, claims := fun _ => false, route := (1, 1, false) }
def eOld : OEnt := { srv := false, rm := false, claims := fun s => s == 5, route := (1, 0, false) }
def eFold : OEnt := { srv := false, rm := true, claims := fun s => s == 5, route := (1, 1, false) }

/-- Counterexample (every hypothesis but `hnoother` holds): scope 5 went out with key 0; after
folding the entry with key 1 into the server entry ahead of it, with key 1. Replayed:
register-enterprise-server.test.ts, "a per-scope entry is not folded while another entry …". -/
theorem fold_moves_first_route :
    firstOn 5 [eSrv, eOld, eFold] = some (1, 0, false) ∧
    firstOn 5 (foldOrdered (fun s => s == 5) [eSrv, eOld, eFold]) = some (1, 1, false) := by
  constructor <;> simp [firstOn, foldOrdered, stepE, eSrv, eOld, eFold]

def eFold7 : OEnt := { srv := false, rm := true, claims := fun s => s == 7, route := (1, 1, false) }
def eSrv5 : OEnt := { srv := true, rm := false, claims := fun s => s == 5, route := (1, 1, false) }

/-- Counterexample to moving the server entry to the first folded entry's place (the code
before the gate review): scope 5, which the server entry serves behind an entry with key 0,
moves onto key 1; in place it does not. Replayed: register-enterprise-server.test.ts,
"folding never moves the server entry ahead of …". -/
theorem move_server_moves_first_route :
    firstOn 5 [eFold7, eOld, eSrv5] = some (1, 0, false) ∧
    firstOn 5 (foldOrdered (fun s => s == 7) [eFold7, eOld, eSrv5]) = some (1, 0, false) ∧
    firstOn 5 [{ eSrv5 with claims := fun s => eSrv5.claims s || s == 7 }, eOld] = some (1, 1, false) := by
  refine ⟨?_, ?_, ?_⟩ <;> simp [firstOn, foldOrdered, stepE, eFold7, eOld, eSrv5]

end PlurSpec.StoreEntry
