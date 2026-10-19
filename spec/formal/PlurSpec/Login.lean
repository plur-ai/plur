/-!
# PlurSpec.Login — `plur login <host>`: device sign-in and the one config write

Models of `packages/cli/src/commands/login.ts` (`pollForToken`,
`deviceSignIn`, `runSignIn`), `packages/cli/src/enterprise/legacy-login.ts`
and `packages/cli/src/enterprise/device-name.ts` (epic "enterprise first
install", plan C task 3, plur-ai/plur #1638), 2026-10-18; §4 models the
installer's store step, `packages/cli/src/enterprise/server-store.ts` (plan C
task 4), 2026-10-18. Findings, replays
and mutation checks: `spec/formal/findings/login.md`.

What is abstract: the config (`Cfg`, any type), registration (an oracle that
either returns the whole new config — one locked atomic write — or refuses),
the `/me` answer (a Bool: it named a user and org), and the time between
polls (`budget`: the polls left before the code expires). The HTTP shapes,
the key format check and the 429/slow_down arithmetic are folded into the
answer kinds below. Every theorem holds for all configs and oracles.

Left out: the device name and headless rules (`device-name.ts`, string
formatting only), printing, and how the owner-only backup copies are made
(core's `protectOwnerOnly`, modelled in Installer.lean); §3 only records
whether the copy of config.json exists.
-/

namespace PlurSpec.Login

/-! ## 1. The poll and the one write (`pollForToken`, `deviceSignIn`, `runSignIn`)

`Answer` is one `/api/v1/auth/token` answer. `ok v` is a `200` carrying a key;
`v` is `deviceSignIn`'s check (token_type Bearer, a `plur_sk_` key, the C3
fields). `busy` is a `429`, `transient` a network error or a `5xx`.
`poll` mirrors the loop: waiting answers continue, more than three transient
answers in a row refuse, every RFC error refuses, and the budget running out
is the code's expiry. A ctrl-C ends the run where it is: modelled as the
answer list ending there (`[]` reads as expiry: nothing more arrives). -/
namespace Poll

inductive Answer
  | ok (valid : Bool)
  | pending | slowDown
  | busy
  | transient
  | denied | expired | invalidGrant | otherError
  deriving DecidableEq, Repr

inductive Outcome | key | refused | timedOut
  deriving DecidableEq, Repr

/-- The answers after which the poll asks again. -/
def waiting : Answer → Bool
  | .pending | .slowDown | .busy | .transient => true
  | _ => false

/-- `pollForToken` then `deviceSignIn`'s check. `tr`: transient answers in a
row (a 429 neither counts nor resets them; any other answer resets). -/
def poll : Nat → Nat → List Answer → Outcome
  | 0, _, _ => .timedOut
  | _ + 1, _, [] => .timedOut
  | b + 1, tr, a :: as =>
    match a with
    | .ok v => if v then .key else .refused
    | .pending | .slowDown => poll b 0 as
    | .busy => poll b tr as
    | .transient => if tr + 1 > 3 then .refused else poll b (tr + 1) as
    | .denied | .expired | .invalidGrant | .otherError => .refused

variable {Cfg : Type}

/-- `runSignIn`: the configs written, in order. Only a checked key, a `/me`
that named the user (`meOk`), and a registration that did not refuse write;
registration is one write of the whole config. -/
def login (budget : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg) : List Cfg :=
  match poll budget 0 as with
  | .key => if meOk then (match register cfg with | some c => [c] | none => []) else []
  | _ => []

/-- The key is written at most once. -/
theorem at_most_one_write (b : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg) :
    (login b as meOk register cfg).length ≤ 1 := by
  unfold login
  cases poll b 0 as <;> simp
  cases meOk <;> simp
  cases register cfg <;> simp

/-- A key comes only from an `ok` answer that passed the check, after
waiting answers only. -/
theorem poll_key_after_ok (b tr : Nat) (as : List Answer) :
    poll b tr as = .key → ∃ pre rest, as = pre ++ .ok true :: rest ∧ ∀ a ∈ pre, waiting a = true := by
  induction b generalizing tr as with
  | zero => simp [poll]
  | succ b ih =>
    cases as with
    | nil => simp [poll]
    | cons a as =>
      cases a with
      | ok v =>
        intro h
        cases v
        · simp [poll] at h
        · exact ⟨[], as, rfl, by simp⟩
      | pending =>
        intro h; obtain ⟨pre, rest, h1, h2⟩ := ih 0 as (by simpa [poll] using h)
        exact ⟨.pending :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | slowDown =>
        intro h; obtain ⟨pre, rest, h1, h2⟩ := ih 0 as (by simpa [poll] using h)
        exact ⟨.slowDown :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | busy =>
        intro h; obtain ⟨pre, rest, h1, h2⟩ := ih tr as (by simpa [poll] using h)
        exact ⟨.busy :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | transient =>
        intro h
        by_cases ht : tr + 1 > 3
        · simp [poll, ht] at h
        · obtain ⟨pre, rest, h1, h2⟩ := ih (tr + 1) as (by simpa [poll, ht] using h)
          exact ⟨.transient :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | denied => simp [poll]
      | expired => simp [poll]
      | invalidGrant => simp [poll]
      | otherError => simp [poll]

/-- Config is written only after an `ok` token answer that passed the check. -/
theorem write_only_after_ok (b : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg) :
    login b as meOk register cfg ≠ [] →
      (∃ pre rest, as = pre ++ .ok true :: rest ∧ ∀ a ∈ pre, waiting a = true) ∧ meOk = true := by
  unfold login
  intro h
  cases hp : poll b 0 as <;> simp [hp] at h
  refine ⟨poll_key_after_ok b 0 as hp, ?_⟩
  cases meOk <;> simp_all

/-- The answers that end a run with a refusal: every RFC error, and a `200`
that failed the check. -/
def refusing : Answer → Bool
  | .denied | .expired | .invalidGrant | .otherError | .ok false => true
  | _ => false

/-- A refusing answer after waiting answers never yields a key. -/
theorem refusing_no_key (b tr : Nat) (pre rest : List Answer) (e : Answer)
    (hpre : ∀ a ∈ pre, waiting a = true) (he : refusing e = true) :
    poll b tr (pre ++ e :: rest) ≠ .key := by
  induction pre generalizing b tr with
  | nil =>
    cases b with
    | zero => simp [poll]
    | succ b =>
      cases e with
      | ok v => cases v <;> simp_all [refusing, poll]
      | _ => simp_all [refusing, poll]
  | cons a pre ih =>
    cases b with
    | zero => simp [poll]
    | succ b =>
      have ha : waiting a = true := hpre a (by simp)
      have hp : ∀ x ∈ pre, waiting x = true := fun x hx => hpre x (by simp [hx])
      cases a <;> simp [waiting] at ha
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b tr hp
      · by_cases ht : tr + 1 > 3
        · simp [poll, ht]
        · simpa [poll, ht] using ih b (tr + 1) hp

/-- Every RFC error (and an `ok` answer that fails the check) leaves the
config unchanged: nothing is written. -/
theorem rfc_error_no_write (b : Nat) (pre rest : List Answer) (e : Answer) (meOk : Bool)
    (register : Cfg → Option Cfg) (cfg : Cfg)
    (hpre : ∀ a ∈ pre, waiting a = true) (he : refusing e = true) :
    login b (pre ++ e :: rest) meOk register cfg = [] := by
  unfold login
  have := refusing_no_key b 0 pre rest e hpre he
  cases hp : poll b 0 (pre ++ e :: rest) <;> simp_all

/-- Waiting answers alone never yield a key. -/
theorem waiting_no_key (b tr : Nat) (pre : List Answer) (hpre : ∀ a ∈ pre, waiting a = true) :
    poll b tr pre ≠ .key := by
  induction pre generalizing b tr with
  | nil => cases b <;> simp [poll]
  | cons a pre ih =>
    cases b with
    | zero => simp [poll]
    | succ b =>
      have ha : waiting a = true := hpre a (by simp)
      have hp : ∀ x ∈ pre, waiting x = true := fun x hx => hpre x (by simp [hx])
      cases a <;> simp [waiting] at ha
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b tr hp
      · by_cases ht : tr + 1 > 3
        · simp [poll, ht]
        · simpa [poll, ht] using ih b (tr + 1) hp

/-- ctrl-C before the key arrives (the run ends after waiting answers only)
leaves the config unchanged. -/
theorem interrupt_no_write (b : Nat) (pre : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg)
    (hpre : ∀ a ∈ pre, waiting a = true) :
    login b pre meOk register cfg = [] := by
  unfold login
  have := waiting_no_key b 0 pre hpre
  cases hp : poll b 0 pre <;> simp_all

/-- Without a `/me` answer naming the user, nothing is written. -/
theorem no_write_without_me (b : Nat) (as : List Answer) (register : Cfg → Option Cfg) (cfg : Cfg) :
    login b as false register cfg = [] := by
  unfold login; cases poll b 0 as <;> simp

/-- A refused registration writes nothing. -/
theorem refused_registration_no_write (b : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg)
    (cfg : Cfg) (h : register cfg = none) : login b as meOk register cfg = [] := by
  unfold login; cases poll b 0 as <;> simp [h]

/-- Reachable: pending, slow_down, a 429, then the key — one write. -/
theorem write_reachable :
    login (Cfg := Nat) 5 [.pending, .slowDown, .busy, .ok true] true (fun c => some (c + 1)) 0 = [1] := by decide

/-- Three transient answers are waited out; a fourth in a row refuses. -/
theorem transient_bounded :
    poll 9 0 [.transient, .transient, .transient, .ok true] = .key ∧
    poll 9 0 [.transient, .transient, .transient, .transient, .ok true] = .refused := by decide

/-! ### Counterexample: the old flow (before #1638)

The gated code wrote `~/.plur/config.json` from any `200` that carried an
`access_token` (no token_type or key-format check), and it wrote even when
`/me` failed (username `(unknown)`, no scopes). -/

def oldPoll : Nat → List Answer → Bool
  | 0, _ => false
  | _ + 1, [] => false
  | b + 1, a :: as =>
    match a with
    | .ok _ => true
    | .pending | .slowDown | .busy | .transient => oldPoll b as
    | _ => false

def oldLogin (b : Nat) (as : List Answer) (_meOk : Bool) (write : Cfg → Cfg) (cfg : Cfg) : List Cfg :=
  if oldPoll b as then [write cfg] else []

/-- Counterexample (replayed: enterprise-device-login.test.ts, "a token_type
other than Bearer is refused" and "a key that is not a PLUR device key is
refused"): an `ok` answer that fails the check is written. -/
theorem old_writes_unchecked_key :
    oldLogin (Cfg := Nat) 1 [.ok false] true (· + 1) 0 = [1] ∧ login (Cfg := Nat) 1 [.ok false] true (fun c => some (c + 1)) 0 = [] := by
  decide

/-- Counterexample: the old flow wrote when `/me` named nobody, so no
personal scope could be set. -/
theorem old_writes_without_me :
    oldLogin (Cfg := Nat) 1 [.ok true] false (· + 1) 0 = [1] ∧ login (Cfg := Nat) 1 [.ok true] false (fun c => some (c + 1)) 0 = [] := by
  decide

end Poll

/-! ## 2. Removing the stale entry (`--remove-stale`; core `registerServerEntry`)

Registration names the entries that hold the personal scope (`holder`;
registration's own verdict — a path entry serving it exactly is not one, it
keeps the writes either way). Without `removeStale`, a holder refuses the
whole registration. With it, and when every holder can be removed, exactly the
holders are dropped before the server entry is written, in the same write.
The backup of config.yaml is taken under the same lock, from the file as
read (`beforeRemove`, gate of #1665); a backup that fails writes nothing. -/
namespace Stale

structure Entry where
  id : Nat
  serves : Bool    -- serves the personal scope (any spelling)
  holder : Bool    -- registration names it as holding the scope's writes
  deriving DecidableEq, Repr

/-- The entries registration keeps (then adds or updates the server entry),
or `none`: refused, nothing written. -/
def kept (removeStale removable : Bool) (es : List Entry) : Option (List Entry) :=
  if es.any (·.holder) then
    if removeStale && removable then some (es.filter (fun e => !e.holder)) else none
  else some es

/-- Without the flag nothing is ever removed. -/
theorem no_flag_no_removal (removable : Bool) (es ks : List Entry) :
    kept false removable es = some ks → ks = es := by
  unfold kept
  split <;> simp_all

/-- Only holders are removed: every other entry is kept. -/
theorem non_holders_kept (f r : Bool) (es ks : List Entry) (h : kept f r es = some ks) :
    ∀ e ∈ es, e.holder = false → e ∈ ks := by
  unfold kept at h
  intro e he hn
  split at h
  · split at h
    · simp at h; subst h; simp [List.mem_filter, he, hn]
    · simp at h
  · simp at h; subst h; exact he

/-- After a removal no holder is left, so the registration that follows does
not take over anyone's writes. -/
theorem no_holder_left (f r : Bool) (es ks : List Entry) (h : kept f r es = some ks) :
    ∀ e ∈ ks, e.holder = false := by
  unfold kept at h
  split at h
  · split at h
    · simp at h; subst h; intro e he; simp at he; simpa using he.2
    · simp at h
  · rename_i hany; simp at h; subst h; intro e he
    simp at hany
    cases hh : e.holder
    · rfl
    · exact absurd hh (by simpa using hany e he)

/-- Reachable: a holder is removed and the rest kept. -/
theorem removal_reachable :
    kept true true [⟨1, true, true⟩, ⟨2, false, false⟩] = some [⟨2, false, false⟩] := by decide

/-- Counterexample for removing by scope instead of by registration's verdict:
a path entry that serves the scope exactly (not a holder) would be deleted. -/
def byScope (es : List Entry) : List Entry := es.filter (fun e => !e.serves)

theorem byScope_drops_non_holder :
    (⟨1, true, false⟩ : Entry) ∉ byScope [⟨1, true, false⟩, ⟨2, true, true⟩] ∧
    (⟨1, true, false⟩ : Entry) ∈ (kept true true [⟨1, true, false⟩, ⟨2, true, true⟩]).getD [] := by decide

end Stale

/-! ## 3. The one-time `~/.plur/config.json` move (`legacy-login.ts`, owner decision O15)

Gate review of #1665, 2026-10-18. `held`: config.yaml already holds a sign-in
(any credential) to the file's server. `me`: the `/me` answer for the old key.
`register`: registration's result (`written` the whole new config, one
locked write; `takeover` refused because another entry holds the personal
scope; `failed` any other refusal). `copied`: the owner-only copy of the file
(core's `protectOwnerOnly`) was made. The result is the config written, if
any, and whether the file left its place. `held` is judged twice: before
`/me` (so the old key is not sent) and again by registration under the
config lock (`keepSignIn`), so a sign-in another process writes meanwhile
counts as held too; the model takes the value registration sees. -/
namespace Legacy

inductive Me | ok | rejected | unknown
  deriving DecidableEq, Repr

inductive Reg (Cfg : Type) | written (c : Cfg) | takeover | failed

variable {Cfg : Type}

def migrate (held : Bool) (me : Me) (register : Cfg → Reg Cfg) (copied : Bool) (cfg : Cfg) : Option Cfg × Bool :=
  if held then (none, copied)
  else match me with
    | .unknown => (none, false)
    | .rejected => (none, copied)
    | .ok => match register cfg with
      | .written c => (some c, copied)
      | .takeover => (none, copied)
      | .failed => (none, false)

/-- A sign-in config.yaml already holds for the server is never replaced by
the old key. -/
theorem held_never_replaced (me : Me) (register : Cfg → Reg Cfg) (copied : Bool) (cfg : Cfg) :
    (migrate true me register copied cfg).1 = none := by
  simp [migrate]

/-- The old key is written only after the server accepted it, and only when
config.yaml holds no sign-in to that server. -/
theorem written_only_after_ok (held : Bool) (me : Me) (register : Cfg → Reg Cfg) (copied : Bool) (cfg c : Cfg)
    (h : (migrate held me register copied cfg).1 = some c) : held = false ∧ me = .ok := by
  unfold migrate at h
  cases held <;> simp at h
  cases me <;> simp at h
  simp

/-- The file leaves its place only once its owner-only copy exists. -/
theorem moved_only_when_copied (held : Bool) (me : Me) (register : Cfg → Reg Cfg) (copied : Bool) (cfg : Cfg)
    (h : (migrate held me register copied cfg).2 = true) : copied = true := by
  unfold migrate at h
  split at h
  · exact h
  · split at h
    · simp at h
    · exact h
    · split at h <;> simp_all

/-- A server that cannot be reached keeps the file for the next run. -/
theorem unreachable_kept (register : Cfg → Reg Cfg) (copied : Bool) (cfg : Cfg) :
    migrate false .unknown register copied cfg = (none, false) := by
  simp [migrate]

/-- Reachable: an accepted key with no sign-in held is written and the file set aside. -/
theorem move_reachable :
    migrate (Cfg := Nat) false .ok (fun c => .written (c + 1)) true 0 = (some 1, true) := by decide

/-- Counterexample: the move as first built (no `held` check; the file was
moved even when the copy could not be protected) replaced config.yaml's newer
key with the old one (replayed: enterprise-device-login.test.ts, "a
config.json for a server config.yaml already signs in to"). -/
def oldMigrate (_held : Bool) (me : Me) (register : Cfg → Reg Cfg) (_copied : Bool) (cfg : Cfg) : Option Cfg × Bool :=
  match me with
  | .unknown => (none, false)
  | .rejected => (none, true)
  | .ok => match register cfg with
    | .written c => (some c, true)
    | .takeover => (none, true)
    | .failed => (none, false)

theorem old_replaces_held :
    (oldMigrate (Cfg := Nat) true .ok (fun c => .written (c + 1)) false 0) = (some 1, true) ∧
    (migrate (Cfg := Nat) true .ok (fun c => .written (c + 1)) false 0).1 = none := by decide

end Legacy

/-! ## 4. The installer's store step (`server-store.ts`, plan C task 4, 2026-10-18)

`checkExistingKey`, `connectServerStore` and `rollbackServerStore`
(`packages/cli/src/enterprise/server-store.ts`), as `plur-enterprise init`
drives them. `Existing` is `checkExistingKey`'s verdict: no server entry
(or no key in it), a key `/me` accepted, a key `/me` refused (401/403), or
no verdict (503, a network error, a timeout, two entries). `signedIn`: a
fresh device sign-in whose key passed the checks and whose `/me` named the
user (§1). `register` is core's `registerEnterpriseServer` (one locked
atomic write of the whole config, or a refusal that writes nothing — B5's
takeover refusal among them). `refresh` is `refreshServerScopes`: the config it
leaves (its own discovery write) and whether it returned (`true`) or threw. The backup is the config as it is
before registration — taken first, so a rollback restores exactly it. The
result is the outcome, the config left behind, the configs registration
wrote (each holds the key), and whether a sign-in was asked for (a new key
minted). Left out: another process writing config.yaml between the backup
and the rollback (the rollback would undo that write too; not modelled). -/
namespace Store

inductive Existing | none | works | rejected | unknown
  deriving DecidableEq, Repr

/-- `stored`: registered and the refresh returned (its discovery outcome may
itself say failed, auth_failed or not_synced: the key stays and the
installer's run decides, plan C task 10). `restoreFailed`: a failure after a
possible write whose rollback could not be written. -/
inductive Outcome | stored | refused | failed | restoreFailed | stopped
  deriving DecidableEq, Repr

/-- What core's `registerEnterpriseServer` does: a refusal (B5's takeover,
a held sign-in) that writes nothing; a throw after it may have written the
config `c` (a reload after the write, say: gate review 2026-10-18); or the
written config. -/
inductive Reg (Cfg : Type) | refused | threw (c : Cfg) | ok (c : Cfg)

variable {Cfg : Type}

/-- `connectServerStore`. `rollback c`: what `rollbackServerStore` does when
`c` is on disk — `none`, the backup is back and read back equal; `some c''`,
it threw and left `c''` (the write failed and `c` stays, or the write went
through and the read-back failed). -/
def connect (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    Outcome × Cfg × List Cfg :=
  let backup := cfg
  -- `w`: the config registration wrote; `c`: the config the failure left.
  let fail := fun (w c : Cfg) => match rollback c with
    | none => (Outcome.failed, backup, [w])
    | some c'' => (Outcome.restoreFailed, c'', [w])
  match register cfg with
  | .refused => (.refused, cfg, [])
  | .threw c => fail c c
  | .ok c => match refresh c with
    | (c', true) => (.stored, c', [c])
    | (c', false) => fail c c'

/-- The store step: `unknown` stops before any sign-in; a working key is
reused; otherwise a sign-in is asked for and its key stored. -/
def step (ex : Existing) (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool)
    (rollback : Cfg → Option Cfg) (cfg : Cfg) : Outcome × Cfg × List Cfg × Bool :=
  match ex with
  | .unknown => (.stopped, cfg, [], false)
  | .works => let r := connect register refresh rollback cfg; (r.1, r.2.1, r.2.2, false)
  | .none | .rejected =>
    if signedIn then let r := connect register refresh rollback cfg; (r.1, r.2.1, r.2.2, true)
    else (.stopped, cfg, [], true)

theorem connect_writes_le_one (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    (connect register refresh rollback cfg).2.2.length ≤ 1 := by
  unfold connect
  cases register cfg with
  | refused => simp
  | threw c => cases h' : rollback c <;> simp [h']
  | ok c => rcases h : refresh c with ⟨c', _ | _⟩ <;> cases h' : rollback c' <;> simp [h, h']

/-- Any outcome but `stored` and `restoreFailed` leaves the config exactly as
it was — a throw from registration after it wrote included. -/
theorem connect_failure_unchanged (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    (connect register refresh rollback cfg).1 ≠ .stored → (connect register refresh rollback cfg).1 ≠ .restoreFailed →
    (connect register refresh rollback cfg).2.1 = cfg := by
  unfold connect
  cases register cfg with
  | refused => simp
  | threw c => cases h' : rollback c <;> simp [h']
  | ok c => rcases h : refresh c with ⟨c', _ | _⟩ <;> cases h' : rollback c' <;> simp [h, h']

/-- `restoreFailed` happens only when the rollback threw (its write or its
read-back); with a working rollback every failure leaves the config unchanged. -/
theorem restore_failed_only_if_rollback_fails (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (cfg : Cfg) :
    (connect register refresh (fun _ => none) cfg).1 ≠ .restoreFailed := by
  unfold connect
  cases register cfg with
  | refused => simp
  | threw c => simp
  | ok c => rcases h : refresh c with ⟨c', _ | _⟩ <;> simp [h]

/-- The key is stored at most once per run. -/
theorem key_written_at_most_once (ex : Existing) (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool)
    (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    (step ex signedIn register refresh rollback cfg).2.2.1.length ≤ 1 := by
  unfold step
  cases ex <;> simp
  · cases signedIn <;> simp [connect_writes_le_one]
  · exact connect_writes_le_one register refresh rollback cfg
  · cases signedIn <;> simp [connect_writes_le_one]

/-- Review focus 1: a re-run while the server blips (no verdict on the stored
key) mints no key, writes nothing and leaves the config as it was. -/
theorem unknown_stops (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    step .unknown signedIn register refresh rollback cfg = (.stopped, cfg, [], false) := by
  simp [step]

/-- With a working rollback, a failure anywhere (no key, a refused
registration, a throw after the write) leaves the config byte-identical. -/
theorem failure_unchanged (ex : Existing) (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (cfg : Cfg) :
    (step ex signedIn register refresh (fun _ => none) cfg).1 ≠ .stored → (step ex signedIn register refresh (fun _ => none) cfg).2.1 = cfg := by
  unfold step
  have h := connect_failure_unchanged register refresh (fun _ => none) cfg
  have h2 := restore_failed_only_if_rollback_fails register refresh cfg
  cases ex <;> simp
  · cases signedIn <;> simp; intro hs; exact h hs h2
  · intro hs; exact h hs h2
  · cases signedIn <;> simp; intro hs; exact h hs h2

/-- A key is stored only when it is known to work: the stored key `/me`
accepted, or a fresh sign-in that passed §1's checks. -/
theorem stored_only_after_ok (ex : Existing) (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool)
    (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    (step ex signedIn register refresh rollback cfg).2.2.1 ≠ [] → ex = .works ∨ (ex ≠ .unknown ∧ signedIn = true) := by
  unfold step
  cases ex <;> cases signedIn <;> simp

/-- A working key is reused: no sign-in, no new key. -/
theorem works_no_mint (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (rollback : Cfg → Option Cfg) (cfg : Cfg) :
    (step .works signedIn register refresh rollback cfg).2.2.2 = false := by
  simp [step]

/-- Reachable: a revoked key, a fresh sign-in, one write, scopes fetched. -/
theorem stored_reachable :
    step (Cfg := Nat) .rejected true (fun c => .ok (c + 1)) (fun c => (c + 10, true)) (fun _ => none) 0 = (.stored, 11, [1], true) := by decide

/-- Reachable: the scope refresh throws after the key was written; the config
is back to what it was. -/
theorem rollback_reachable :
    step (Cfg := Nat) .works false (fun c => .ok (c + 1)) (fun c => (c, false)) (fun _ => none) 0 = (.failed, 0, [1], false) := by decide

/-- Reachable: registration throws after it wrote; the config is back to what
it was. -/
theorem register_throw_rolled_back :
    step (Cfg := Nat) .rejected true (fun c => .threw (c + 1)) (fun c => (c, true)) (fun _ => none) 0 = (.failed, 0, [1], true) := by decide

/-- Reachable: the refresh wrote discovered scopes and then threw, and the
rollback itself cannot be written; the outcome says so (the error names the
backup) and the config left is the refresh's, never `failed` with a changed
config. -/
theorem restore_failed_reachable :
    step (Cfg := Nat) .rejected true (fun c => .ok (c + 1)) (fun c => (c + 10, false)) (fun c => some c) 0 = (.restoreFailed, 11, [1], true) := by decide

/-- Reachable: the backup was written back but the read-back threw; the
outcome is `restoreFailed` (the error names the backup) while the config is
the backup again — the code says it could not confirm, never that it did. -/
theorem restore_unconfirmed_reachable :
    step (Cfg := Nat) .rejected true (fun c => .ok (c + 1)) (fun c => (c + 10, false)) (fun _ => some 0) 0 = (.restoreFailed, 0, [1], true) := by decide

/-! ### Counterexamples -/

/-- A store step that reads "no verdict" as "the key does not work" (the
plain reading of "reuse a working key"): a server blip mints a new key and
overwrites a key that may still work. -/
def naiveStep (ex : Existing) (signedIn : Bool) (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (cfg : Cfg) :
    Outcome × Cfg × List Cfg × Bool :=
  match ex with
  | .works => let r := connect register refresh (fun _ => none) cfg; (r.1, r.2.1, r.2.2, false)
  | _ => if signedIn then let r := connect register refresh (fun _ => none) cfg; (r.1, r.2.1, r.2.2, true)
         else (.stopped, cfg, [], true)

/-- Counterexample (replayed: enterprise-server-store.test.ts, "transient /me
failure keeps the key and stops" and "503 … → unknown"). -/
theorem naive_blip_overwrites :
    naiveStep (Cfg := Nat) .unknown true (fun c => .ok (c + 1)) (fun c => (c, true)) 0 = (.stored, 1, [1], true) ∧
    step (Cfg := Nat) .unknown true (fun c => .ok (c + 1)) (fun c => (c, true)) (fun _ => none) 0 = (.stopped, 0, [], false) := by decide

/-- A rollback to a copy taken after registration wrote (or no copy at all):
a failure after the write keeps the new key. -/
def lateBackupConnect (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (cfg : Cfg) : Outcome × Cfg × List Cfg :=
  match register cfg with
  | .refused => (.refused, cfg, [])
  | .threw c => (.failed, c, [c])
  | .ok c => match refresh c with
    | (c', true) => (.stored, c', [c])
    | (c', false) => (.failed, c', [c])

/-- Counterexample (replayed: "a failure after the key was written is rolled
back: config.yaml is byte-identical"). -/
theorem late_backup_keeps_key :
    (lateBackupConnect (Cfg := Nat) (fun c => .ok (c + 1)) (fun c => (c, false)) 0).2.1 = 1 ∧
    (connect (Cfg := Nat) (fun c => .ok (c + 1)) (fun c => (c, false)) (fun _ => none) 0).2.1 = 0 := by decide

/-- Every registration throw read as a refusal that wrote nothing (the code
before the gate review, 2026-10-18): a throw after the write keeps the new
key. -/
def throwAsRefusalConnect (register : Cfg → Reg Cfg) (refresh : Cfg → Cfg × Bool) (cfg : Cfg) : Outcome × Cfg × List Cfg :=
  match register cfg with
  | .refused => (.refused, cfg, [])
  | .threw c => (.refused, c, [c])
  | .ok c => match refresh c with
    | (c', true) => (.stored, c', [c])
    | (_, false) => (.failed, cfg, [c])

/-- Counterexample (replayed: "registration that throws after it wrote is
rolled back too: config.yaml is byte-identical"). -/
theorem throw_as_refusal_keeps_key :
    (throwAsRefusalConnect (Cfg := Nat) (fun c => .threw (c + 1)) (fun c => (c, true)) 0).2.1 = 1 ∧
    (connect (Cfg := Nat) (fun c => .threw (c + 1)) (fun c => (c, true)) (fun _ => none) 0).2.1 = 0 := by decide

end Store

end PlurSpec.Login

/-! 2026-10-19: rollbackServerStore accepts an optional expected-current byte
snapshot for the initializer's subprocess interval. Under the same config lock,
a mismatch refuses restoration instead of discarding another writer's change.
The existing immediate-connect rollback contract remains unchanged. The new
snapshot and uncertain-delivery rules are proved in EnterpriseInit. -/

/-! 2026-10-19: Installer legacy personal JWT conversion is explicitly opted in,
limited to one exact verified personal route on the same endpoint, and guarded
by a protected backup comparison under the existing config lock. Generic fold,
route resolution, discovery and outbox rules are unchanged. EnterpriseInit.Legacy
models its admission and refusal boundaries. Metadata is preserved through the
existing fold; queued idempotency keys are untouched. -/
