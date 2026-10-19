/-!
# PlurSpec.Outbox — delivery of queued team writes (decisions C3, C4, C5)

Checked against #1631 (config.yaml owner-only, 2026-10-18): still holds. index.ts's only
change swaps the config.yaml writes for `writeConfigFile` (same content, same lock); no
outbox, claim or breaker code changed.

Models the outbox as merged on main by #1277 and carried into #1228 under
owner decision C3 (2026-09-29): `flushOutbox` / `_flushOutboxClaimed`,
learn()'s immediate push, the per-entry claims (`_claimOutboxEntry`,
`_releaseOutboxClaim`, `_outboxClaimUntil`), the refusal classification
(`outbox-health.ts`) and the per-host breaker as the write and recall legs feed
it (`remote-recall.ts`). Code: `packages/core/src/index.ts`.
Findings: `spec/formal/findings/outbox.md`.

There are no row leases (C3) and no "maybe delivered" state (C4): a queued
write carries one random idempotency key, persisted on its row before the
first POST, and every retry sends it. Cross-process exclusion of pushers is
`WritePath.lean` §1c (`claimed_at_most_once_across_processes`). This file
covers what the key buys on each kind of server (§1–§3), why the claim
takeover has one winner (§4), who may release a claim (§5), what the listing
reports (§6), the breaker (§7) and the needs_action back-off (§8).

Keys are opaque naturals. The server is one of two kinds
(`docs/remote-store-contract.md`): `honour` deduplicates POSTs by key; `ignore`
does not. What the network does to each attempt is an adversarial outcome
chosen per event, so every theorem holds for every schedule of outcomes.

Checked against registerEnterpriseServer (#1631 plan B Task 5, branch agent/efi-b05, 2026-10-18): still holds.
Rechecked after the gate review and Codex audit rounds 1-2 on the same branch (2026-10-18): still holds.
index.ts changed only inside registerEnterpriseServer (error wording); server-discovery.ts only in the
registration/fold functions, which StoreEntry §6/§6b model.
index.ts gains `registerEnterpriseServer`, a new public method that writes config.yaml through
`_updateRawStores` (config lock, atomic write) and reads `listOutbox` (read only: the
queued count per scope it reports); no existing branch modelled
here changed. The registration and fold are modelled in StoreEntry §6.

Checked against #1631 (epic/1797 first install, 2026-10-18): updated.
`routeFor` in `_flushOutboxClaimed` now holds an entry whose target scope two
servers claim, before `heldBack` and before the push, so even `force` does not
deliver it; modelled in §8b (`conflict_untouched`, `keptC_only_bookkeeping`).
Keys, retry, claims, the listing and the breaker (§1–§7) are unchanged.
remote-store.ts changed only `me()` (C1 /me fields; a non-2xx now throws
`RemoteHttpError` with the same message), which the push path does not call.

Checked against #1521 (remote-only folders, merged onto development 2026-10-18): still holds.
`_flushOutboxClaimed` gained one more hold for an entry marked `remote_only`: when its target
scope is no longer a deliverable team scope, or the target's policy now forbids its content,
the entry is held exactly like the #1631 conflict hold of §8b — no push, no demotion to a local
row, only `last_attempt` / `last_error` bookkeeping and a `failed` count. Keys, retry, claims,
the listing and the breaker (§1–§7) are unchanged.

Rechecked after Codex audit rounds 3-5 on branch agent/efi-b05 (2026-10-18): still holds. The changes are
refusals and eligibility checks inside registerEnterpriseServer/registerServerEntry/foldStoresIntoServerEntry
(nothing is written on a refusal), the outbox read moved before the write, and config.ts's unset-token_env
warning naming the url by origin; no modelled branch changed.

Checked against #1632 (git default scope, 2026-10-18): still holds. `remote-store.ts` only
exports `isSafeHost` (unchanged) so `git-origin.ts` reuses the one host grammar; no code path
this model covers changed.

Gate structural change 1 on #1663 (2026-10-18): still holds. A delivery no longer writes automatic
provenance for a queued remote-only save; keys, retry, claims, holds and the breaker are unchanged.
Codex round 11 (2026-10-18): still holds. The two remote-only holds in the flush now classify by the
shared predicate (either marker field), so a half-stripped marker is held like §8b; nothing else changed.

Checked against #1631 background discovery (PR gate, 2026-10-18): still holds.
index.ts only adds `_serverDiscoveryEndpoints()`, a read of config.yaml that lists the
urls `refreshServerScopes` probes (the same `isEnterpriseServerEntry` filter). It
writes nothing and is read only by the MCP server; the outbox and the push path are untouched.

Checked against #1633 (plan B Task 7, owner decision O5, 2026-10-18): still holds. The
`_outbox.target_url` learn writes is the resolver's writable entry; outside a conflict (refused
before the save) it is the entry the old first-writable `find` returned. The flush, the
retarget and the push path are unchanged.

Checked against #1638 (`plur login` device sign-in, plan C Task 3, branch agent/efi-c03, 2026-10-18):
still holds. registerServerEntry's refusal to take over the personal scope is unchanged (the same
holders, the same message); it is now a `PersonalScopeTakenError` that names those holders, and
`removeStale` drops exactly them before the same registration runs again, in the same locked write
(modelled in Login.lean §2: only holders are removed, never without the flag, no holder left).
The outbox and the push path are untouched; `queued_by_scope` is counted as before.


Checked 2026-10-19 for git-origin folder defaults: GitFolder models the added
folder-policy admission and operation-captured default. Existing explicit scopes,
remote-only gates, store resolution, persistence and outbox delivery rules are
unchanged. The remote recall change only suppresses calls for a local/unknown
origin default; a deliberate call/session scope keeps the existing routing.
-/

namespace PlurSpec.Outbox

/-! ## 1. The server -/

inductive Server where
  | honour
  | ignore
  deriving DecidableEq

/-- Rows the server holds for this logical write, as the keys they were posted with. -/
def post : Server → List Nat → Nat → List Nat
  | .honour, rows, k => if k ∈ rows then rows else k :: rows
  | .ignore, rows, k => k :: rows

/-- Honouring server, one key: whatever interleaving of POSTs (any number of
pushers, any retries), the write is stored at most once. -/
theorem honour_one_key (k : Nat) :
    ∀ (n : List Unit) (rows : List Nat), (rows = [] ∨ rows = [k]) →
      let r := n.foldl (fun rs _ => post .honour rs k) rows
      r = [] ∨ r = [k] := by
  intro n
  induction n with
  | nil => intro rows h; exact h
  | cons _ t ih =>
    intro rows h
    apply ih
    rcases h with h | h <;> subst h <;> simp [post]

/-- Two keys for one logical write: an honouring server keeps two rows. This
is why the key must never change between retries (§2). -/
theorem honour_two_keys_dup (k₁ k₂ : Nat) (h : k₁ ≠ k₂) :
    (post .honour (post .honour [] k₁) k₂).length = 2 := by
  simp [post, Ne.symm h]

/-! ## 2. The key (decision C4)

learn() mints the key when it queues the row, in the same write. A row from an
older client has none: the flush mints one and persists it on the row, under
the store lock, before anything is posted (`_persistMissingOutboxKeys`); a row
whose key could not be saved is not posted that flush. So every POST of a write
reads its key off the row, and the row's key never changes once set. -/

/-- The key a POST sends: the row's. `none` = not posted this flush. -/
def keyForPost (onRow : Option Nat) : Option Nat := onRow

/-- The key persisted for a row before the first POST: kept if present. -/
def persistKey (onRow : Option Nat) (fresh : Nat) (saved : Bool) : Option Nat :=
  match onRow with
  | some k => some k
  | none => if saved then some fresh else none

theorem row_key_stable (k fresh : Nat) (saved : Bool) : persistKey (some k) fresh saved = some k := rfl

/-- A write is never posted without a persisted key. -/
theorem no_keyless_post (fresh : Nat) :
    keyForPost (persistKey none fresh false) = none := rfl

/-- Two flushes of one write, even if the first threw after its POST: the key
is on the row, so the second sends the same key. -/
theorem retry_same_key (onRow : Option Nat) (f₁ f₂ : Nat) (s₁ s₂ : Bool) (k : Nat)
    (h : persistKey onRow f₁ s₁ = some k) : persistKey (persistKey onRow f₁ s₁) f₂ s₂ = some k := by
  rw [h]; rfl

/-! ## 3. Plain retry (decision C4)

One logical write, one key. Each attempt has an outcome; a write the client
did not hear back from is simply retried with the same key. `rows` counts the
copies the server stored; `landed` is a ghost count of attempts the server
stored. -/

inductive Outcome where
  | ok                    -- stored and answered: the row is handed off
  | refused               -- HTTP error: not stored
  | netBefore             -- network failure before the server stored it
  | unheard (landed : Bool) -- cut by the budget, timed out, or the answer lost

structure St where
  rows   : List Nat
  queued : Bool
  landed : Nat

def attempt (sv : Server) (k : Nat) (s : St) : Outcome → St
  | .ok => { rows := post sv s.rows k, queued := false, landed := s.landed + 1 }
  | .refused | .netBefore => s
  | .unheard l => if l then { s with rows := post sv s.rows k, landed := s.landed + 1 } else s

/-- A queued write is attempted; a handed-off one is not. -/
def step (sv : Server) (k : Nat) (s : St) (o : Outcome) : St := if s.queued then attempt sv k s o else s

def run (sv : Server) (k : Nat) (os : List Outcome) : St := os.foldl (step sv k) ⟨[], true, 0⟩

theorem honour_rows (k : Nat) (os : List Outcome) :
    ∀ s : St, (s.rows = [] ∨ s.rows = [k]) →
      ((os.foldl (step .honour k) s).rows = [] ∨ (os.foldl (step .honour k) s).rows = [k]) := by
  induction os with
  | nil => intro s h; exact h
  | cons o os ih =>
    intro s h
    apply ih
    unfold step
    split
    · cases o with
      | ok => rcases h with h | h <;> simp [attempt, post, h]
      | refused => exact h
      | netBefore => exact h
      | unheard l => cases l <;> rcases h with h | h <;> simp [attempt, post, h]
    · exact h

/-- **Key-honouring server: stored exactly once, however often retried.** -/
theorem honour_at_most_once (k : Nat) (os : List Outcome) : (run .honour k os).rows.length ≤ 1 := by
  rcases honour_rows k os ⟨[], true, 0⟩ (Or.inl rfl) with h | h <;> simp [run, h]

theorem ignore_rows (k : Nat) (os : List Outcome) :
    ∀ s : St, s.rows.length = s.landed →
      (os.foldl (step .ignore k) s).rows.length = (os.foldl (step .ignore k) s).landed := by
  induction os with
  | nil => intro s h; exact h
  | cons o os ih =>
    intro s h
    apply ih
    unfold step
    split
    · cases o with
      | ok => simp [attempt, post, h]
      | refused => exact h
      | netBefore => exact h
      | unheard l => cases l <;> simp [attempt, post, h]
    · exact h

/-- **Key-ignoring server: one row per attempt it stored** — no fixed bound per
write (`docs/remote-store-contract.md`). -/
theorem ignore_one_row_per_landed (k : Nat) (os : List Outcome) :
    (run .ignore k os).rows.length = (run .ignore k os).landed :=
  ignore_rows k os ⟨[], true, 0⟩ rfl

/-- Never lost: a write leaves the queue only after the server stored it. -/
theorem dequeued_only_when_stored (sv : Server) (k : Nat) (os : List Outcome) :
    ∀ s : St, (s.queued = false → s.rows ≠ []) →
      ((os.foldl (step sv k) s).queued = false → (os.foldl (step sv k) s).rows ≠ []) := by
  induction os with
  | nil => intro s h; exact h
  | cons o os ih =>
    intro s h
    apply ih
    unfold step
    split
    · rename_i hq
      cases o with
      | ok =>
        intro _
        cases sv
        · simp only [attempt, post]
          split
          · rename_i hk; exact List.ne_nil_of_mem hk
          · simp
        · simp [attempt, post]
      | refused => simpa [attempt] using fun h' => absurd (hq ▸ h' : true = false) (by simp)
      | netBefore => simpa [attempt] using fun h' => absurd (hq ▸ h' : true = false) (by simp)
      | unheard l =>
        cases l
        · simpa [attempt] using fun h' => absurd (hq ▸ h' : true = false) (by simp)
        · intro h'; simp [attempt] at h'; rw [hq] at h'; exact absurd h' (by simp)
    · exact h

/-- The measured scenario of the contract: three flushes cut after the server
stored the write, then one that completed. -/
theorem measured_scenario :
    (run .ignore 7 [.unheard true, .unheard true, .unheard true, .ok]).rows.length = 4 ∧
    (run .honour 7 [.unheard true, .unheard true, .unheard true, .ok]).rows.length = 1 := by
  decide

/-! ## 4. The claim takeover has one winner

A lapsed claim (its holder is dead or its lease expired) is replaced. Main's
code (review of #1277): the right to replace it is a takeover marker named
after that exact stale content, created with O_EXCL, so of any number of
racers exactly one creates it. The winner re-reads the claim under the marker
(it must still be the stale one) and renames a fresh claim over it. The path
is never empty. The read-compare-rename it replaced let several racers win.

Racers act in some order; each either creates the marker or finds it. -/

/-- O_EXCL marker creation for racers `rs`, in order: who wins. -/
def exclWinners : Bool → List Nat → List Nat
  | _, [] => []
  | taken, r :: rs => if taken then exclWinners true rs else r :: exclWinners true rs

theorem excl_one_winner (rs : List Nat) : (exclWinners false rs).length ≤ 1 := by
  have hz : ∀ qs : List Nat, (exclWinners true qs).length = 0 := by
    intro qs; induction qs with
    | nil => rfl
    | cons _ _ ih => simp [exclWinners, ih]
  cases rs with
  | nil => simp [exclWinners]
  | cons r rs => simp [exclWinners, hz]

theorem excl_someone_wins (r : Nat) (rs : List Nat) : (exclWinners false (r :: rs)).length = 1 := by
  have hz : ∀ qs : List Nat, (exclWinners true qs).length = 0 := by
    intro qs; induction qs with
    | nil => rfl
    | cons _ _ ih => simp [exclWinners, ih]
  simp [exclWinners, hz]

/-- Read-compare-rename: every racer reads the claim before any rename, so all
see it stale and all "win". -/
def readCompareWinners (rs : List Nat) : List Nat := rs

theorem read_compare_many_winners : (readCompareWinners [1, 2]).length = 2 := rfl

/-- The claim path during a takeover: the winner renames a fresh claim over
the stale one (atomic), so there is always a claim. -/
def afterTakeover (stale fresh : Nat) (won : Bool) : Option Nat := if won then some fresh else some stale

theorem takeover_never_empty (stale fresh : Nat) (won : Bool) : afterTakeover stale fresh won ≠ none := by
  cases won <;> simp [afterTakeover]

/-! ## 5. Only the writer that took a claim releases it (decision C3, kept from #1228)

A claim records a token; each Plur instance remembers the tokens of the claims
it took. Two instances in one process share pid and host, so those do not say
who took a claim. -/

structure Claim where
  pid   : Nat
  token : Nat

/-- The release rule as carried: this instance's token must match. -/
def releases (myPid : Nat) (myToken : Option Nat) (c : Claim) : Bool :=
  match myToken with
  | some t => t == c.token && myPid == c.pid
  | none => false

/-- Main's rule before the carry: the token was checked only when this
instance held one. -/
def releasesMain (myPid : Nat) (myToken : Option Nat) (c : Claim) : Bool :=
  myPid == c.pid && (match myToken with | some t => t == c.token | none => true)

theorem only_taker_releases (myPid : Nat) (myToken : Option Nat) (c : Claim)
    (h : releases myPid myToken c = true) : myToken = some c.token := by
  cases myToken with
  | none => simp [releases] at h
  | some t => simp [releases] at h; rw [h.1]

theorem taker_releases (c : Claim) : releases c.pid (some c.token) c = true := by
  simp [releases]

/-- Counterexample (replayed in `outbox-claim-ownership.test.ts`): under main's
rule another instance in the same process, holding no token, removes the claim. -/
theorem main_rule_foreign_release : releasesMain 42 none ⟨42, 7⟩ = true := rfl

/-! ## 6. The listing reads the claim file alone (decision C3, kept from #1228)

`listOutbox().leased_until` is the live claim's expiry and nothing else: a
lease-shaped field on the row is not read. -/

def leasedUntil (liveClaimUntil : Option Nat) (_rowField : Option Nat) : Option Nat := liveClaimUntil

theorem listing_ignores_row (c : Option Nat) (r₁ r₂ : Option Nat) : leasedUntil c r₁ = leasedUntil c r₂ := rfl

/-! ## 7. The per-host breaker (decision C5)

A failure feeds the persisted per-host breaker (`recordWriteOutcome` /
recall's `networkFailure`) or not. `none` = a network error. -/

def refusal (s : Nat) : Bool := s == 401 || s == 403 || s == 404 || s == 422

/-- Write leg (`flushOutbox`): counts unless the host answered a refusal. -/
def writeCounts : Option Nat → Bool
  | none => true
  | some s => !refusal s

/-- Recall leg (`remoteRecall`): 401/403/404/429 have their own branches, and
since C5 a 422 is a refusal that neither counts nor resets. -/
def recallCounts : Option Nat → Bool
  | none => true
  | some s => !(refusal s || s == 429)

theorem write_refusal_never_counts (s : Nat) (h : refusal s = true) : writeCounts (some s) = false := by
  simp [writeCounts, h]

theorem recall_refusal_never_counts (s : Nat) (h : refusal s = true) : recallCounts (some s) = false := by
  simp [recallCounts, h]

theorem network_and_5xx_count :
    writeCounts none = true ∧ writeCounts (some 503) = true ∧
    recallCounts none = true ∧ recallCounts (some 503) = true := by decide

/-! ## 8. needs_action entries (#1299)

An entry's local identity versus its retry bookkeeping. One flush of one
entry, branch for branch: `skip` (a needs_action entry inside its back-off
window, automatic flush) → untouched; otherwise the same path as a retrying
entry: policy demotion, success (hand-off), or failure (bookkeeping only). -/

structure Entry (β : Type) where
  scope  : String
  target : String
  body   : Nat
  book   : β

inductive Res (β : Type) where
  | kept (e : Entry β)
  | handedOff
  | demoted (e : Entry β)

/-- `offends` and `delivered` are oracles; `bump` is the bookkeeping update. -/
def flushEntry {β : Type} (bump : β → β) (skip offends delivered : Bool) (e : Entry β) : Res β :=
  if skip then .kept e
  else if offends then .demoted { e with scope := "local" }
  else if delivered then .handedOff
  else .kept { e with book := bump e.book }

theorem held_untouched {β} (bump : β → β) (o d : Bool) (e : Entry β) :
    flushEntry bump true o d e = .kept e := rfl

/-- A kept entry keeps scope, target and content: only bookkeeping changes.
Nothing is ever dropped or rescoped for being needs_action. -/
theorem kept_only_bookkeeping {β} (bump : β → β) (sk o d : Bool) (e e' : Entry β)
    (h : flushEntry bump sk o d e = .kept e') :
    e'.scope = e.scope ∧ e'.target = e.target ∧ e'.body = e.body := by
  unfold flushEntry at h
  split at h
  · cases h; exact ⟨rfl, rfl, rfl⟩
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h; exact ⟨rfl, rfl, rfl⟩

/-- `heldBack` in `_flushOutboxClaimed`: only an automatic flush, only inside
the window, only for needs_action. -/
def skipOf (force needsAction inWindow : Bool) : Bool := !force && needsAction && inWindow

theorem verdict_only_skips {β} (bump : β → β) (o d f w : Bool) (e : Entry β)
    (h : skipOf f true w = false) :
    flushEntry bump (skipOf f true w) o d e = flushEntry bump (skipOf f false w) o d e := by
  have : skipOf f false w = false := by cases f <;> cases w <;> simp_all [skipOf]
  rw [h, this]

theorem force_dials_needs_action (w : Bool) : skipOf true true w = false := by
  cases w <;> rfl

/-! ### 8b. The conflict hold (#1631; reviewed 2026-10-18)

`routeFor` now holds an entry whose target scope two servers claim
(`resolveScopeTarget(...).kind === 'conflict'`). It runs at selection, before
the `heldBack` verdict, and again before the push, ahead of the policy
re-scan; `force` reaches `heldBack` only, so the conflict hold binds the
explicit flush too. A held entry is not claimed and nothing is written. -/

def flushEntryC {β : Type} (bump : β → β) (force needsAction inWindow conflict offends delivered : Bool)
    (e : Entry β) : Res β :=
  if conflict then .kept e
  else flushEntry bump (skipOf force needsAction inWindow) offends delivered e

/-- A conflicted entry is untouched and never handed off, forced flush or not. -/
theorem conflict_untouched {β} (bump : β → β) (f n w o d : Bool) (e : Entry β) :
    flushEntryC bump f n w true o d e = .kept e := rfl

theorem conflict_never_delivered {β} (bump : β → β) (f n w o d : Bool) (e : Entry β) :
    ∀ e', flushEntryC bump f n w true o d e ≠ .handedOff ∧ flushEntryC bump f n w true o d e ≠ .demoted e' := by
  intro e'; simp [flushEntryC]

/-- §8 still holds with the new branch: a kept entry keeps scope, target and content. -/
theorem keptC_only_bookkeeping {β} (bump : β → β) (f n w c o d : Bool) (e e' : Entry β)
    (h : flushEntryC bump f n w c o d e = .kept e') :
    e'.scope = e.scope ∧ e'.target = e.target ∧ e'.body = e.body := by
  unfold flushEntryC at h
  split at h
  · cases h; exact ⟨rfl, rfl, rfl⟩
  · exact kept_only_bookkeeping bump _ o d e e' h

/-- Off conflicts the flush is the §8 flush, so `verdict_only_skips` and
`force_dials_needs_action` carry over. -/
theorem flushEntryC_off_conflict {β} (bump : β → β) (f n w o d : Bool) (e : Entry β) :
    flushEntryC bump f n w false o d e = flushEntry bump (skipOf f n w) o d e := rfl

/-- Non-vacuity: the forced flush still delivers an unconflicted needs_action entry. -/
theorem force_delivers_unconflicted {β} (bump : β → β) (w : Bool) (e : Entry β) :
    flushEntryC bump true true w false false true e = .handedOff := by
  cases w <;> rfl

/-! ### 8c. Credential changes and local destination takeover (2026-10-19)

Fingerprints are opaque naturals. Code records the credential captured for the
attempt, not one reloaded after the response. Unknown fingerprints preserve
the old backoff. A changed key changes retry eligibility only; it cannot bypass
current destination, conflict or content guards. A local path takeover is held
even on a forced flush; an authorized replacement remote remains deliverable.
-/

def credentialChanged (previous current : Option Nat) : Bool :=
  match previous, current with
  | some a, some b => a != b
  | _, _ => false

theorem previous_unknown (current : Option Nat) : credentialChanged none current = false := by cases current <;> rfl
theorem current_unknown (previous : Option Nat) : credentialChanged previous none = false := by cases previous <;> rfl
theorem unchanged_key (key : Nat) : credentialChanged (some key) (some key) = false := by simp [credentialChanged]

def skipWithCredential (force needsAction inWindow : Bool) (previous current : Option Nat) : Bool :=
  skipOf force needsAction inWindow && !credentialChanged previous current

theorem old_row_keeps_hold : skipWithCredential false true true none (some 2) = true := rfl
theorem changed_key_retries : skipWithCredential false true true (some 1) (some 2) = false := rfl
theorem same_key_keeps_hold (key : Nat) : skipWithCredential false true true (some key) (some key) = true := by
  simp [skipWithCredential, skipOf, credentialChanged]

def flushEntryCredential {β} (bump : β → β) (force needsAction inWindow localPath conflict offends delivered : Bool)
    (previous current : Option Nat) (e : Entry β) : Res β :=
  if localPath || conflict then .kept e
  else flushEntry bump (skipWithCredential force needsAction inWindow previous current) offends delivered e

theorem local_path_never_sent {β} (bump : β → β) (f n w c o d : Bool) (previous current : Option Nat) (e : Entry β) :
    flushEntryCredential bump f n w true c o d previous current e = .kept e := by simp [flushEntryCredential]

theorem conflict_still_held {β} (bump : β → β) (f n w l o d : Bool) (previous current : Option Nat) (e : Entry β) :
    flushEntryCredential bump f n w l true o d previous current e = .kept e := by simp [flushEntryCredential]

theorem replacement_remote_delivers {β} (bump : β → β) (e : Entry β) :
    flushEntryCredential bump false true true false false false true (some 1) (some 2) e = .handedOff := rfl

-- Before the new credential branch, the same repaired-key case stayed held.
example : skipOf false true true = true ∧ skipWithCredential false true true (some 1) (some 2) = false := by decide

/- A batch may await an earlier POST after selecting later rows. The admission
state is read again from disk immediately before each later POST. Selection
does not authorize an obsolete destination or credential. -/
structure AdmissionState where
  localPath : Bool
  credential : Option Nat

def flushSelected {β} (bump : β → β) (_selected current : AdmissionState)
    (previous : Option Nat) (e : Entry β) : Res β :=
  flushEntryCredential bump false true true current.localPath false false true previous current.credential e

theorem takeover_after_selection_is_held {β} (bump : β → β) (e : Entry β) :
    flushSelected bump ⟨false, some 2⟩ ⟨true, some 2⟩ (some 1) e = .kept e := rfl

theorem rejected_key_restored_after_selection_is_held {β} (bump : β → β) (e : Entry β) :
    flushSelected bump ⟨false, some 2⟩ ⟨false, some 1⟩ (some 1) e = .kept e := rfl

theorem unchanged_repaired_destination_delivers {β} (bump : β → β) (e : Entry β) :
    flushSelected bump ⟨false, some 2⟩ ⟨false, some 2⟩ (some 1) e = .handedOff := rfl

end PlurSpec.Outbox

/- 2026-10-19: Save destination reporting is a projection of the existing delivery
evidence. It changes no routing, persistence, scope authorization or outbox rule;
the model remains valid. Presentation invariants live in SaveDestination.lean. -/

/- 2026-10-19: serverSessionLines reads cached configuration and the existing
primary outbox projection. It does not probe, route, deliver or mutate memory.
These transition invariants still hold; status precedence is in SaveDestination. -/

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
