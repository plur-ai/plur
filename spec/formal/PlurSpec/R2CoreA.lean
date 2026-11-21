/-!
# R2CoreA — round 2, core index / provenance (packages/core/src/index.ts, packages/core/src/plur/, provenance.ts)

Checked against #1631 (config.yaml owner-only, 2026-10-18): still holds. index.ts's only
change swaps the config.yaml writes for `writeConfigFile` (same content, same lock) and adds
re-exports; nothing this model covers changed.

Each section names the code it mirrors. Payloads (statements, ids, scope
classification, store configuration) are abstracted as oracles and parameters:
theorems hold for every oracle.

Findings and replays: spec/formal/findings/r2-corea.md.

Checked against registerEnterpriseServer (#1631 plan B Task 5, branch agent/efi-b05, 2026-10-18): still holds.
Rechecked after the gate review and Codex audit rounds 1-2 on the same branch (2026-10-18): still holds.
index.ts changed only inside registerEnterpriseServer (error wording); server-discovery.ts only in the
registration/fold functions, which StoreEntry §6/§6b model.
index.ts gains `registerEnterpriseServer`, a new public method that writes config.yaml through
`_updateRawStores` (config lock, atomic write) and reads `listOutbox`; no existing branch modelled
here changed. The registration and fold are modelled in StoreEntry §6.

Checked against the outbox lease (decision D2, PR #1231): index.ts gained a lease on outbox
rows (`_outboxLease` bookkeeping, taken and released around each push) and `listOutbox` reports
`leased_until`. Decision C3 (2026-09-30 merge of main) removed the lease again: #1277's per-entry
claims guard the push, and `leased_until` is read from the claim file. No section here models the flush's claim logic — the team-write, egress,
refcount and retire-kind theorems concern which rows are queued and what they carry, and a
lease changes neither — so every theorem still holds. The lease itself: WritePath §1c.

Checked against #1349 (merged into #1228 on 2026-09-30): still holds. index.ts's
only change is a re-export of `pendingStoreLockOps`, and no modelled branch changed.

Checked against #1631 (epic/1797 first install, 2026-10-18): still holds.
index.ts's predicates now read `resolveScopeTarget` (WritePath §3c).
- §1: `provenanceFor` passes `_isRemoteWriteScope` (the section text said
  `_isRemoteBackedScope`; the code has passed the write rule since
  core-index#9b). A conflicted or ungranted scope now answers false, which by
  `unknown_backing_stricter` can only withhold more.
- §5b: `_crossScopeRecurrenceApplies = !_isRemoteWriteScope` is true for a
  conflicted scope, but learn() and learnRouted() throw `ScopeConflictError`
  (`_refuseScopeConflict`) before dedup, so no conflicted write reaches §5.
  For one server the writable rule is the old one.
- §2–§4, §6–§8: the forget/feedback guard, refcounted retirement, the egress
  reload, the update walk and Decision R are not in the diff. The new code
  (`refreshServerScopes`, the server-entry `persistStores` collapse, the
  server-key rotation in `addStore`) is StoreEntry's territory, not modelled here.

Checked against #1521 (remote-only folders, merged onto development 2026-10-18): still holds.
While bound to a remote-only folder, `_probeIdCollisions` and the remote walks of forget,
feedback, setPinned and update skip url stores whose scope is not a deliverable team scope,
and a bare id only on a team-scope row; the local row they would act on is refused first
(`_remoteOnlyRefuseLocalRow`) unless it is this folder's queued save. Unbound, every walk is
as modelled in §2–§4. `peek_absent_sound` reads the same cache. The write gate is WritePath §3d.
Gate review of #1663 (2026-10-18): still holds. While bound, those walks (and the bare-id update)
are narrowed further, to the folder's own team store or the store of an explicit deliverable team
scope, and an explicit team scope first checks that the row it names there is in that team scope.
Each is a filter that only removes candidates before the modelled walk; unbound, nothing changed.
Codex round 3 (2026-10-18): still holds. While bound, the bare-id update uses the resolver's exact
target and a held team row (tri-state probe), the explicit-scope check is tri-state (unknown refuses),
getByIds drops a personal row from the team host, and cache warming, store listing and old-form id
resolution contact only the folder's own team store. Again only filters; unbound, unchanged.
Codex round 4 (2026-10-18): still holds. nearDuplicates and similaritySearch use no embedder while
bound, and a bound operation starts no embedding pass; no modelled branch changed.
Codex round 5 (2026-10-18): still holds. Bare-id walks need positive team ownership on the host
(tri-state probe); recallAsync/recallExpanded/recallAutoSearch use keyword recall and
rerankerSelfEval refuses while bound; the remote-only dial needs the folder scope exactly in a
scopes allow-list. Only filters and refusals; unbound, unchanged.
Codex round 8 (2026-10-18): still holds. A public mutator captures the remote-only binding when it
starts and keeps it to the end (the store lock's AsyncLocalStorage); unbound, nothing changed.
Gate structural changes (2026-10-18): still holds. The capture is now one choke point over every
public async method; a queued remote-only save (isRemoteOnlyQueued) is left out of the local
indexes, the embedder and its cache, and local provenance, whatever the binding. Only exclusions.

Rechecked after Codex audit rounds 3-5 on branch agent/efi-b05 (2026-10-18): still holds. The changes are
refusals and eligibility checks inside registerEnterpriseServer/registerServerEntry/foldStoresIntoServerEntry
(nothing is written on a refusal), the outbox read moved before the write, and config.ts's unset-token_env
warning naming the url by origin; no modelled branch changed.

Checked against #1631 background discovery (PR gate, 2026-10-18): still holds.
index.ts only adds `_serverDiscoveryEndpoints()`, a read of config.yaml that lists the
urls `refreshServerScopes` probes (the same `isEnterpriseServerEntry` filter). It
writes nothing and is read only by the MCP server; no section here reads it.

Checked against #1633 (plan B Task 7, owner decision O5, 2026-10-18): still holds.
`_isRemoteWriteScope` now reads `_remoteWriteEntry`, the same resolver answer
(`remote` and writable); provenance and the recurrence gate see no change.

Checked against #1638 (`plur login` device sign-in, plan C Task 3, branch agent/efi-c03, 2026-10-18):
still holds. registerServerEntry's refusal to take over the personal scope is unchanged (the same
holders, the same message); it is now a `PersonalScopeTakenError` that names those holders, and
`removeStale` drops exactly them before the same registration runs again, in the same locked write
(modelled in Login.lean §2: only holders are removed, never without the flag, no holder left).
No section here reads registration.


Checked 2026-10-19 for git-origin folder defaults: GitFolder models the added
folder-policy admission and operation-captured default. Existing explicit scopes,
remote-only gates, store resolution, persistence and outbox delivery rules are
unchanged. The remote recall change only suppresses calls for a local/unknown
origin default; a deliberate call/session scope keeps the existing routing.
-/

namespace PlurSpec.R2CoreA

/-! ## 1. Decision E6 — provenance `withheld` (provenance.ts `isWithheld`)

`shared` is `isSharedScope`, abstract. `remoteBacked` is what `Plur.provenanceFor`
passes (`_isRemoteBackedScope(scope)`); a direct caller that passes nothing
gets `false`. A record's scope may be absent (hand-made / older record). -/

inductive Vis where
  | none | priv | pub | template
  deriving DecidableEq, Repr

/-- BEFORE (round 1 tree): `visibility === 'private' || scope === 'local'`. -/
def withheldOld (isLocal : String → Bool) (scope : Option String) (v : Vis) : Bool :=
  v == .priv || (match scope with | some s => isLocal s | none => false)

/-- Does the scope leave the machine? Missing scope: no (fail closed). -/
def leaves (shared : String → Bool) (rb : Bool) : Option String → Bool
  | some s => shared s || rb
  | none => false

/-- AFTER (Decision E6): private, or (does not leave ∧ not explicitly public). -/
def withheld (shared : String → Bool) (rb : Bool) (scope : Option String) (v : Vis) : Bool :=
  if v == .priv then true
  else !leaves shared rb scope && !(v == .pub)

theorem withheld_iff (shared : String → Bool) (rb : Bool) (scope : Option String) (v : Vis) :
    withheld shared rb scope v = true ↔
      (v = .priv ∨ (leaves shared rb scope = false ∧ v ≠ .pub)) := by
  unfold withheld
  cases v <;> cases h : leaves shared rb scope <;> simp

/-- Packs stay shareable: an explicit `public` is never withheld, wherever it lives. -/
theorem public_never_withheld (shared : String → Bool) (rb : Bool) (scope : Option String) :
    withheld shared rb scope .pub = false := by
  unfold withheld; cases leaves shared rb scope <;> rfl

/-- The E6 change: a personal-family scope no remote store backs is withheld
unless explicitly public (global, user:*, agent:*, local alike). -/
theorem onmachine_nonpublic_withheld (shared : String → Bool) (s : String) (v : Vis)
    (hs : shared s = false) (hv : v ≠ .pub) :
    withheld shared false (some s) v = true := by
  unfold withheld leaves
  cases v <;> simp_all

/-- A record with no scope is treated as not leaving (fail closed). -/
theorem missing_scope_withheld (shared : String → Bool) (rb : Bool) (v : Vis) (hv : v ≠ .pub) :
    withheld shared rb none v = true := by
  unfold withheld leaves
  cases v <;> simp_all

/-- A shared or remote-backed scope is not withheld unless private (non-vacuity). -/
theorem leaving_not_withheld (shared : String → Bool) (rb : Bool) (s : String) (v : Vis)
    (hl : shared s = true ∨ rb = true) (hv : v ≠ .priv) :
    withheld shared rb (some s) v = false := by
  unfold withheld leaves
  rcases hl with h | h <;> cases v <;> simp_all

/-- Not knowing the store configuration can only withhold MORE (fail closed):
the summary's fallback (`rb = false`) is at least as strict as the record. -/
theorem unknown_backing_stricter (shared : String → Bool) (scope : Option String) (v : Vis)
    (h : withheld shared true scope v = true) : withheld shared false scope v = true := by
  revert h
  unfold withheld leaves
  cases scope <;> cases v <;> simp_all

/-- Counterexample on the OLD predicate (= test "withholds a global memory that
is not marked public"): any personal scope other than `local` (e.g. `global`),
visibility `template` — old says shareable, E6 says withheld. -/
theorem old_global_template_shareable (isLocal shared : String → Bool) (s : String)
    (hl : isLocal s = false) (hs : shared s = false) :
    withheldOld isLocal (some s) .template = false ∧
    withheld shared false (some s) .template = true := by
  simp [withheldOld, withheld, leaves, hl, hs]

/-- Old predicate withheld `local` + explicit `public`; E6 clears it. -/
theorem old_local_public_withheld (isLocal shared : String → Bool) (s : String)
    (hl : isLocal s = true) :
    withheldOld isLocal (some s) .pub = true ∧
    withheld shared false (some s) .pub = false := by
  refine ⟨by simp [withheldOld, hl], public_never_withheld shared false (some s)⟩

/-! ### 1b. The summary (`summariseProvenance`, core-policy#9)

`share` is the record's `engram:maySharePlainly` if present. No engram node ⇒
no answer at all. -/

structure Subject where
  share : Option Bool
  scope : Option String
  vis   : Vis

/-- AFTER: no subject ⇒ may not leave; the record's answer wins; else the E6 rule
with backing unknown. -/
def mayLeave (shared : String → Bool) : Option Subject → Bool
  | none => false
  | some s => match s.share with
    | some b => b
    | none => !withheld shared false s.scope s.vis

/-- BEFORE: initialised `true`; recomputed only as `!(private ∨ local)`; a missing
subject left the initial `true`. -/
def mayLeaveOld (isLocal : String → Bool) : Option Subject → Bool
  | none => true
  | some s => !withheldOld isLocal s.scope s.vis

theorem summary_no_subject_closed (shared : String → Bool) : mayLeave shared none = false := rfl


/-- An older record with no share answer: the summary is at least as strict as
a record built with any backing. -/
theorem summary_fallback_sound (shared : String → Bool) (rb : Bool) (sc : Option String) (v : Vis)
    (h : mayLeave shared (some ⟨none, sc, v⟩) = true) : withheld shared rb sc v = false := by
  simp only [mayLeave] at h
  cases hw : withheld shared rb sc v
  · rfl
  · have := unknown_backing_stricter shared sc v
    cases rb
    · simp_all
    · simp_all

theorem old_summary_no_subject_open (isLocal : String → Bool) : mayLeaveOld isLocal none = true := rfl

/-- The subject a provenance record carries: no engram node (`present` false),
or a node with the scope and visibility, whose share answer was written by
`provenanceFor` with this install's backing `rb` (`answered`), or is missing
(an older record). -/
def recordSubject (present answered : Bool) (shared : String → Bool) (rb : Bool)
    (sc : Option String) (v : Vis) : Option Subject :=
  if present then some ⟨if answered then some (!withheld shared rb sc v) else none, sc, v⟩ else none

/-- The summary never says "may leave" where the record would withhold, on every
branch: no node, the record's own answer, or the fallback for an older record. -/
theorem summary_agrees_with_record (shared : String → Bool) (rb : Bool) (sc : Option String) (v : Vis)
    (present answered : Bool)
    (h : mayLeave shared (recordSubject present answered shared rb sc v) = true) :
    present = true ∧ withheld shared rb sc v = false := by
  cases present
  · simp [recordSubject, mayLeave] at h
  · refine ⟨rfl, ?_⟩
    cases answered
    · exact summary_fallback_sound shared rb sc v (by simpa [recordSubject] using h)
    · simpa [recordSubject, mayLeave] using h

/-- A private memory is withheld wherever it lives (a shared or remote-backed
scope included), and no record of it, answered or older, lets the summary say
it may leave. -/
theorem private_always_withheld (shared : String → Bool) (rb : Bool) (scope : Option String)
    (answered : Bool) :
    withheld shared rb scope .priv = true ∧
    mayLeave shared (recordSubject true answered shared rb scope .priv) = false := by
  cases answered <;> simp [withheld, mayLeave, recordSubject]

/-! ### 1c. Licence source (`summariseProvenance`, core-policy#9)

`wasDecided` holds for chosen / configuredDefault / inheritedFromPack. -/

inductive LicSrc where
  | chosen | configuredDefault | inheritedFromPack | schemaDefault
  deriving DecidableEq, Repr

def wasDecided : LicSrc → Bool
  | .schemaDefault => false
  | _ => true

/-- BEFORE: a missing source read as `chosen`. -/
def srcOld : Option LicSrc → LicSrc
  | some s => s
  | none => .chosen

/-- AFTER: missing (or unknown) ⇒ not known to be decided ⇒ fail closed. -/
def srcNew : Option LicSrc → LicSrc
  | some s => s
  | none => .schemaDefault

/-- The two reuse booleans, given what the recognised policy permits. -/
def mayReuse (src : LicSrc) (policyYes : Bool) : Bool :=
  policyYes && wasDecided src

theorem missing_source_closed (policyYes : Bool) : mayReuse (srcNew none) policyYes = false := by
  cases policyYes <;> rfl

theorem recorded_source_kept (s : LicSrc) : srcNew (some s) = s := rfl

theorem chosen_good_case : mayReuse (srcNew (some .chosen)) true = true := rfl

theorem old_missing_source_open : mayReuse (srcOld none) true = true := rfl

/-! ## 2. forget / feedback ambiguity guard and the remote cache (core-index#7)

Code: `Plur._remoteCacheAnswer` (new), the #831 guard in `forget()` and the #850
guard in `feedback()`. `R` is the remote's truth for "this server id exists".
A cache is `(ts, ids)`; `append()` on a cold cache seeds `ts = 0` (a partial
view). The live probe (`existsById`) is exact or throws (then forget refuses,
feedback warns) — modelled as returning `R x`. -/

structure Cache where
  ts  : Nat
  ids : List Nat

inductive Peek where
  | present | absent | unknown
  deriving DecidableEq, Repr

/-- AFTER: absence only from a complete (`ts > 0`) load younger than the TTL. -/
def peekNew (now ttl : Nat) : Option Cache → Nat → Peek
  | none, _ => .unknown
  | some c, x =>
    if c.ids.isEmpty then .unknown
    else if c.ids.contains x then .present
    else if c.ts > 0 ∧ now - c.ts < ttl then .absent
    else .unknown

/-- BEFORE: any non-empty cache is authoritative. -/
def peekOld : Option Cache → Nat → Peek
  | none, _ => .unknown
  | some c, x =>
    if c.ids.isEmpty then .unknown
    else if c.ids.contains x then .present else .absent

/-- Does the guard let the LOCAL retire/rating proceed? (`true` = proceed.) -/
def proceeds (peek : Option Cache → Nat → Peek) (R : Nat → Bool) (c : Option Cache) (x : Nat) : Bool :=
  match peek c x with
  | .present => false
  | .absent => true
  | .unknown => !R x

/-- What a cache may be relied on for: every cached id is real, and a complete
load inside its TTL lists every remote id (the accepted freshness window). -/
def Accurate (R : Nat → Bool) (now ttl : Nat) : Option Cache → Prop
  | none => True
  | some c => (∀ x, c.ids.contains x = true → R x = true) ∧
      ((c.ts > 0 ∧ now - c.ts < ttl) → ∀ x, R x = true → c.ids.contains x = true)

/-- Soundness: the fixed guard lets a local retire proceed only when the id is
absent remotely — for partial (`ts = 0`) and stale caches too. -/
theorem peek_absent_sound (R : Nat → Bool) (now ttl : Nat) (c : Option Cache) (x : Nat)
    (hacc : Accurate R now ttl c) (hp : proceeds (peekNew now ttl) R c x = true) : R x = false := by
  cases c with
  | none => simpa [proceeds, peekNew] using hp
  | some c =>
    obtain ⟨_, hfull⟩ := hacc
    dsimp only [proceeds, peekNew] at hp
    by_cases he : c.ids.isEmpty = true
    · simp only [he, ↓reduceIte, Bool.not_eq_true'] at hp; exact hp
    · by_cases hc : c.ids.contains x = true
      · simp only [he, hc, ↓reduceIte, Bool.false_eq_true] at hp
      · by_cases hf : c.ts > 0 ∧ now - c.ts < ttl
        · cases hR : R x
          · rfl
          · exact absurd (hfull hf x hR) hc
        · simp only [he, hc, hf, ↓reduceIte, Bool.false_eq_true, Bool.not_eq_true'] at hp; exact hp

/-- Non-vacuity: a fresh complete cache that lacks the id answers without a probe. -/
theorem fresh_cache_answers :
    peekNew 100 60 (some ⟨90, [7]⟩) 3 = .absent := by decide

/-- Counterexample on the OLD guard (= tests "after a cold-cache push …"): the
append-seeded partial cache `{ts := 0, ids := [1]}` hides remote id 2. -/
theorem old_partial_cache_retires_twin :
    proceeds peekOld (fun x => x == 1 || x == 2) (some ⟨0, [1]⟩) 2 = true ∧
    proceeds (peekNew 100 60) (fun x => x == 1 || x == 2) (some ⟨0, [1]⟩) 2 = false := by
  decide

/-- Counterexample on the OLD guard with a stale cache (test "a stale … cache"). -/
theorem old_stale_cache_retires_twin :
    proceeds peekOld (fun x => x == 2) (some ⟨10, [5]⟩) 2 = true ∧
    proceeds (peekNew 1000 60) (fun x => x == 2) (some ⟨10, [5]⟩) 2 = false := by
  decide

/-! ## 3. Reference-counted retirement across stores (core-index#8, #107)

Code: `_recordDuplicate` (dedup hit ⇒ `write_count + 1`), `forget()` primary
and secondary branches (decrement; retire at 0), remote branch (DELETE). A
store's persisted row is `(count, active)`. -/

inductive Kind where
  | primary | secondaryW | secondaryRO | remote
  deriving DecidableEq, Repr

/-- Where forget() decrements (and so where #107 applies). -/
def counts : Kind → Bool
  | .primary | .secondaryW => true
  | _ => false

structure PRow where
  count  : Nat
  active : Bool
  deriving DecidableEq, Repr

/-- AFTER: a duplicate write persists the increment wherever forget decrements. -/
def dupNew (k : Kind) (r : PRow) : PRow :=
  if counts k && r.active then { r with count := r.count + 1 } else r

/-- BEFORE: persisted only for the primary store. -/
def dupOld (k : Kind) (r : PRow) : PRow :=
  if k == .primary && r.active then { r with count := r.count + 1 } else r

def forgetOne (k : Kind) (r : PRow) : PRow :=
  if counts k then
    let c := r.count - 1
    { count := c, active := r.active && c != 0 }
  else { r with active := false }

def dups (dup : Kind → PRow → PRow) (k : Kind) : Nat → PRow → PRow
  | 0, r => r
  | n + 1, r => dups dup k n (dup k r)

def forgets (k : Kind) : Nat → PRow → PRow
  | 0, r => r
  | n + 1, r => forgets k n (forgetOne k r)

theorem dups_count (k : Kind) (hk : counts k = true) :
    ∀ n c, dups dupNew k n ⟨c, true⟩ = ⟨c + n, true⟩ := by
  intro n
  induction n with
  | zero => intro c; rfl
  | succ n ih =>
    intro c
    simp only [dups, dupNew, hk, Bool.and_self, ↓reduceIte]
    rw [ih]; simp [Nat.add_assoc, Nat.add_comm 1 n]

theorem forgets_count (k : Kind) (hk : counts k = true) :
    ∀ m c, m < c → forgets k m ⟨c, true⟩ = ⟨c - m, true⟩ := by
  intro m
  induction m with
  | zero => intro c _; rfl
  | succ m ih =>
    intro c h
    simp only [forgets, forgetOne, hk, ↓reduceIte, Bool.true_and]
    have hc : (c - 1 != 0) = true := by
      simp only [bne_iff_ne, ne_eq]; omega
    rw [hc, ih (c - 1) (by omega)]
    congr 1; omega

/-- #107 in every store that counts: `1 + n` writers, `k ≤ n` forgets ⇒ still active. -/
theorem refcount_symmetric (k : Kind) (hk : counts k = true) (n m : Nat) (h : m ≤ n) :
    (forgets k m (dups dupNew k n ⟨1, true⟩)).active = true := by
  rw [dups_count k hk n 1, forgets_count k hk m (1 + n) (by omega)]

/-- …and the last forget retires (non-vacuity). -/
theorem refcount_last_retires :
    (forgets .secondaryW 2 (dups dupNew .secondaryW 1 ⟨1, true⟩)).active = false := by decide

/-- Counterexample on the OLD dedup (= test "two writers, one forget"). -/
theorem old_secondary_two_writers_one_forget :
    (forgets .secondaryW 1 (dups dupOld .secondaryW 1 ⟨1, true⟩)).active = false ∧
    (forgets .secondaryW 1 (dups dupNew .secondaryW 1 ⟨1, true⟩)).active = true := by decide

/-- Readonly stores are never written by a duplicate. -/
theorem readonly_untouched (r : PRow) : dupNew .secondaryRO r = r := by
  simp [dupNew, counts]

/-! ## 4. Egress guard reads the current config; update walk (core-index#9)

### 4a. `_guardSensitiveScope` / `_flushOutboxClaimed` / `_updateEngramReturning`

A process holds an in-memory config; the file on disk may be newer. `forbids c x`
is the scope policy of config `c` (abstract). An egress step pushes `x` iff the
config it consults does not forbid it. Reload = consult the on-disk config. -/

structure Proc (Cfg : Type) where
  mem  : Cfg   -- this.config
  disk : Cfg   -- config.yaml now

def pushesOld {Cfg : Type} (forbids : Cfg → Nat → Bool) (p : Proc Cfg) (x : Nat) : Bool :=
  !forbids p.mem x

def pushesNew {Cfg : Type} (forbids : Cfg → Nat → Bool) (p : Proc Cfg) (x : Nat) : Bool :=
  !forbids p.disk x   -- reloadConfigIfChanged() first

/-- Nothing the CURRENT policy forbids is pushed. -/
theorem egress_current_policy {Cfg : Type} (forbids : Cfg → Nat → Bool) (p : Proc Cfg) (x : Nat)
    (h : pushesNew forbids p x = true) : forbids p.disk x = false := by
  simpa [pushesNew] using h

/-- Counterexample on the old guard (= tests "policy tightened out of process"):
started permissive (`mem`), tightened on disk. -/
theorem old_stale_policy_pushes :
    pushesOld (fun (c : Bool) (_ : Nat) => c) ⟨false, true⟩ 0 = true ∧
    pushesNew (fun (c : Bool) (_ : Nat) => c) ⟨false, true⟩ 0 = false := by decide

/-! ### 4b. `updateEngram` remote walk

Stores are listed in config order; `named s` = the id is namespaced to `s`
(`_stripRemotePrefix` strips). The walk guards and PATCHes each candidate. -/

def candidatesOld (stores : List Nat) (_named : Nat → Bool) : List Nat := stores

def candidatesNew (stores : List Nat) (named : Nat → Bool) : List Nat :=
  let n := stores.filter named
  if n.isEmpty then stores else n

/-- A namespaced id is guarded and PATCHed only at the store(s) it names. -/
theorem update_only_named (stores : List Nat) (named : Nat → Bool) (s : Nat)
    (hsome : (stores.filter named).isEmpty = false) (hs : s ∈ candidatesNew stores named) :
    named s = true := by
  simp only [candidatesNew, hsome] at hs
  exact (List.mem_filter.mp hs).2

/-- A bare id keeps the full walk (ownership unknown) — non-vacuity. -/
theorem update_bare_full_walk (stores : List Nat) :
    candidatesNew stores (fun _ => false) = stores := by
  simp [candidatesNew]

/-- Counterexample on the old walk (= test "store A never receives the PATCH"). -/
theorem old_walk_patches_other_store :
    candidatesOld [1, 2] (fun s => s == 2) = [1, 2] ∧
    candidatesNew [1, 2] (fun s => s == 2) = [2] := by decide

/-! ### 4c. Prefix collisions: disambiguate on the full store scope (audit of #1228)

`storePrefix` is three letters, so two store scopes can share one
(group:plur/eng, group:plur/ops → GPL) and a namespaced id then `named`s both.
`owner s` = the row's `_storeScope` stamp is `s`, or (no stamp match) `s`'s
scope contains the row's scope. Among several named stores only the owners are
walked; an owner filter that matches nothing keeps the named set (never widens
back to every store). The same stamp narrows `_findEngramStore` for a hit's
holder / recurrence write (path stores), which also tries the unstripped id
(finding 2: a store file that already holds the namespaced id). -/

def candidatesDis (stores : List Nat) (named owner : Nat → Bool) : List Nat :=
  let n := stores.filter named
  if n.isEmpty then stores else
    let o := n.filter owner
    if o.isEmpty then n else o

/-- Still only named stores for a namespaced id. -/
theorem dis_only_named (stores : List Nat) (named owner : Nat → Bool) (s : Nat)
    (hsome : (stores.filter named).isEmpty = false) (hs : s ∈ candidatesDis stores named owner) :
    named s = true := by
  unfold candidatesDis at hs
  dsimp only at hs
  simp only [hsome, Bool.false_eq_true, ↓reduceIte] at hs
  split at hs
  · exact (List.mem_filter.mp hs).2
  · exact (List.mem_filter.mp (List.mem_filter.mp hs).1).2

/-- When some named store owns the row, no other store is guarded or PATCHed. -/
theorem dis_only_owner (stores : List Nat) (named owner : Nat → Bool) (s : Nat)
    (hown : ((stores.filter named).filter owner).isEmpty = false)
    (hs : s ∈ candidatesDis stores named owner) : owner s = true ∧ named s = true := by
  have hsome : (stores.filter named).isEmpty = false := by
    cases h : stores.filter named with
    | nil => simp [h] at hown
    | cons _ _ => rfl
  unfold candidatesDis at hs
  dsimp only at hs
  simp only [hsome, hown, Bool.false_eq_true, ↓reduceIte] at hs
  exact ⟨(List.mem_filter.mp hs).2, (List.mem_filter.mp (List.mem_filter.mp hs).1).2⟩

/-- Counterexample (replayed in formal-audit-core-prefix-collision): with two
stores named by one prefix, the #9c walk still guards and PATCHes store 1 for
store 2's row; the owner filter does not. Non-vacuity: no owner → the named set. -/
theorem collision_walk :
    candidatesNew [1, 2] (fun _ => true) = [1, 2] ∧
    candidatesDis [1, 2] (fun _ => true) (fun s => s == 2) = [2] ∧
    candidatesDis [1, 2] (fun _ => true) (fun _ => false) = [1, 2] ∧
    candidatesDis [1, 2, 3] (fun s => s != 3) (fun _ => false) = [1, 2] := by decide

/-! ## 5. Dedup / cross-scope recurrence can swallow a write (core-index#10)

Code: `learn()` — `_learnHashMatch` / `_crossScopeMatch` over the corpus incl.
secondary stores, packs and the remote cache. A write is DURABLE if afterwards
some store the user owns holds the statement: the new row, or a hit it was
absorbed into that was persisted.

**Decision A applied (owner, 2026-09-27, "always store my write"):** only a hit
the writer can persist (`_hitHolder` = primary / writable secondary /
the writable remote of this very scope) absorbs a write. A hit held only in a
pack, a readonly store or another scope's remote cache gets a NEW row in the
requested scope and a history-only `recurrence_detected` note; the hit itself is
never mutated. The old behaviour (any hit absorbs; `persisted_to: 'in-memory'`)
is kept below as `storesNewRowOld` and its counterexample. -/

inductive HitAt where
  | none | primary | secondaryW | ownRemote | readonlyOrPack | remoteCache
  deriving DecidableEq, Repr

/-- `_hitHolder` ∈ {primary, secondary, own-remote}. -/
def persistable : HitAt → Bool
  | .primary | .secondaryW | .ownRemote => true
  | _ => false

/-- Pre-Decision-A learn(): any hit absorbs the write; a miss creates a row. -/
def storesNewRowOld : HitAt → Bool
  | .none => true
  | _ => false

/-- Decision A: a new row unless the hit is the writer's own. -/
def storesNewRow (h : HitAt) : Bool := !persistable h

/-- Does the write mutate the hit (write_count / sources / recurrence)? Only an
own hit is mutated; a foreign one only gets a history note. -/
def mutatesHit (h : HitAt) : Bool := persistable h

/-- A history-only `recurrence_detected` against the hit. -/
def notesHistoryOnly (h : HitAt) : Bool := h != .none && !persistable h

def durableWith (newRow : HitAt → Bool) (h : HitAt) : Bool := newRow h || persistable h
def durable := durableWith storesNewRow

/-- **Decision A:** every write is durable, whatever the corpus holds. -/
theorem every_write_durable (h : HitAt) : durable h = true := by
  cases h <;> rfl

/-- A pack / readonly / other-remote hit is never mutated, and the recurrence
is recorded in history only. -/
theorem foreign_hit_untouched (h : HitAt) (hf : persistable h = false) (hn : h ≠ .none) :
    mutatesHit h = false ∧ notesHistoryOnly h = true ∧ storesNewRow h = true := by
  cases h <;> simp_all [mutatesHit, notesHistoryOnly, storesNewRow, persistable]

/-- Non-vacuity: an own hit still absorbs (same-scope #107 / #176 unchanged). -/
theorem own_hit_absorbs : storesNewRow .primary = false ∧ storesNewRow .secondaryW = false
    ∧ storesNewRow .ownRemote = false ∧ storesNewRow .none = true := by decide

/-- Old behaviour, witness (= replay "pack swallow" and the old pinned
`cross-scope-recurrence.test.ts` audit iter-4 case): nothing durable remains. -/
theorem old_pack_hit_swallows :
    durableWith storesNewRowOld .readonlyOrPack = false ∧ durableWith storesNewRowOld .remoteCache = false := by
  decide

/-- Every absorption into a persistable hit is durable (both versions). -/
theorem persistable_hit_durable (h : HitAt) (hp : persistable h = true) : durable h = true := by
  simp [durable, durableWith, hp]

/-! ### 5a. Which hits are the writer's own (`_hitHolder`)

Branch for branch. `goesRemote` is `_isRemoteWriteScope`: a write to that scope
goes to its url store, false when a local store is selected for it. -/

structure Hit where
  pack        : Bool                  -- `_pack`
  storeScope  : Option Nat            -- `_storeScope`
  found       : Option (Bool × Bool)  -- `_findEngramStore`: (is the primary file, readonly)
  urlWritable : Bool                  -- a writable url entry serves `storeScope`

def hitHolder (goesRemote : Nat → Bool) (hit : Hit) (scope : Nat) : HitAt :=
  if hit.pack then .readonlyOrPack else
  match hit.storeScope with
  | none => .primary
  | some t =>
    match hit.found with
    | some (true, _) => .primary
    | some (false, ro) => if ro then .readonlyOrPack else .secondaryW
    | none =>
      if !hit.urlWritable then .readonlyOrPack
      else if t == scope && goesRemote scope then .ownRemote else .remoteCache

/-- A url store's cached row absorbs a write exactly when it is cached for the
very scope written, that store is writable, and the write to that scope goes
to it. In particular, with a local store selected for the scope, the cached
row (even of the identical scope) is never mutated and the write gets its own
row. -/
theorem cache_row_yields_to_local_store (goesRemote : Nat → Bool) (hit : Hit) (scope t : Nat)
    (hp : hit.pack = false) (hs : hit.storeScope = some t) (hf : hit.found = none) :
    (persistable (hitHolder goesRemote hit scope) = true ↔
      (hit.urlWritable = true ∧ t = scope ∧ goesRemote scope = true)) ∧
    (goesRemote scope = false →
      mutatesHit (hitHolder goesRemote hit scope) = false ∧
      storesNewRow (hitHolder goesRemote hit scope) = true) := by
  cases hw : hit.urlWritable <;> cases hg : goesRemote scope <;>
    by_cases ht : t = scope <;>
    simp [hitHolder, hp, hs, hf, hw, hg, ht, persistable, mutatesHit, storesNewRow]

/-- Non-vacuity: the cached row of the scope written, with the write going to
that store, is the writer's own. -/
theorem own_remote_reachable :
    hitHolder (fun _ => true) ⟨false, some 3, none, true⟩ 3 = .ownRemote ∧
    hitHolder (fun _ => false) ⟨false, some 3, none, true⟩ 3 = .remoteCache := by decide

/-! ### 5b. An explicit team write is not absorbed by a cross-scope hit

Code: `_crossScopeRecurrenceApplies(scope) = !_isRemoteWriteScope(scope)`,
consulted by learn(), learnRouted()'s remote route and `wouldDeduplicate`.
`sameScope` = a same-scope hash match exists; `cross` = a cross-scope one. -/

/-- Outcome of a write: absorbed into an existing engram, or a new row (which,
for a remote-write scope, is POSTed or queued). -/
inductive Outcome where
  | absorbed | newRow
  deriving DecidableEq, Repr

def writeOld (_remoteWrite sameScope cross : Bool) : Outcome :=
  if sameScope then .absorbed else if cross then .absorbed else .newRow

def writeNew (remoteWrite sameScope cross : Bool) : Outcome :=
  if sameScope then .absorbed else if cross && !remoteWrite then .absorbed else .newRow

/-- A team write with no same-scope duplicate always produces a new row — so it
is delivered (pushed or queued), whatever exists in other scopes. -/
theorem team_write_delivered (cross : Bool) : writeNew true false cross = .newRow := by
  cases cross <;> rfl

/-- Non-vacuity: the same-scope dedup still absorbs a team repeat, and #176
still applies to non-remote scopes. -/
theorem team_repeat_deduped (cross : Bool) : writeNew true true cross = .absorbed := rfl
theorem local_recurrence_kept : writeNew false false true = .absorbed := rfl

/-- Counterexample on the old route (= test "learnRouted: the team store receives it"). -/
theorem old_team_write_swallowed : writeOld true false true = .absorbed := rfl

/-! ## 6. Decision R — a re-run changes nothing (core-retrieval#10)

**Decision R applied (owner, 2026-09-27, "re-runs change nothing"):** the
importer (`importers/engine.ts`) asks `Plur.wouldDeduplicate` BEFORE learn(); a
record that already exists is reported `skipped` and the store is untouched.
Before, learn() on the hit bumped `write_count` (and appended a source, or
recorded recurrence) while the report still said `skipped`.

Store = list of (content key, write count). A record = its key, or `none` for
a secret/unhashable record (the other gates are R2Retrieval.Importer's). -/
namespace Reimport

abbrev Store := List (Nat × Nat)

inductive Act | imported | skipped
  deriving DecidableEq, Repr

def has (s : Store) (k : Nat) : Bool := s.any (·.1 == k)

def bump (k : Nat) : Store → Store
  | [] => []
  | (k', n) :: rest => if k' == k then (k', n + 1) :: rest else (k', n) :: bump k rest

/-- Old real step: learn() on a hit bumps it, then reports skipped. -/
def realOld (s : Store) (k : Nat) : Act × Store :=
  if has s k then (.skipped, bump k s) else (.imported, (k, 1) :: s)

/-- New real step: `wouldDeduplicate` first; a hit is a true skip. -/
def realNew (s : Store) (k : Nat) : Act × Store :=
  if has s k then (.skipped, s) else (.imported, (k, 1) :: s)

/-- Dry run: `wouldDeduplicate` + in-file tracking, never writes (it tracks the
keys it would add, which is the same list shape). -/
def dry (s : Store) (k : Nat) : Act × Store :=
  if has s k then (.skipped, s) else (.imported, (k, 1) :: s)

def run (step : Store → Nat → Act × Store) : Store → List Nat → List Act × Store
  | s, [] => ([], s)
  | s, k :: ks => let (a, s') := step s k; let (as, s'') := run step s' ks; (a :: as, s'')

theorem has_cons (s : Store) (k k' n : Nat) : has ((k', n) :: s) k = (k' == k || has s k) := rfl

/-- Adding rows never forgets one. -/
theorem run_keeps (s : Store) (ks : List Nat) (k : Nat) (h : has s k = true) :
    has (run realNew s ks).2 k = true := by
  induction ks generalizing s with
  | nil => simpa [run]
  | cons k' ks ih =>
    simp only [run, realNew]
    split
    · exact ih _ h
    · exact ih _ (by simp [has_cons, h])

theorem run_mem (s : Store) (ks : List Nat) (k : Nat) (hk : k ∈ ks) :
    has (run realNew s ks).2 k = true := by
  induction ks generalizing s with
  | nil => cases hk
  | cons k' ks ih =>
    simp only [run, realNew]
    rcases List.mem_cons.mp hk with rfl | hk
    · split
      · exact run_keeps _ _ _ (by assumption)
      · exact run_keeps _ _ _ (by simp [has_cons])
    · split <;> exact ih _ hk

/-- A step on a record already present changes nothing. -/
theorem realNew_present (s : Store) (k : Nat) (h : has s k = true) : realNew s k = (.skipped, s) := by
  simp [realNew, h]

theorem run_all_present (s : Store) (ks : List Nat) (h : ∀ k ∈ ks, has s k = true) :
    run realNew s ks = (ks.map (fun _ => Act.skipped), s) := by
  induction ks with
  | nil => rfl
  | cons k ks ih =>
    simp only [run, realNew_present s k (h k (List.mem_cons_self ..)), List.map_cons]
    rw [ih (fun k' hk => h k' (List.mem_cons_of_mem _ hk))]

/-- **Decision R:** re-running an import on the store it produced reports every
record skipped and leaves the store exactly as it was. -/
theorem rerun_changes_nothing (s : Store) (ks : List Nat) :
    let s1 := (run realNew s ks).2
    run realNew s1 ks = (ks.map (fun _ => Act.skipped), s1) :=
  run_all_present _ _ (fun k hk => run_mem s ks k hk)


/-- Non-vacuity: a fresh record is imported and a present one skipped. -/
theorem reimport_reachable : (run realNew [(7, 1)] [7, 8]).1 = [.skipped, .imported] := by decide

/-- Old behaviour, counterexample (= replay "re-import 2: write_count 3"): the
second run reports skipped yet changes the store. -/
theorem old_rerun_bumps :
    (run realOld [] [1]).2 = [(1, 1)] ∧ run realOld [(1, 1)] [1] = ([.skipped], [(1, 2)]) := by decide

end Reimport

/-! ### 6b. The dry run predicts the real run (`importers/engine.ts`)

The real run asks `wouldDeduplicate` against a store that grows with every
record it imports. The dry run writes nothing: it asks `wouldDeduplicate`
against the unchanged store, and then its in-file map, looked up by hash where
learn() dedups across scopes (`dedupScopeFor(...).acrossScopes`, the oracle
`across`) and by (hash, scope) where it does not; a new record sets both keys.
Secrets are refused in both modes before dedup; a statement that normalises to
nothing is never deduplicated. -/
namespace ImportParity

inductive Rec where
  | secret
  | unhashable
  | row (hash scope : Nat)

inductive Act | imported | skipped | error
  deriving DecidableEq, Repr

abbrev Rows := List (Nat × Nat)

/-- `wouldDeduplicate`: a row with the same hash, in the same scope unless
learn() dedups across scopes for this record. -/
def dedups (across : Nat → Bool) (rows : Rows) (h sc : Nat) : Bool :=
  rows.any (fun r => r.1 == h && (across sc || r.2 == sc))

def realStep (across : Nat → Bool) (rows : Rows) : Rec → Act × Rows
  | .secret => (.error, rows)
  | .unhashable => (.imported, rows)
  | .row h sc => if dedups across rows h sc then (.skipped, rows) else (.imported, (h, sc) :: rows)

inductive Key | hash (h : Nat) | pair (h sc : Nat)
  deriving DecidableEq

def dryStep (across : Nat → Bool) (store : Rows) (keys : List Key) : Rec → Act × List Key
  | .secret => (.error, keys)
  | .unhashable => (.imported, keys)
  | .row h sc =>
    if dedups across store h sc then (.skipped, keys)
    else if keys.contains (if across sc then .hash h else .pair h sc) then (.skipped, keys)
    else (.imported, .hash h :: .pair h sc :: keys)

def realRun (across : Nat → Bool) (rows : Rows) : List Rec → List Act
  | [] => []
  | r :: rs => let (a, rows') := realStep across rows r; a :: realRun across rows' rs

def dryRun (across : Nat → Bool) (store : Rows) (keys : List Key) : List Rec → List Act
  | [] => []
  | r :: rs => let (a, keys') := dryStep across store keys r; a :: dryRun across store keys' rs

/-- The keys the dry run holds for the rows the real run has added. -/
def keysOf : Rows → List Key
  | [] => []
  | (h, sc) :: rest => .hash h :: .pair h sc :: keysOf rest

theorem keys_hit_iff (across : Nat → Bool) (added : Rows) (h sc : Nat) :
    (keysOf added).contains (if across sc then .hash h else .pair h sc) = dedups across added h sc := by
  induction added with
  | nil => rfl
  | cons r rest ih =>
    obtain ⟨h', sc'⟩ := r
    simp only [keysOf, dedups, List.any_cons] at ih ⊢
    rw [← ih]
    cases hc : across sc <;> simp <;> grind

theorem dedups_append (across : Nat → Bool) (a b : Rows) (h sc : Nat) :
    dedups across (a ++ b) h sc = (dedups across b h sc || dedups across a h sc) := by
  simp [dedups, List.any_append, Bool.or_comm]

theorem parity (across : Nat → Bool) (store added : Rows) (recs : List Rec) :
    dryRun across store (keysOf added) recs = realRun across (added ++ store) recs := by
  induction recs generalizing added with
  | nil => rfl
  | cons r rs ih =>
    cases r with
    | secret => simp only [dryRun, dryStep, realRun, realStep]; rw [ih]
    | unhashable => simp only [dryRun, dryStep, realRun, realStep]; rw [ih]
    | row h sc =>
      simp only [dryRun, dryStep, realRun, realStep, dedups_append, keys_hit_iff]
      cases hs : dedups across store h sc <;> cases ha : dedups across added h sc <;> simp
      · have := ih ((h, sc) :: added); simpa [keysOf] using this
      · exact ih added
      · exact ih added
      · exact ih added

/-- For every store, file and dedup policy, the dry run reports exactly the
actions the real run takes. -/
theorem dry_predicts_real_store (across : Nat → Bool) (store : Rows) (recs : List Rec) :
    dryRun across store [] recs = realRun across store recs :=
  parity across store [] recs

/-- A scope-blind in-file map (hash only). -/
def dryStepBlind (across : Nat → Bool) (store : Rows) (keys : List Key) : Rec → Act × List Key
  | .secret => (.error, keys)
  | .unhashable => (.imported, keys)
  | .row h sc =>
    if dedups across store h sc then (.skipped, keys)
    else if keys.contains (.hash h) then (.skipped, keys)
    else (.imported, .hash h :: .pair h sc :: keys)

def dryRunBlind (across : Nat → Bool) (store : Rows) (keys : List Key) : List Rec → List Act
  | [] => []
  | r :: rs => let (a, keys') := dryStepBlind across store keys r; a :: dryRunBlind across store keys' rs

/-- Counterexample on the scope-blind map: one statement in two shared scopes
(no cross-scope dedup) is predicted skipped the second time, yet imported. -/
theorem blind_dry_mispredicts :
    dryRunBlind (fun _ => false) [] [] [.row 1 10, .row 1 20] = [.imported, .skipped] ∧
    realRun (fun _ => false) [] [.row 1 10, .row 1 20] = [.imported, .imported] := by decide

end ImportParity

/-! ## 7. Coordinator item — an update that retires leaves a trace

`_updateEngramReturning` (local branch): `engram_retired` (data `{reason, via:
'update'}`) iff the stored status was not `retired` and the written one is. -/

inductive St | active | retired | other
  deriving DecidableEq, Repr

def retireEvent (before after : St) : Bool := before != .retired && after == .retired
def retireEventOld (_before _after : St) : Bool := false

theorem retire_logged (b : St) (hb : b ≠ .retired) : retireEvent b .retired = true := by
  cases b <;> simp_all [retireEvent]
theorem no_event_unless_retiring (b a : St) (h : retireEvent b a = true) : b ≠ .retired ∧ a = .retired := by
  cases b <;> cases a <;> simp_all [retireEvent]
theorem old_update_retire_silent : retireEventOld .active .retired = false := rfl

/-! ## 8. Follow-ups (coordinator, owner principles, 2026-09-27)

### 8a. Decision A covers learnAsync's LLM/cosine candidates
`_learnAsyncDeps().recallHybrid/recall` keep only `persistable` candidates, so
whatever the LLM answers, a NOOP/UPDATE/MERGE target is a row the writer owns. -/

/-- The candidate list learnAsync decides over. -/
def asyncCandidatesNew (cs : List HitAt) : List HitAt := cs.filter persistable
def asyncCandidatesOld (cs : List HitAt) : List HitAt := cs

/-- Any target the (arbitrary) LLM oracle picks from the offered list. -/
theorem async_target_persistable (cs : List HitAt) (t : HitAt) (ht : t ∈ asyncCandidatesNew cs) :
    persistable t = true := by
  simp [asyncCandidatesNew, List.mem_filter] at ht; exact ht.2

theorem async_own_kept : asyncCandidatesNew [.primary, .readonlyOrPack] = [.primary] := by decide
theorem old_async_pack_target : HitAt.readonlyOrPack ∈ asyncCandidatesOld [.readonlyOrPack] := by decide

/-! ### 8b. A remote update that retires is traced
`_updateEngramReturning` remote branch: `prev` = the driver's `getById` before
the PATCH (`none` = unreadable). Event iff the patch retires, it succeeded, and
the previous status was not known to be retired; flagged when unknown. -/

inductive RemEv | none | retired | retiredUnknown
  deriving DecidableEq, Repr

def remoteEvent (retires ok : Bool) (prev : Option St) : RemEv :=
  if retires && ok then
    match prev with
    | none => .retiredUnknown
    | some .retired => .none
    | some _ => .retired
  else .none

def remoteEventOld (_retires _ok : Bool) (_prev : Option St) : RemEv := .none

/-- A real remote retirement is never silent. -/
theorem remote_retire_traced (p : Option St) (hp : p ≠ some .retired) :
    remoteEvent true true p ≠ .none := by
  rcases p with _ | ⟨_ | _ | _⟩ <;> simp_all [remoteEvent]

theorem remote_no_event_when_already_retired : remoteEvent true true (some .retired) = .none := rfl
theorem remote_no_event_without_retire (ok : Bool) (p : Option St) : remoteEvent false ok p = .none := by
  simp [remoteEvent]
theorem old_remote_retire_silent : remoteEventOld true true (some .active) = .none := rfl

/-! ### 8c. Dry-run in-file key on a delegating store
Real run (after Decision R): record `(k, sc)` is skipped iff the store holds a
row learn() matches: same key and same scope, or any scope when learn() dedups
across scopes (`across` = `dedupScopeFor(...).acrossScopes`). The dry run
tracks earlier records of the file; the store starts with none of them. -/

def learnMatches (across : Bool) (row rec : Nat × Nat) : Bool :=
  row.1 == rec.1 && (across || row.2 == rec.2)

def realStepF (across : Bool) (s : List (Nat × Nat)) (r : Nat × Nat) : Bool × List (Nat × Nat) :=
  if s.any (learnMatches across · r) then (true, s) else (false, r :: s)

/-- Fixed dry run: key by hash when `across`, else by (hash, scope). -/
def dryStepF (across : Bool) (seen : List (Nat × Nat)) (r : Nat × Nat) : Bool × List (Nat × Nat) :=
  if seen.any (fun x => x.1 == r.1 && (across || x.2 == r.2)) then (true, seen) else (false, r :: seen)

/-- Old dry run: scope-blind whatever the backend. -/
def dryStepOld (_across : Bool) (seen : List (Nat × Nat)) (r : Nat × Nat) : Bool × List (Nat × Nat) :=
  if seen.any (fun x => x.1 == r.1) then (true, seen) else (false, r :: seen)

def runF (step : List (Nat × Nat) → Nat × Nat → Bool × List (Nat × Nat)) :
    List (Nat × Nat) → List (Nat × Nat) → List Bool
  | _, [] => []
  | s, r :: rs => let (a, s') := step s r; a :: runF step s' rs

theorem dryStepF_eq (across : Bool) : dryStepF across = realStepF across := rfl

/-- **Parity:** on every backend (across = true for YAML, false for a
delegating store) the dry run's in-file skips equal the real run's. -/
theorem infile_parity (across : Bool) (rs : List (Nat × Nat)) :
    runF (dryStepF across) [] rs = runF (realStepF across) [] rs := by rw [dryStepF_eq]

/-- Non-vacuity and the replayed divergence: same statement in scopes 1, 2, 2.
YAML skips both repeats; a delegating store imports the second scope. -/
theorem infile_cases :
    runF (realStepF true) [] [(5, 1), (5, 2), (5, 2)] = [false, true, true] ∧
    runF (realStepF false) [] [(5, 1), (5, 2), (5, 2)] = [false, false, true] := by decide

theorem old_infile_diverges :
    runF (dryStepOld false) [] [(5, 1), (5, 2)] ≠ runF (realStepF false) [] [(5, 1), (5, 2)] := by decide

end PlurSpec.R2CoreA

/- 2026-10-19: Save destination reporting is a projection of the existing delivery
evidence. It changes no routing, persistence, scope authorization or outbox rule;
the model remains valid. Presentation invariants live in SaveDestination.lean. -/

/- 2026-10-19: serverSessionLines reads cached configuration and the existing
primary outbox projection. It does not probe, route, deliver or mutate memory.
These transition invariants still hold; status precedence is in SaveDestination. -/

/-! Checked 2026-10-19 for credential-change retry: Outbox section 8c models
known-key backoff bypass and the local-path takeover hold. Other write guards,
claims, idempotency and merge-back remain unchanged; the extra queue field is
an attempted credential fingerprint only. Enterprise recovery text changes no
recall, authorization or adapter admission rule. -/

/- 2026-10-19: Read-only server diagnostics add bounded /me and write-check
requests, strict permission evidence, and explicit missing-evidence failures.
They do not change grants, memory, queue delivery or file permissions. Existing
write/routing invariants hold; ServerDiagnostics models report aggregation.
The discovery clock-skew constant is exported without changing its value. -/

/- 2026-10-19: Multi-root disagreement now refuses unscoped MCP writes before
core admission; the legacy workspaceFolderScope result is unchanged. Explicit
choices retain routing and authorization. Recall adds the admitted root orgs
to dialing context, without widening the authorization filter or remote-only
binding. WorkspaceChoice models this adapter admission and context selection. -/

/-! 2026-10-19: Core re-exports the existing server-entry schema so legacy
project cleanup can validate a raw explicit enterprise registration without
inventing authorization through normalization. No engine behavior changes. -/

/-! 2026-10-19: Explicit primary upload reuses the locked queue and guarded
flush with a selected-id filter. Existing route, sensitivity, binding and
retirement invariants remain in force. UploadLocal models the new admission,
selection, dry-run and receipt rules. Held receipts are never cached as live. -/

/- 2026-10-20: Recall persistence, import planning and retire events are unchanged. Only queued flush retry admission and merge-back identity changed; Outbox.lean models these refinements. -/
