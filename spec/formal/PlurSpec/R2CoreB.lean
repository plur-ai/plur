/-!
# PlurSpec.R2CoreB — remote-row ingestion and remote host health (round 2)

Models of `packages/core/src/{remote-recall.ts, store/remote-store.ts, tensions.ts}`
plus the ingestion loop `_loadSecondaryAndPacks` in `index.ts` (read-only here).
Findings, verdicts and replays: `spec/formal/findings/r2-coreb.md`.

Payloads are abstract: a row's content is a type parameter, the measured-under
comparison is an oracle `M`, tokens and store scopes are opaque values with
decidable equality. Every theorem holds for every oracle.

The outbox lease (#1231) only exports `LOAD_FETCH_TIMEOUT_MS` from
remote-store.ts so the lease margin is built from it; the value and every
behaviour modelled here are unchanged, so these theorems still hold.

Field-report refresh (2026-09-29, cluster 3): §5–§7 model what #1269/#1277,
#1299 and #1310 added to remote-store.ts — lookup by idempotency key, the
caller's abort signal in `fetchBounded`, and the feedback `source` payload.
The outbox flush that uses them is `Outbox.lean`; findings in
`spec/formal/findings/outbox.md`.
-/

namespace PlurSpec.R2CoreB

/-! ## 1. Origin of a loaded row (core-policy#6)

A row carries optional loader markers `_pack` / `_storeScope` plus content.
Loaders: the pack loader stamps `_pack`, the store loaders (file-backed and
remote) stamp `_storeScope`. Before the fix nothing removed a marker the row
itself shipped (`RemoteRowSchema.passthrough()`), and `engramOrigin` read
`_pack` first. -/
namespace Origin

structure Row (σ : Type) where
  pack    : Option String
  store   : Option String
  content : σ

inductive O where
  | primary
  | pack (p : String)
  | store (s : String)
  | ambiguous
  deriving DecidableEq

variable {σ : Type}

/-- `engramOrigin` before the fix: `_pack` wins. -/
def originOld (r : Row σ) : O :=
  match r.pack, r.store with
  | some p, _      => .pack p
  | none, some s   => .store s
  | none, none     => .primary

/-- `engramOrigin` after the fix: both markers → ambiguous. -/
def origin (r : Row σ) : O :=
  match r.pack, r.store with
  | some _, some _ => .ambiguous
  | some p, none   => .pack p
  | none, some s   => .store s
  | none, none     => .primary

/-- `withoutLoaderMarkers` / `stampStoreRow`: drop every `_`-prefixed key. -/
def strip (r : Row σ) : Row σ := { r with pack := none, store := none }

/-- Remote ingestion before the fix (both legs): stamp `_storeScope`, keep the rest. -/
def remoteLoadOld (s : String) (r : Row σ) : Row σ := { r with store := some s }
/-- Remote ingestion after the fix: `salvageRemoteRow` strips, then the loader stamps. -/
def remoteLoad (s : String) (r : Row σ) : Row σ := { strip r with store := some s }
/-- File-backed store loader (index.ts, unchanged — NEEDS-FILE). -/
def fileStoreLoad (s : String) (r : Row σ) : Row σ := { r with store := some s }
/-- Pack loader (index.ts, unchanged — NEEDS-FILE). -/
def packLoad (p : String) (r : Row σ) : Row σ := { r with pack := some p }

/-- `measuredUnderGateApplies` before the fix. `M` = statements carry measurements
and the configurations differ (oracle). -/
def gateOld (M : Row σ → Row σ → Bool) (a b : Row σ) : Bool :=
  decide (originOld a = originOld b) && M a b

/-- After the fix: an ambiguous origin is never gated. -/
def gate (M : Row σ → Row σ → Bool) (a b : Row σ) : Bool :=
  decide (origin a ≠ .ambiguous) && decide (origin a = origin b) && M a b

/-- Counterexample (replayed): a remote row that ships `_pack := P` takes the
installed pack's origin. -/
theorem old_remote_takes_pack_origin (s p : String) (c : σ) :
    originOld (remoteLoadOld s ⟨some p, none, c⟩) = .pack p := rfl

/-- …and so the measured-under gate removes a pack-vs-remote pair from the judge,
whenever the oracle says the configurations differ. -/
theorem old_gate_crosses_trust_boundary (M : Row σ → Row σ → Bool) (s p : String)
    (packRaw : Row σ) (c : σ)
    (hM : M (packLoad p packRaw) (remoteLoadOld s ⟨some p, none, c⟩) = true) :
    gateOld M (packLoad p packRaw) (remoteLoadOld s ⟨some p, none, c⟩) = true := by
  simpa [gateOld, originOld, packLoad, remoteLoadOld] using hM

/-- **Main property.** The origin of a loaded remote row is exactly its store,
never a pack origin, whatever the server sent. -/
theorem remote_origin_is_store (s : String) (r : Row σ) :
    origin (remoteLoad s r) = .store s := rfl

theorem remote_origin_never_pack (s p : String) (r : Row σ) :
    origin (remoteLoad s r) ≠ .pack p := by
  simp [remote_origin_is_store]

/-- Defence in depth (tensions.ts): even a loader that does NOT strip — the
file-backed store loader — can no longer yield a pack origin. -/
theorem store_loaded_never_pack (s p : String) (r : Row σ) :
    origin (fileStoreLoad s r) ≠ .pack p := by
  cases r with
  | mk pk st c => cases pk <;> simp [origin, fileStoreLoad]

/-- Symmetric: a pack row cannot take a store origin by shipping `_storeScope`. -/
theorem pack_loaded_never_store (p s : String) (r : Row σ) :
    origin (packLoad p r) ≠ .store s := by
  cases r with
  | mk pk st c => cases st <;> simp [origin, packLoad]

/-- The gate never pairs a pack-loaded row with a store-loaded row. -/
theorem gate_never_crosses (M : Row σ → Row σ → Bool) (p s : String) (x y : Row σ) :
    gate M (packLoad p x) (fileStoreLoad s y) = false ∧
    gate M (packLoad p x) (remoteLoad s y) = false := by
  cases x with
  | mk xp xs xc =>
    cases y with
    | mk yp ys yc =>
      cases xs <;> cases yp <;>
        simp [gate, origin, packLoad, fileStoreLoad, remoteLoad, strip]

/-- Non-vacuity: two rows of one remote store are still gated when `M` says so. -/
theorem gate_same_store_reachable (M : Row σ → Row σ → Bool) (s : String) (a b : Row σ)
    (hM : M (remoteLoad s a) (remoteLoad s b) = true) :
    gate M (remoteLoad s a) (remoteLoad s b) = true := by
  simp [gate, remote_origin_is_store, hM]

end Origin

/-! ## 2. Activation normalization (core-policy#7a)

A JS object literal is a list of assignments; a lookup reads the LAST one.
Old: `{ ss: guard, fr: guard, ...act, rs: guard, la }`.
New: `{ ...act, ss: guard, fr: guard, rs: guard, la }`. -/
namespace Activation

inductive Key where
  | ss | fr | rs | other (n : Nat)
  deriving DecidableEq

inductive V where
  | num (n : Nat) | str (s : String) | null
  deriving DecidableEq

def V.isNum : V → Bool | .num _ => true | _ => false

/-- Last assignment wins. -/
def lookup (obj : List (Key × V)) (k : Key) : Option V :=
  obj.foldl (fun acc kv => if kv.1 = k then some kv.2 else acc) none

/-- `typeof act.k === 'number' ? act.k : dflt` -/
def guard (act : List (Key × V)) (k : Key) (dflt : Nat) : V :=
  match lookup act k with
  | some v => if v.isNum then v else .num dflt
  | none   => .num dflt

def normOld (act : List (Key × V)) : List (Key × V) :=
  [(.ss, guard act .ss 1), (.fr, guard act .fr 0)] ++ act ++ [(.rs, guard act .rs 7)]

def normNew (act : List (Key × V)) : List (Key × V) :=
  act ++ [(.ss, guard act .ss 1), (.fr, guard act .fr 0), (.rs, guard act .rs 7)]

/-- Counterexample (replayed): a string `storage_strength` survives. -/
theorem old_guard_defeated :
    lookup (normOld [(.ss, .str "high")]) .ss = some (.str "high") := by decide

theorem lookup_append_last (l : List (Key × V)) (k : Key) (v : V) :
    lookup (l ++ [(k, v)]) k = some v := by
  simp [lookup, List.foldl_append]

theorem guard_isNum (act : List (Key × V)) (k : Key) (d : Nat) : (guard act k d).isNum = true := by
  unfold guard
  cases lookup act k with
  | none => rfl
  | some v => cases v <;> simp [V.isNum]

/-- Fixed: each guarded field reads as a number, for every server object. -/
theorem new_guarded_numeric (act : List (Key × V)) :
    (∃ v, lookup (normNew act) .ss = some v ∧ v.isNum) ∧
    (∃ v, lookup (normNew act) .fr = some v ∧ v.isNum) ∧
    (∃ v, lookup (normNew act) .rs = some v ∧ v.isNum) := by
  refine ⟨⟨guard act .ss 1, ?_, guard_isNum _ _ _⟩,
          ⟨guard act .fr 0, ?_, guard_isNum _ _ _⟩,
          ⟨guard act .rs 7, ?_, guard_isNum _ _ _⟩⟩ <;>
    simp [normNew, lookup, List.foldl_append]

/-- Non-vacuity: a numeric server value is kept, and unmodelled keys pass through. -/
theorem new_keeps_server_values :
    lookup (normNew [(.ss, .num 4), (.other 0, .str "x")]) .ss = some (.num 4) ∧
    lookup (normNew [(.ss, .num 4), (.other 0, .str "x")]) (.other 0) = some (.str "x") := by
  decide

end Activation

/-! ## 3. Namespacing drift between the two legs (core-policy#7b)

An id is a list of store prefixes over a body. The load leg (index.ts) always
prepends; the recall leg (`namespaceEngramId`, via `stampStoreRow`) prepends
only when the id does not already carry that prefix. -/
namespace Namespace

structure Id where
  prefixes : List String
  body     : Nat
  deriving DecidableEq

def nsLoad (P : String) (i : Id) : Id := { i with prefixes := P :: i.prefixes }
def nsRecall (P : String) (i : Id) : Id :=
  if i.prefixes.head? = some P then i else { i with prefixes := P :: i.prefixes }

theorem recall_idempotent (P : String) (i : Id) : nsRecall P (nsRecall P i) = nsRecall P i := by
  unfold nsRecall; by_cases h : i.prefixes.head? = some P <;> simp [h]

/-- The legs agree on every id that does not already carry the prefix … -/
theorem legs_agree_on_fresh (P : String) (i : Id) (h : i.prefixes.head? ≠ some P) :
    nsLoad P i = nsRecall P i := by simp [nsLoad, nsRecall, h]

/-- … and disagree on one that does (replayed via `Plur.list` against a stub:
`ENG-GPL-GPL-…` on the load leg, `ENG-GPL-…` on the recall leg). NEEDS-FILE. -/
theorem legs_disagree_on_prefixed (P : String) (b : Nat) :
    nsLoad P ⟨[P], b⟩ ≠ nsRecall P ⟨[P], b⟩ := by simp [nsLoad, nsRecall]

/-- `global` rows: the recall leg narrows to the FIRST DIALED entry, so the id a
global row gets depends on the dialing context (design; documented, not changed). -/
def globalRecallPrefix (dialed : List String) : Option String := dialed.head?

theorem global_id_depends_on_dialing :
    globalRecallPrefix ["A", "B"] ≠ globalRecallPrefix ["B"] := by decide

end Namespace

/-! ## 4. Remote-recall health keying (core-policy#3)

Events on ONE url: `(token, response)`. Network class failures and the breaker
belong to the host; the 403 streak and the 429 cooldown to the token. Time is
abstracted: a cooldown is a flag in force until the next event that clears it. -/
namespace Health

inductive R where
  | ok | r403 | r429 | net
  deriving DecidableEq

/-- Per-credential state. -/
structure Tok where
  streak  : Nat  := 0
  limited : Bool := false
  deriving DecidableEq

/-- The 403 streak rule for one credential (remote-recall.ts dialHost). -/
def stepTok (t : Tok) : R → Tok
  | .r403 => { t with streak := t.streak + 1 }
  | .r429 => { streak := 0, limited := true }
  | _     => { t with streak := 0 }

/-- Verdict of a 403: forbidden iff the streak reaches 2. -/
def forbiddenAfter (t : Tok) : Bool := decide (2 ≤ t.streak)

/-- OLD: one shared record per url. -/
def runOld (evs : List (Nat × R)) : Tok := evs.foldl (fun s e => stepTok s e.2) {}

/-- NEW: one record per token. -/
def step (s : Nat → Tok) (e : Nat × R) : Nat → Tok :=
  fun t => if t = e.1 then stepTok (s t) e.2 else s t

def run (s : Nat → Tok) (evs : List (Nat × R)) : Nat → Tok := evs.foldl step s

/-- Counterexamples (replayed with a token-keyed mocked fetch):
revoked token 1 interleaved with healthy token 2 never reaches `forbidden` … -/
theorem old_interleave_masks_revocation :
    forbiddenAfter (runOld [(1, .r403), (2, .ok), (1, .r403)]) = false := by decide

/-- … two tokens' single 403s in one call add up to `forbidden` … -/
theorem old_two_tokens_one_round :
    forbiddenAfter (runOld [(1, .r403), (2, .r403)]) = true := by decide

/-- … and one token's 429 parks the other. -/
theorem old_429_parks_other : (runOld [(1, .r429)]).limited = true := by decide

/-- **Non-interference.** A token's state is a function of its OWN events only. -/
theorem noninterference (s : Nat → Tok) (evs : List (Nat × R)) (t : Nat) :
    run s evs t = ((evs.filter (fun e => e.1 = t)).map (·.2)).foldl stepTok (s t) := by
  induction evs generalizing s with
  | nil => rfl
  | cons e es ih =>
    simp only [run, List.foldl_cons] at ih ⊢
    rw [ih]
    by_cases h : e.1 = t
    · simp [h, step]
    · have h' : t ≠ e.1 := fun h'' => h h''.symm
      simp [h, step, h']

/-- Consequence: another token's events never reset, advance or rate-limit `t`. -/
theorem other_tokens_irrelevant (s : Nat → Tok) (evs : List (Nat × R)) (t : Nat)
    (hothers : ∀ e ∈ evs, e.1 ≠ t) : run s evs t = s t := by
  rw [noninterference]
  have : evs.filter (fun e => e.1 = t) = [] := by
    rw [List.filter_eq_nil_iff]; intro e he; simpa using hothers e he
  simp [this]

/-- Fixed code on the three counterexamples. -/
theorem new_interleave_forbidden :
    forbiddenAfter (run (fun _ => {}) [(1, .r403), (2, .ok), (1, .r403)] 1) = true := by decide
theorem new_two_tokens_unconfirmed :
    forbiddenAfter (run (fun _ => {}) [(1, .r403), (2, .r403)] 1) = false ∧
    forbiddenAfter (run (fun _ => {}) [(1, .r403), (2, .r403)] 2) = false := by decide
theorem new_429_no_park : (run (fun _ => {}) [(1, .r429)] 2).limited = false := by decide

/-- The host breaker stays SHARED (reachability is a host fact): `net` failures
by any token count toward one threshold. Non-vacuity for the split. -/
def hostFailures (evs : List (Nat × R)) : Nat :=
  evs.foldl (fun n e => match e.2 with | .net => n + 1 | .ok => 0 | _ => 0) 0

theorem host_breaker_shared : 3 ≤ hostFailures [(1, .net), (2, .net), (1, .net)] := by decide

end Health

/-! ## 5. RemoteStore.load: which outcomes trip the host-down breaker (core-policy#10)

One page fetch either throws at the network level, or the host answers with a
status and a body that parses to a page, to a non-page, or not at all. -/
namespace LoadBreaker

inductive Body where
  | page | nonPage | unparseable
  deriving DecidableEq

inductive Outcome where
  | netThrow
  | answered (ok : Bool) (b : Body)
  deriving DecidableEq

/-- Before: the body read and the `rows` iteration sat inside the network catch. -/
def marksOld : Outcome → Bool
  | .netThrow => true
  | .answered true .page => false
  | .answered true _ => true
  | .answered false _ => false

/-- After: only a thrown `fetch` marks. -/
def marks : Outcome → Bool
  | .netThrow => true
  | .answered _ _ => false

/-- Pagination completes only on a good page (or a stable 403/404, abstracted). -/
def complete : Outcome → Bool
  | .answered true .page => true
  | _ => false

theorem old_malformed_trips : marksOld (.answered true .unparseable) = true ∧
    marksOld (.answered true .nonPage) = true := by decide

/-- "HTTP responses never trip it" — now true of every answered outcome. -/
theorem answered_never_marks (ok : Bool) (b : Body) : marks (.answered ok b) = false := rfl

/-- Non-vacuity: a network throw still marks. -/
theorem net_marks : marks .netThrow = true := rfl

/-- A malformed body leaves pagination incomplete, so the prior cache is served
(`this.cache?.engrams ?? all`) rather than overwritten. -/
def served {α : Type} (prior : Option α) (part fresh : α) (o : Outcome) : α :=
  if complete o then fresh else prior.getD part

theorem malformed_keeps_prior {α : Type} (prior part fresh : α) (b : Body) (hb : b ≠ .page) :
    served (some prior) part fresh (.answered true b) = prior := by
  cases b <;> simp_all [served, complete]

end LoadBreaker

/-! ## 5. Lookup by idempotency key (`RemoteStore.findByIdempotencyKey`, #1277)

Pages of `GET /engrams?scope=…&idempotency_key=K&limit=200&offset=…`, as the
server answered them in order (the list ends at the 50-page cap). A row is its
`data.idempotency_key` and whether it is retired; `filtered` = the envelope
echoed the key (the server applied the filter). -/
namespace KeyLookup

structure Page where
  filtered : Bool
  rows     : List (Nat × Bool)
  total    : Option Nat

inductive Ans where
  | notOk          -- non-2xx, or a thrown fetch (caught: never throws)
  | bad            -- no `rows` array
  | page (p : Page)

inductive V where
  | found | absent | unknown
  deriving DecidableEq

def hit (key : Nat) (r : Nat × Bool) : Bool := r.1 == key && !r.2

def lookup (key limit : Nat) : Nat → List Ans → V
  | _, [] => .unknown
  | off, a :: t =>
    match a with
    | .notOk | .bad => .unknown
    | .page p =>
      if p.rows.any (hit key) then .found
      else if decide (p.rows.length < limit) || decide (off + p.rows.length ≥ p.total.getD 0) then
        (if p.filtered then .absent else .unknown)
      else lookup key limit (off + limit) t

/-- `absent` (the one answer that lets the flush post again) needs a page on
which the server echoed the filter. -/
theorem absent_needs_filter (key limit : Nat) :
    ∀ (as : List Ans) (off : Nat), lookup key limit off as = .absent →
      ∃ p, Ans.page p ∈ as ∧ p.filtered = true := by
  intro as
  induction as with
  | nil => intro off h; simp [lookup] at h
  | cons a t ih =>
    intro off h
    cases a with
    | notOk => simp [lookup] at h
    | bad => simp [lookup] at h
    | page p =>
      simp only [lookup] at h
      split at h
      · cases h
      · split at h
        · split at h
          · exact ⟨p, by simp, by assumption⟩
          · cases h
        · obtain ⟨q, hq, hf⟩ := ih _ h
          exact ⟨q, by simp [hq], hf⟩

/-- `found` needs a live row that carries the key — never a statement match. -/
theorem found_needs_key (key limit : Nat) :
    ∀ (as : List Ans) (off : Nat), lookup key limit off as = .found →
      ∃ p r, Ans.page p ∈ as ∧ r ∈ p.rows ∧ r.1 = key ∧ r.2 = false := by
  intro as
  induction as with
  | nil => intro off h; simp [lookup] at h
  | cons a t ih =>
    intro off h
    cases a with
    | notOk => simp [lookup] at h
    | bad => simp [lookup] at h
    | page p =>
      simp only [lookup] at h
      split at h
      · rename_i hany
        obtain ⟨r, hr, hk⟩ := List.any_eq_true.mp hany
        simp [hit] at hk
        exact ⟨p, r, by simp, hr, hk.1, hk.2⟩
      · split at h
        · split at h <;> cases h
        · obtain ⟨q, r, hq, hr, hk⟩ := ih _ h
          exact ⟨q, r, by simp [hq], hr, hk⟩

/-- A key-ignoring server (never echoes, never records the key): always `unknown`. -/
theorem ignoring_server_unknown (key limit : Nat) :
    ∀ (as : List Ans) (off : Nat),
      (∀ p, Ans.page p ∈ as → p.filtered = false ∧ ∀ r ∈ p.rows, r.1 ≠ key) →
      lookup key limit off as = .unknown := by
  intro as
  induction as with
  | nil => intro off _; rfl
  | cons a t ih =>
    intro off h
    cases a with
    | notOk => rfl
    | bad => rfl
    | page p =>
      have ⟨hf, hr⟩ := h p (by simp)
      have hany : p.rows.any (hit key) = false := by
        cases hh : p.rows.any (hit key)
        · rfl
        · obtain ⟨r, hm, hk⟩ := List.any_eq_true.mp hh
          simp [hit] at hk
          exact absurd hk.1 (hr r hm)
      simp only [lookup, hany, Bool.false_eq_true, ↓reduceIte, hf]
      split
      · rfl
      · exact ih _ (fun q hq => h q (by simp [hq]))

/-- Non-vacuity: a filtered, empty answer is a confirmed absence; a live row
with the key is found. -/
theorem lookup_reachable :
    lookup 7 200 0 [.page ⟨true, [], some 0⟩] = .absent ∧
    lookup 7 200 0 [.page ⟨true, [(7, false)], some 1⟩] = .found := by decide

end KeyLookup

/-! ## 6. `fetchBounded` and the in-process host mark (#1069, #1269)

Only a thrown `fetch` that the CALLER did not cut marks the host down; an
answered request (any status, any body) never does. -/
namespace FetchBounded

inductive R where
  | thrown (callerAborted : Bool)
  | answered (status : Nat)

def marks : R → Bool
  | .thrown ca => !ca
  | .answered _ => false

theorem answered_never_marks (s : Nat) : marks (.answered s) = false := rfl
theorem caller_cut_never_marks : marks (.thrown true) = false := rfl
theorem network_failure_marks : marks (.thrown false) = true := rfl

end FetchBounded

/-! ## 7. Feedback payload (`RemoteStore.feedback`, #1310)

`source` is on the wire exactly when the caller passed `source: 'auto'`; an
explicit rating's body is `{ signal }`, byte-identical to before. Which
servers the caller sends an automatic rating to is `Outbox.lean` §9. -/
namespace FeedbackPayload

def payloadHasSource (auto : Bool) : Bool := auto

theorem explicit_body_unchanged : payloadHasSource false = false := rfl
theorem auto_body_marked : payloadHasSource true = true := rfl

end FeedbackPayload

end PlurSpec.R2CoreB
